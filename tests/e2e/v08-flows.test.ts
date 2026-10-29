/**
 * v0.8 end-to-end: RBAC key detail.
 *   - rename a key for a bot reference
 *   - per-key activity with stats/filters
 *   - pause all access, pause a whole server grant, pause a single tool
 *   - verification that paused scopes are refused and resuming restores access
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createContainer, type GatewayContainer } from '../../src/container.js';
import type { GatewayConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';

const ECHO_FIXTURE = resolve('tests/fixtures/mcp-echo-server.mjs');
const MASTER_KEY = `mcp_master_${'d'.repeat(48)}`;
const VAULT_SECRET = 'v08-vault-secret-0123456789abcdefgh';
const rootDir = join(process.cwd(), '.test-data', `v08-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
let container: GatewayContainer | null = null;

function config(): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir: join(rootDir, 'data'),
    dbPath: join(rootDir, 'data', 'gateway.db'),
    uiDistDir: join(rootDir, 'ui'),
    vaultSecret: VAULT_SECRET,
    bootstrapMasterKey: MASTER_KEY,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: [],
    reposDir: join(rootDir, 'repos'),
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 15_000,
    keyPepper: null,
    publicBaseUrl: 'http://127.0.0.1',
  };
}

interface JsonResponse {
  status: number;
  body: any;
}

describe('v0.8 RBAC key detail', () => {
  let baseUrl: string;
  let serverId: string;
  let keyId: string;
  let agentKey: string;

  const admin = async (method: string, path: string, body?: unknown): Promise<JsonResponse> => {
    const response = await fetch(`${baseUrl}/mcp/v1/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${MASTER_KEY}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const callTool = async (name: string, args: Record<string, unknown> = {}): Promise<JsonResponse> => {
    const response = await fetch(`${baseUrl}/mcp/v1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'v08',
        method: 'tools/call',
        params: { name, serverId, arguments: args },
      }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const grant = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    serverId,
    tools: ['echo', 'add'],
    ...overrides,
  });

  afterAll(async () => {
    if (container) {
      const dataDir = container.config.dataDir;
      await container.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('creates a granted agent key and records its activity', async () => {
    mkdirSync(rootDir, { recursive: true });
    container = createContainer({ config: config(), logger: createLogger('e2e-v08', 'silent') });
    baseUrl = (await container.start()).url;

    const server = await admin('POST', '/servers', {
      name: 'echo',
      runtime: 'node',
      transport: 'stdio',
      command: process.execPath,
      args: [ECHO_FIXTURE],
      highPrivilegeTools: ['danger_delete'],
    });
    serverId = server.body.server.id;
    expect((await admin('POST', `/servers/${serverId}/start`)).status).toBe(200);

    const created = await admin('POST', '/keys/create', {
      name: 'untitled-bot',
      keyType: 'agent',
      serverGrants: [grant()],
      escalationAllowed: true,
    });
    keyId = created.body.key.id;
    agentKey = created.body.plaintext;
    expect(created.body.key.pausedAt).toBeNull();

    expect((await callTool('echo', { text: 'one' })).body.result).toBeDefined();
    expect((await callTool('add', { a: 1, b: 2 })).body.result).toBeDefined();
    expect((await callTool('echo', { text: 'two' })).body.result).toBeDefined();
  });

  it('renames the key and lists its activity with stats and filters', async () => {
    const renamed = await admin('PATCH', `/keys/${keyId}`, { name: 'echo-bot-alpha' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.key.name).toBe('echo-bot-alpha');

    const list = await admin('GET', '/keys');
    expect(list.body.keys.find((key: { id: string }) => key.id === keyId).name).toBe('echo-bot-alpha');

    const activity = await admin('GET', `/keys/${keyId}/activity?limit=2`);
    expect(activity.status).toBe(200);
    expect(activity.body.key.name).toBe('echo-bot-alpha');
    expect(activity.body.stats).toMatchObject({ total: 3, ok: 3, error: 0, denied: 0 });
    expect(activity.body.stats.lastUsedAt).toBeTruthy();
    expect(activity.body.stats.serverUsage).toEqual([expect.objectContaining({ serverId, name: 'echo', count: 3 })]);
    expect(activity.body.stats.toolUsage.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining(['echo', 'add']),
    );
    expect(activity.body.entries).toHaveLength(2);
    expect(activity.body.total).toBe(3);

    const addToolId = activity.body.stats.toolUsage.find((tool: { name: string }) => tool.name === 'add').toolId as string;
    const filtered = await admin('GET', `/keys/${keyId}/activity?status=ok&toolId=${encodeURIComponent(addToolId)}`);
    expect(filtered.body.total).toBe(1);

    const access = await admin('GET', `/keys/${keyId}/access`);
    expect(access.status).toBe(200);
    expect(access.body.grants).toHaveLength(1);
    expect(access.body.grants[0]).toMatchObject({
      serverId,
      serverName: 'echo',
      serverStatus: 'running',
      paused: false,
    });
    const echoTool = access.body.grants[0].tools.find((tool: { name: string }) => tool.name === 'echo');
    expect(echoTool).toMatchObject({ granted: true, paused: false, highPrivilege: false, available: true });
    const danger = access.body.grants[0].tools.find((tool: { name: string }) => tool.name === 'danger_delete');
    expect(danger).toMatchObject({ granted: false, highPrivilege: true });
  });

  it('pauses the whole key and resumes it', async () => {
    const paused = await admin('POST', `/keys/${keyId}/pause`);
    expect(paused.status).toBe(200);
    expect(paused.body.key.pausedAt).toBeTruthy();

    const refused = await callTool('echo', { text: 'blocked' });
    expect(refused.body.error?.code).toBe(-32001);
    expect(JSON.stringify(refused.body)).toContain('paused');

    const resumed = await admin('POST', `/keys/${keyId}/resume`);
    expect(resumed.body.key.pausedAt).toBeNull();
    expect((await callTool('echo', { text: 'again' })).body.result).toBeDefined();
  });

  it('pauses one server grant and one tool, then restores them', async () => {
    const serverPaused = await admin('PATCH', `/keys/${keyId}`, {
      serverGrants: [grant({ paused: true })],
    });
    expect(serverPaused.body.key.serverGrants[0].paused).toBe(true);
    const serverDenied = await callTool('echo', { text: 'server-paused' });
    expect(serverDenied.body.error?.code).toBe(-32001);

    // Discovery also hides a paused server grant.
    const listed = await fetch(`${baseUrl}/mcp/v1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'v08-list', method: 'tools/list', params: { serverId } }),
    }).then((response) => response.json() as Promise<any>);
    expect(listed.result.total).toBe(0);

    const toolPaused = await admin('PATCH', `/keys/${keyId}`, {
      serverGrants: [grant({ pausedTools: ['add'] })],
    });
    expect(toolPaused.body.key.serverGrants[0].pausedTools).toEqual(['add']);

    const addDenied = await callTool('add', { a: 1, b: 2 });
    expect(addDenied.body.error?.code).toBe(-32001);
    expect((await callTool('echo', { text: 'still allowed' })).body.result).toBeDefined();

    const access = await admin('GET', `/keys/${keyId}/access`);
    const addTool = access.body.grants[0].tools.find((tool: { name: string }) => tool.name === 'add');
    expect(addTool).toMatchObject({ granted: true, paused: true });
    const echoTool = access.body.grants[0].tools.find((tool: { name: string }) => tool.name === 'echo');
    expect(echoTool.paused).toBe(false);

    // Denied requests show up in the key's activity.
    const denied = await admin('GET', `/keys/${keyId}/activity?status=denied&limit=10`);
    expect(denied.body.total).toBeGreaterThanOrEqual(2);
    expect(denied.body.entries.every((entry: { status: string }) => entry.status === 'denied')).toBe(true);
    expect(JSON.stringify(denied.body.entries)).toContain('TOOL_PAUSED');

    await admin('PATCH', `/keys/${keyId}`, { serverGrants: [grant()] });
    expect((await callTool('add', { a: 2, b: 3 })).body.result).toBeDefined();
  });

  it('keeps activity/access privileged and validates inputs', async () => {
    const agentAccess = await fetch(`${baseUrl}/mcp/v1/admin/keys/${keyId}/access`, {
      headers: { authorization: `Bearer ${agentKey}` },
    });
    expect(agentAccess.status).toBe(403);

    const badName = await admin('PATCH', `/keys/${keyId}`, { name: '' });
    expect(badName.status).toBe(400);

    const unknown = await admin('GET', '/keys/key_missing/activity');
    expect(unknown.status).toBe(404);
  });
});
