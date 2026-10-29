/**
 * v0.8 end-to-end pause enforcement through the real gateway ingress:
 * paused keys are rejected at authentication, paused server grants / tools are
 * denied with the usual -32001 envelope (reason in `error.data.reason`), and the
 * denial is recorded in the audit log.
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
    `pause-routing-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  );
  mkdirSync(dataDir, { recursive: true });
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    dbPath: join(dataDir, 'gateway.db'),
    uiDistDir: join(dataDir, 'ui'),
    vaultSecret: 'pause-routing-vault-secret-0123456789',
    bootstrapMasterKey: `mcp_master_${'p'.repeat(48)}`,
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

describe('gateway pause enforcement', () => {
  let container: GatewayContainer;
  let baseUrl: string;
  let masterKey: string;
  let echoServer: ServerRecord;

  const rpc = async (key: string, method: string, params?: unknown): Promise<RpcResponse> => {
    const response = await fetch(`${baseUrl}/mcp/v1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  beforeAll(async () => {
    const config = buildConfig();
    container = createContainer({ config, logger: silent });
    baseUrl = (await container.start()).url;
    masterKey = config.bootstrapMasterKey as string;

    const response = await fetch(`${baseUrl}/mcp/v1/admin/servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${masterKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'echo-pause',
        runtime: 'node',
        transport: 'stdio',
        command: process.execPath,
        args: [ECHO_FIXTURE],
        highPrivilegeTools: ['danger_delete'],
      }),
    });
    const body = (await response.json()) as { server: ServerRecord };
    echoServer = body.server;

    // Discovery populates the tool registry; a running server also exercises the
    // real call path rather than the not-yet-discovered fallback.
    const started = await fetch(`${baseUrl}/mcp/v1/admin/servers/${echoServer.id}/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${masterKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(started.status).toBe(200);
  });

  afterAll(async () => {
    if (container) {
      const dataDir = container.config.dataDir;
      await container.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects calls on a paused server grant with SERVER_PAUSED (-32001)', async () => {
    const issued = container.services.keys.issue({
      name: 'server-paused',
      keyType: 'agent',
      serverGrants: [{ serverId: echoServer.id, paused: true }],
    });

    const result = await rpc(issued.plaintext, 'tools/call', { name: 'echo', arguments: { text: 'hi' } });
    expect(result.body.error?.code).toBe(-32001);
    expect(result.body.error?.data?.reason).toBe('SERVER_PAUSED');

    const audited = container.services.audit.query({ keyId: issued.key.id });
    expect(audited.total).toBeGreaterThanOrEqual(1);
    expect(audited.entries[0]).toMatchObject({ status: 'denied', errorCode: -32001 });
  });

  it('denies a paused tool while its siblings keep working', async () => {
    const issued = container.services.keys.issue({
      name: 'tool-paused',
      keyType: 'agent',
      serverGrants: [
        {
          serverId: echoServer.id,
          tools: null,
          highPrivilegeTools: ['danger_delete'],
          pausedTools: ['danger_delete'],
        },
      ],
    });

    const denied = await rpc(issued.plaintext, 'tools/call', {
      name: 'danger_delete',
      arguments: { target: 'x' },
    });
    expect(denied.body.error?.code).toBe(-32001);
    expect(denied.body.error?.data?.reason).toBe('TOOL_PAUSED');

    const allowed = await rpc(issued.plaintext, 'tools/call', {
      name: 'echo',
      arguments: { text: 'still works' },
    });
    expect(allowed.body.error).toBeUndefined();
    expect(allowed.body.result?.content?.[0]?.text).toBe('still works');

    const audited = container.services.audit.query({ keyId: issued.key.id, status: 'denied' });
    expect(audited.total).toBe(1);
    expect(audited.entries[0]).toMatchObject({ status: 'denied', errorCode: -32001 });
  });

  it('rejects a paused key at authentication, then works again after resume', async () => {
    const issued = container.services.keys.issue({
      name: 'key-paused',
      keyType: 'agent',
      serverGrants: [{ serverId: echoServer.id }],
    });
    container.services.keys.pause(issued.key.id);

    const paused = await rpc(issued.plaintext, 'tools/list');
    // The ingress maps every authentication failure to HTTP 401 (same as a revoked key).
    expect(paused.status).toBe(401);
    expect(paused.body.error?.code).toBe(-32001);
    expect(paused.body.error?.data?.reason).toBe('KEY_PAUSED');
    expect(paused.body.error?.message).toBe('This API key is paused. Resume it in the console.');

    container.services.keys.resume(issued.key.id);
    const resumed = await rpc(issued.plaintext, 'tools/list');
    expect(resumed.body.error).toBeUndefined();
    expect(resumed.body.result?.tools?.length).toBeGreaterThan(0);
  });
});
