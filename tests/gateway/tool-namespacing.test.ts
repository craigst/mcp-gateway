/**
 * v0.14.0 collision-safe tool names through the real gateway ingress.
 *
 * Two servers publish the same bare tool name. `tools/list` must expose both as
 * `<server>__<tool>`; calling the qualified name must route to that server; a
 * bare call with two visible candidates must fail loudly instead of silently
 * picking the first. A key that can see only one of them may still call bare.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContainer, type GatewayContainer } from '../../src/container.js';
import type { GatewayConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import type { ServerRecord } from '../../src/core/types.js';

const ECHO_FIXTURE = resolve('tests/fixtures/mcp-echo-server.mjs');
const silent = createLogger('test', 'silent');

function buildConfig(): GatewayConfig {
  const dataDir = join(
    process.cwd(),
    '.test-data',
    `tool-names-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  );
  mkdirSync(dataDir, { recursive: true });
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    dbPath: join(dataDir, 'gateway.db'),
    uiDistDir: join(dataDir, 'ui'),
    vaultSecret: 'tool-names-vault-secret-0123456789',
    bootstrapMasterKey: `mcp_master_${'n'.repeat(48)}`,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: [],
    reposDir: join(dataDir, 'repos'),
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 10_000,
    keyPepper: null,
    publicBaseUrl: 'http://127.0.0.1',
  };
}

interface RpcResponse {
  status: number;
  body: any;
}

describe('collision-safe tool names', () => {
  let container: GatewayContainer;
  let baseUrl: string;
  let masterKey: string;
  let serverA: ServerRecord;
  let serverB: ServerRecord;

  const rpc = async (key: string, method: string, params?: unknown): Promise<RpcResponse> => {
    const response = await fetch(`${baseUrl}/mcp/v1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const createServer = async (name: string): Promise<ServerRecord> => {
    const response = await fetch(`${baseUrl}/mcp/v1/admin/servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${masterKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        runtime: 'node',
        transport: 'stdio',
        command: process.execPath,
        args: [ECHO_FIXTURE],
      }),
    });
    const body = (await response.json()) as { server: ServerRecord };
    const started = await fetch(`${baseUrl}/mcp/v1/admin/servers/${body.server.id}/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${masterKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(started.status).toBe(200);
    return body.server;
  };

  beforeAll(async () => {
    const config = buildConfig();
    container = createContainer({ config, logger: silent });
    baseUrl = (await container.start()).url;
    masterKey = config.bootstrapMasterKey as string;
    serverA = await createServer('mail-a');
    serverB = await createServer('mail-b');
  });

  afterAll(async () => {
    if (container) {
      const dataDir = container.config.dataDir;
      await container.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('exposes duplicated names as <server>__<tool>', async () => {
    const issued = container.services.keys.issue({
      name: 'names-list',
      keyType: 'agent',
      serverGrants: [{ serverId: serverA.id }, { serverId: serverB.id }],
    });
    const listed = await rpc(issued.plaintext, 'tools/list');
    const names = listed.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('mail_a__echo');
    expect(names).toContain('mail_b__echo');
    expect(names).not.toContain('echo');

    const echo = listed.body.result.tools.find((tool: { name: string }) => tool.name === 'mail_a__echo');
    expect(echo.upstream_name).toBe('echo');
    expect(echo.server_id).toBe(serverA.id);
  });

  it('routes a qualified call to the right server', async () => {
    const issued = container.services.keys.issue({
      name: 'names-route',
      keyType: 'agent',
      serverGrants: [{ serverId: serverA.id }, { serverId: serverB.id }],
    });
    const called = await rpc(issued.plaintext, 'tools/call', {
      name: 'mail_b__echo',
      arguments: { text: 'to b' },
    });
    expect(called.body.error).toBeUndefined();
    expect(called.body.result.content[0].text).toBe('to b');
    expect(called.body.result._meta.server_id).toBe(serverB.id);
  });

  it('refuses a bare call when two visible servers share the name', async () => {
    const issued = container.services.keys.issue({
      name: 'names-ambiguous',
      keyType: 'agent',
      serverGrants: [{ serverId: serverA.id }, { serverId: serverB.id }],
    });
    const called = await rpc(issued.plaintext, 'tools/call', {
      name: 'echo',
      arguments: { text: 'who' },
    });
    expect(called.body.error?.code).toBe(-32602);
    expect(called.body.error?.message).toContain('ambiguous');
    expect(called.body.error?.data?.details?.candidates).toEqual(
      expect.arrayContaining(['mail_a__echo', 'mail_b__echo']),
    );
  });

  it('allows a bare call when only one of the shared names is granted', async () => {
    const issued = container.services.keys.issue({
      name: 'names-one-server',
      keyType: 'agent',
      serverGrants: [{ serverId: serverB.id }],
    });
    const called = await rpc(issued.plaintext, 'tools/call', {
      name: 'echo',
      arguments: { text: 'only b' },
    });
    expect(called.body.error).toBeUndefined();
    expect(called.body.result._meta.server_id).toBe(serverB.id);
  });

  it('still hides a server the key was not granted', async () => {
    const issued = container.services.keys.issue({
      name: 'names-denied',
      keyType: 'agent',
      serverGrants: [{ serverId: serverA.id }],
    });
    const called = await rpc(issued.plaintext, 'tools/call', {
      name: 'mail_b__echo',
      arguments: { text: 'nope' },
    });
    expect(called.body.error?.code).toBe(-32002);
  });
});
