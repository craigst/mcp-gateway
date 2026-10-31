import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createContainer, type GatewayContainer } from '../../src/container.js';
import type { GatewayConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import type { ServerRecord } from '../../src/core/types.js';

const ECHO_FIXTURE = resolve('tests/fixtures/mcp-echo-server.mjs');

interface RpcResult {
  status: number;
  body: any;
}

function buildConfig(): GatewayConfig {
  const dataDir = join(process.cwd(), '.test-data', `integration-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dataDir, { recursive: true });
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    dbPath: join(dataDir, 'gateway.db'),
    uiDistDir: join(dataDir, 'ui'),
    vaultSecret: 'integration-vault-secret-0123456789abcdef',
    bootstrapMasterKey: `mcp_master_${'i'.repeat(48)}`,
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

describe('gateway integration (live HTTP + stdio sub-server)', () => {
  let container: GatewayContainer;
  let baseUrl: string;
  let masterKey: string;
  let echoServer: ServerRecord;
  let otherServer: ServerRecord;
  let agentKey: string;
  let restrictedKey: string;
  let guardrailKey: string;
  let echoOnlyKey: string;

  const rpc = async (key: string, method: string, params?: unknown, id: number | string = 1): Promise<RpcResult> => {
    const response = await fetch(`${baseUrl}/mcp/v1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const admin = async (method: string, path: string, body?: unknown): Promise<RpcResult> => {
    const response = await fetch(`${baseUrl}/mcp/v1/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${masterKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  beforeAll(async () => {
    const config = buildConfig();
    container = createContainer({ config, logger: createLogger('test', 'silent') });
    const address = await container.start();
    baseUrl = address.url;
    masterKey = config.bootstrapMasterKey as string;

    // Register and start the fixture MCP server.
    const registered = await admin('POST', '/servers', {
      name: 'echo',
      runtime: 'node',
      transport: 'stdio',
      command: process.execPath,
      args: [ECHO_FIXTURE],
      env: { ECHO_SERVER_STDERR: '1' },
      highPrivilegeTools: ['danger_delete'],
    });
    expect(registered.status).toBe(201);
    echoServer = registered.body.server as ServerRecord;

    const started = await admin('POST', `/servers/${echoServer.id}/start`);
    expect(started.status).toBe(200);
    expect(started.body.server.status).toBe('running');

    // A second server used to prove cross-server isolation.
    const other = await admin('POST', '/servers', {
      name: 'echo-two',
      runtime: 'node',
      transport: 'stdio',
      command: process.execPath,
      args: [ECHO_FIXTURE],
      highPrivilegeTools: ['danger_delete'],
    });
    otherServer = other.body.server as ServerRecord;
    expect((await admin('POST', `/servers/${otherServer.id}/start`)).status).toBe(200);

    restrictedKey = (
      await admin('POST', '/keys/create', {
        name: 'restricted-agent',
        keyType: 'agent',
        serverGrants: [{ serverId: echoServer.id, tools: ['echo'] }],
      })
    ).body.plaintext as string;

    const noHighPriv = {
      serverId: echoServer.id,
      tools: ['echo', 'add', 'fail'],
      highPrivilegeTools: [],
    };

    agentKey = (
      await admin('POST', '/keys/create', {
        name: 'sales-agent',
        keyType: 'agent',
        serverGrants: [noHighPriv],
        delegationAllowed: false,
        escalationAllowed: true,
      })
    ).body.plaintext as string;

    echoOnlyKey = (
      await admin('POST', '/keys/create', {
        name: 'echo-only',
        keyType: 'agent',
        serverGrants: [{ serverId: echoServer.id, tools: ['echo'] }],
      })
    ).body.plaintext as string;

    guardrailKey = (
      await admin('POST', '/keys/create', {
        name: 'guardrailed',
        keyType: 'agent',
        serverGrants: [
          {
            serverId: echoServer.id,
            tools: ['echo'],
            guardrails: [
              { kind: 'regex_applied_to_arguments', pattern: 'DROP|UPDATE|DELETE', flags: 'i', mustMatch: false },
            ],
          },
        ],
        escalationAllowed: true,
      })
    ).body.plaintext as string;
  });

  afterAll(async () => {
    if (container) {
      const dataDir = container.config.dataDir;
      await container.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('exposes an unauthenticated health endpoint', async () => {
    const response = await fetch(`${baseUrl}/mcp/v1/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; version: string };
    expect(body.status).toBe('ok');
    expect(body.version).toBe('0.12.0');
  });

  it('rejects requests without a key (HTTP 401)', async () => {
    const response = await fetch(`${baseUrl}/mcp/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });

  it('performs the MCP handshake and returns gateway metadata', async () => {
    const { body } = await rpc(masterKey, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-agent', version: '1.0.0' },
    });
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.serverInfo.name).toBe('mcp-gateway');
    expect(body.result._meta.gateway.key_type).toBe('master');
    expect(body.result.capabilities.tools.listChanged).toBe(true);
  });

  it('master key sees the complete catalog including high-privilege tools', async () => {
    const { body } = await rpc(masterKey, 'tools/list');
    const names = (body.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(body.result.total).toBeGreaterThanOrEqual(5);
    expect(names).toEqual(expect.arrayContaining(['echo', 'add', 'danger_delete', 'fail', 'slow']));
  });

  it('masks high-privilege and ungranted tools from an agent key', async () => {
    const { body } = await rpc(agentKey, 'tools/list');
    const names = (body.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names.sort()).toEqual(['add', 'echo', 'fail']);
    expect(names).not.toContain('danger_delete');
    expect(names).not.toContain('slow');
  });

  it('censors search results before ranking', async () => {
    const { body } = await rpc(agentKey, 'tools/search', { query: 'delete high privilege', limit: 10 });
    expect(body.result.total).toBe(0);
    expect(body.result.censored).toBe(true);

    const echo = await rpc(agentKey, 'tools/search', { query: 'echo text', limit: 10 });
    expect(echo.body.result.total).toBe(1);
    expect(echo.body.result.tools[0].name).toBe('echo');
  });

  it('returns zero-trust server menu', async () => {
    const masterMenu = await rpc(masterKey, 'servers/list_permitted');
    expect(masterMenu.body.result.servers.map((server: { id: string }) => server.id)).toContain(echoServer.id);

    const agentMenu = await rpc(echoOnlyKey, 'servers/list_permitted');
    const server = agentMenu.body.result.servers.find((entry: { id: string }) => entry.id === echoServer.id);
    expect(server.tool_count).toBe(1);
  });

  it('executes a granted tool through the stdio transport', async () => {
    const { body } = await rpc(agentKey, 'tools/call', { name: 'echo', arguments: { text: 'hello gateway' } });
    expect(body.result.content[0]).toEqual({ type: 'text', text: 'hello gateway' });
    expect(body.result._meta.server_id).toBe(echoServer.id);
    expect(body.result._meta.sub_server_ms).toBeGreaterThanOrEqual(0);
  });

  it('denies a high-privilege tool with a structured escalation ticket', async () => {
    const { body } = await rpc(agentKey, 'tools/call', { name: 'danger_delete', arguments: { target: 'prod' } });
    expect(body.error.code).toBe(-32001);
    expect(body.error.data.status).toBe('FORBIDDEN');
    expect(body.error.data.reason).toBe('HIGH_PRIVILEGE_RESTRICTION');
    expect(body.error.data.escalation_supported).toBe(true);
    expect(body.error.data.ticket_id).toMatch(/^esc-\d{8}-[0-9a-f]{4}$/);
  });

  it('hides unknown and ungranted tools behind a generic Tool Not Found', async () => {
    const unknown = await rpc(agentKey, 'tools/call', { name: 'does_not_exist', arguments: {} });
    expect(unknown.body.error.code).toBe(-32002);
    expect(unknown.body.error.message).toBe('Tool Not Found');

    const notGranted = await rpc(echoOnlyKey, 'tools/call', { name: 'add', arguments: { a: 1, b: 2 } });
    expect(notGranted.body.error.code).toBe(-32002);
    expect(notGranted.body.error.message).toBe('Tool Not Found');
  });

  it('does not leak high-privilege tools from unpermitted servers', async () => {
    const denied = await rpc(restrictedKey, 'tools/call', {
      name: 'danger_delete',
      arguments: { target: 'other' },
      serverId: otherServer.id,
    });
    // Indistinguishable from an unknown tool: no server/tool existence leak.
    expect(denied.body.error.code).toBe(-32002);
    expect(denied.body.error.message).toBe('Tool Not Found');
  });

  it('enforces argument guardrails', async () => {
    const blocked = await rpc(guardrailKey, 'tools/call', {
      name: 'echo',
      arguments: { text: 'please DROP table users' },
    });
    expect(blocked.body.error.code).toBe(-32001);
    expect(blocked.body.error.data.reason).toBe('GUARDRAIL_VIOLATION');

    const allowed = await rpc(guardrailKey, 'tools/call', { name: 'echo', arguments: { text: 'safe text' } });
    expect(allowed.body.result.content[0].text).toBe('safe text');
  });

  it('propagates upstream tool errors without leaking gateway internals', async () => {
    const { body } = await rpc(agentKey, 'tools/call', { name: 'fail', arguments: {} });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe('intentional failure');
  });

  it('supports JSON-RPC batching', async () => {
    const response = await fetch(`${baseUrl}/mcp/v1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentKey}`, 'content-type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 'a', method: 'ping' },
        { jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: 'add', arguments: { a: 2, b: 3 } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      ]),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ id: string; result?: any }>;
    expect(body).toHaveLength(2);
    expect(body[0]?.id).toBe('a');
    expect(body[1]?.result.content[0].text).toBe('5');
  });

  it('revokes a key instantly', async () => {
    const created = await admin('POST', '/keys/create', {
      name: 'revoked-agent',
      keyType: 'agent',
      serverGrants: [{ serverId: echoServer.id, tools: ['echo'] }],
    });
    const key = created.body.key as { id: string };
    const plaintext = created.body.plaintext as string;

    expect((await rpc(plaintext, 'tools/list')).body.result).toBeTruthy();

    const revoked = await admin('POST', `/keys/${key.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.key.revokedAt).not.toBeNull();

    const response = await fetch(`${baseUrl}/mcp/v1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });

  it('records audit entries for allowed and denied calls', async () => {
    const { body } = await admin('GET', `/audit?keyId=&limit=100`);
    expect(body.total).toBeGreaterThan(0);
    const denied = (body.entries as Array<{ status: string; errorCode: number | null }>).find(
      (entry) => entry.status === 'denied',
    );
    expect(denied).toBeDefined();
    expect(denied?.errorCode).toBe(-32001);
  });

  it('lists and resolves escalation tickets', async () => {
    const pending = await admin('GET', '/escalations?status=pending');
    expect(pending.body.escalations.length).toBeGreaterThan(0);
    const ticket = pending.body.escalations[0] as { ticketId: string };

    const resolved = await admin('POST', `/escalations/${ticket.ticketId}/resolve`, {
      status: 'approved',
      note: 'approved in test',
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.escalation.status).toBe('approved');
  });

  it('returns dashboard metrics', async () => {
    const response = await fetch(`${baseUrl}/mcp/v1/metrics`, { headers: { authorization: `Bearer ${masterKey}` } });
    expect(response.status).toBe(200);
    const metrics = (await response.json()) as any;
    expect(metrics.requests.total).toBeGreaterThan(0);
    expect(metrics.servers.total).toBeGreaterThanOrEqual(1);
    expect(metrics.process.rssBytes).toBeGreaterThan(0);
  });

  it('stores, lists and resolves vault secrets without exposing values', async () => {
    const stored = await admin('PUT', '/vault/secrets/TEST_API_TOKEN', { value: 'super-secret-token' });
    expect(stored.status).toBe(200);
    expect(JSON.stringify(stored.body)).not.toContain('super-secret-token');

    const listed = await admin('GET', '/vault/secrets');
    expect(listed.body.enabled).toBe(true);
    expect(listed.body.secrets[0]).toEqual(expect.objectContaining({ name: 'TEST_API_TOKEN' }));
    expect(JSON.stringify(listed.body)).not.toContain('super-secret-token');
    expect(container.services.vault.getSecret('TEST_API_TOKEN')).toBe('super-secret-token');
  });

  it('serves a UI fallback page when the bundle is absent', async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('MCP Gateway is running');
  });
});
