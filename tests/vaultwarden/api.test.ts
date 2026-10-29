import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteApprovalService } from '../../src/approvals/service.js';
import { VaultwardenApi } from '../../src/admin/vaultwarden-api.js';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';
import { openDatabase } from '../../src/core/db.js';
import { newId, nowIso } from '../../src/core/ids.js';
import { createLogger } from '../../src/core/logger.js';
import { SqliteAuditService } from '../../src/gateway/audit.js';
import { DefaultSupervisor } from '../../src/gateway/supervisor.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';
import type { GatewayConfig } from '../../src/core/config.js';
import type { CatalogService } from '../../src/core/ports.js';
import type { AuthenticatedKey, JsonSchema, ServerRecord, ToolDescriptor } from '../../src/core/types.js';

const VAULTWARDEN_FIXTURE = resolve('tests/fixtures/vaultwarden-fake-server.mjs');
const BASE = 'http://127.0.0.1/mcp/v1/admin/vaultwarden';
const PROTECT = `${BASE}/protect`;

function buildConfig(): GatewayConfig {
  const dataDir = join(process.cwd(), '.test-data', `warden-api-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dataDir, { recursive: true });
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    dbPath: join(dataDir, 'gateway.db'),
    uiDistDir: join(dataDir, 'ui'),
    vaultSecret: null,
    bootstrapMasterKey: null,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: [],
    reposDir: join(dataDir, 'repos'),
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 5_000,
    keyPepper: null,
    publicBaseUrl: 'http://127.0.0.1',
  };
}

function toolDescriptor(serverId: string, name: string, highPrivilege = false): ToolDescriptor {
  const inputSchema: JsonSchema = { type: 'object' };
  return {
    id: `${serverId}:${name}`,
    name,
    description: `${name} description`,
    serverId,
    inputSchema,
    highPrivilege,
    tags: [],
  };
}

function serverRecord(overrides: Partial<ServerRecord> = {}): ServerRecord {
  const now = nowIso();
  return {
    id: newId('srv'),
    name: 'vaultwarden',
    runtime: 'node',
    transport: 'stdio',
    status: 'running',
    command: process.execPath,
    args: [VAULTWARDEN_FIXTURE],
    url: null,
    env: {},
    manifest: null,
    highPrivilegeTools: [],
    delegationSupported: false,
    sourceUrl: 'https://github.com/example/vaultwarden-mcp',
    workDir: null,
    envFile: null,
    approvalRequiredTools: [],
    lastError: null,
    pid: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface FakeResponse extends ServerResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
}

function fakeRequest(method: string, headers: Record<string, string>, payload?: unknown): IncomingMessage {
  const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))];
  return Object.assign(Readable.from(chunks), {
    method,
    headers,
    url: '/mcp/v1/admin/vaultwarden',
  }) as unknown as IncomingMessage;
}

function fakeResponse(): FakeResponse {
  const res: Partial<FakeResponse> = {
    statusCode: 0,
    body: '',
    headers: {},
  };
  res.writeHead = ((status: number, headers?: Record<string, string>) => {
    res.statusCode = status;
    res.headers = headers ?? {};
    return res;
  }) as FakeResponse['writeHead'];
  res.end = ((chunk?: unknown) => {
    res.body = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
    return res;
  }) as FakeResponse['end'];
  return res as FakeResponse;
}

interface ApiResponse {
  matched: boolean;
  status: number;
  json: Record<string, unknown> | null;
}

async function callApi(
  api: VaultwardenApi,
  options: { method?: string; key?: string | null; payload?: unknown; path?: string } = {},
): Promise<ApiResponse> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.key) headers.authorization = `Bearer ${options.key}`;
  const req = fakeRequest(method, headers, options.payload);
  const res = fakeResponse();
  const matched = await api.handle(req, res, new URL(options.path ?? BASE, 'http://127.0.0.1'));
  const json = res.body ? (JSON.parse(res.body) as Record<string, unknown>) : null;
  return { matched, status: res.statusCode, json };
}

describe('VaultwardenApi', () => {
  let config: GatewayConfig;
  let db: DatabaseSync;
  let repository: SqliteCatalogRepository;
  let supervisor: DefaultSupervisor;
  let audit: SqliteAuditService;
  let approvals: SqliteApprovalService;
  let api: VaultwardenApi;
  let masterKey: string;
  let agentKey: AuthenticatedKey;
  let agentKeyPlaintext: string;

  beforeEach(() => {
    config = buildConfig();
    db = openDatabase(config.dbPath);
    repository = new SqliteCatalogRepository(db);
    supervisor = new DefaultSupervisor({ repository, config, logger: createLogger('warden-api-test', 'silent') });
    audit = new SqliteAuditService(db);
    approvals = new SqliteApprovalService({
      db,
      repository,
      supervisor,
      logger: createLogger('warden-api-test', 'silent'),
      timeoutMs: 5_000,
    });

    const keys = new SqliteKeyService(db, { logger: createLogger('warden-api-test', 'silent') });
    masterKey = keys.issue({ name: 'ui-master', keyType: 'master' }).plaintext;
    const issuedAgent = keys.issue({ name: 'vault-agent', keyType: 'agent' });
    agentKey = issuedAgent.key;
    agentKeyPlaintext = issuedAgent.plaintext;

    api = new VaultwardenApi({
      config,
      keys,
      catalog: { repository } as unknown as CatalogService,
      audit,
      db,
      logger: createLogger('warden-api-test', 'silent'),
    });
  });

  afterEach(async () => {
    await supervisor.shutdown();
    db.close();
    rmSync(config.dataDir, { recursive: true, force: true });
  });

  function seedProtectedServer(overrides: Partial<ServerRecord> = {}): ServerRecord {
    const server = serverRecord(overrides);
    repository.upsertServer(server);
    repository.upsertTools(server.id, [
      toolDescriptor(server.id, 'vault_status'),
      toolDescriptor(server.id, 'vault_list_local_ui'),
      toolDescriptor(server.id, 'vault_get_metadata'),
      toolDescriptor(server.id, 'vault_deliver_credential', true),
      toolDescriptor(server.id, 'vault_create_api_key', true),
      toolDescriptor(server.id, 'vault_rotate_webui_login'),
    ]);
    return server;
  }

  function createApproval(serverId: string, toolName: string, args: Record<string, unknown> = {}): string {
    return approvals.createToolApproval({
      key: agentKey,
      serverId,
      toolId: `${serverId}:${toolName}`,
      toolName,
      arguments: args,
      requestId: 'req_warden_test',
    }).ticketId;
  }

  describe('GET /mcp/v1/admin/vaultwarden', () => {
    it('reports installed:false with the known defaults when no Vaultwarden server exists', async () => {
      const response = await callApi(api, { key: masterKey });
      expect(response.matched).toBe(true);
      expect(response.status).toBe(200);
      expect(response.json).toMatchObject({
        installed: false,
        pendingApprovals: [],
        accessLog: [],
      });
      const defaults = response.json?.defaults as { approvalTools: string[]; highPrivilegeTools: string[] };
      expect(defaults.approvalTools).toContain('vault_deliver_credential');
      expect(defaults.approvalTools).toContain('vault_rotate_webui_login');
      expect(defaults.highPrivilegeTools).toEqual(defaults.approvalTools);
    });

    it('requires a master key', async () => {
      await expect(callApi(api, { key: null })).rejects.toMatchObject({ httpStatus: 401 });
      await expect(callApi(api, { key: 'mcp_master_invalid' })).rejects.toMatchObject({ httpStatus: 401 });
      await expect(callApi(api, { key: agentKeyPlaintext })).rejects.toMatchObject({ httpStatus: 403 });
    });

    it('returns tools, defaults, pending approvals and a filtered vault access log after an approval flow', async () => {
      const server = seedProtectedServer({
        highPrivilegeTools: ['vault_deliver_credential', 'vault_create_api_key'],
        approvalRequiredTools: ['vault_deliver_credential', 'vault_rotate_webui_login'],
      });

      // Simulate a completed approval: the stored call executes exactly once.
      const approvedTicket = createApproval(server.id, 'vault_deliver_credential', {
        item: 'fixture',
        dir: join(config.dataDir, 'delivered'),
      });
      const executed = await approvals.approveAndExecute(approvedTicket, 'supervisor');
      expect((executed.result as { isError?: boolean }).isError).toBeFalsy();

      // A second delivery is still waiting for a human.
      const pendingTicket = createApproval(server.id, 'vault_deliver_credential', { item: 'fixture-2' });

      // Access log: vault call (visible), non-vault call and non tools/call method (hidden),
      // plus a call for another server (hidden by the server filter).
      audit.record({
        requestId: 'req_vault',
        keyId: agentKey.id,
        method: 'tools/call',
        serverId: server.id,
        toolId: `${server.id}:vault_deliver_credential`,
        status: 'ok',
        latencyMs: 11,
      });
      audit.record({
        requestId: 'req_echo',
        keyId: agentKey.id,
        method: 'tools/call',
        serverId: server.id,
        toolId: `${server.id}:echo`,
        status: 'ok',
        latencyMs: 3,
      });
      audit.record({
        requestId: 'req_list',
        keyId: agentKey.id,
        method: 'tools/list',
        serverId: server.id,
        toolId: `${server.id}:vault_status`,
        status: 'ok',
        latencyMs: 1,
      });

      const response = await callApi(api, { key: masterKey });
      expect(response.status).toBe(200);
      expect(response.json?.installed).toBe(true);
      expect(response.json?.serverId).toBe(server.id);
      expect(response.json?.serverName).toBe('vaultwarden');
      expect(response.json?.status).toBe('running');

      const tools = response.json?.tools as Array<{ name: string; highPrivilege: boolean; approvalRequired: boolean }>;
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['vault_status', 'vault_get_metadata', 'vault_deliver_credential']),
      );
      const deliver = tools.find((tool) => tool.name === 'vault_deliver_credential');
      expect(deliver).toMatchObject({ highPrivilege: true, approvalRequired: true });
      const status = tools.find((tool) => tool.name === 'vault_status');
      expect(status).toMatchObject({ highPrivilege: false, approvalRequired: false });

      const defaults = response.json?.defaults as { approvalTools: string[]; highPrivilegeTools: string[] };
      expect(defaults.approvalTools).toEqual(
        expect.arrayContaining(['vault_deliver_credential', 'vault_create_api_key', 'vault_rotate_webui_login']),
      );
      expect(defaults.approvalTools).not.toContain('vault_status');
      expect(defaults.approvalTools).not.toContain('vault_list_local_ui');
      expect(defaults.approvalTools).not.toContain('vault_get_metadata');

      const pending = response.json?.pendingApprovals as Array<{ ticketId: string; ticketType: string; status: string }>;
      expect(pending.map((ticket) => ticket.ticketId)).toContain(pendingTicket);
      expect(pending.map((ticket) => ticket.ticketId)).not.toContain(approvedTicket);
      expect(pending[0]?.ticketType).toBe('tool_approval');

      const accessLog = response.json?.accessLog as Array<{ method: string; toolId: string | null }>;
      expect(accessLog).toHaveLength(1);
      expect(accessLog[0]?.toolId).toBe(`${server.id}:vault_deliver_credential`);
    });

    it('detects the server from the manifest name / source url', async () => {
      const server = serverRecord({
        name: 'vault-bridge',
        manifest: { name: 'vaultwarden-mcp', version: '1.0.0', runtime: 'node' },
      });
      repository.upsertServer(server);
      const response = await callApi(api, { key: masterKey });
      expect(response.json?.installed).toBe(true);
      expect(response.json?.serverId).toBe(server.id);
    });

    it('returns false for unknown paths and 405 for the wrong method on a known path', async () => {
      const unmatched = await callApi(api, { key: masterKey, path: `${BASE}/something-else` });
      expect(unmatched.matched).toBe(false);

      await expect(callApi(api, { key: masterKey, method: 'POST' })).rejects.toMatchObject({ httpStatus: 405 });
    });
  });

  describe('POST /mcp/v1/admin/vaultwarden/protect', () => {
    it('applies the default protection sets to the server', async () => {
      const server = seedProtectedServer({ status: 'stopped' });

      const response = await callApi(api, {
        method: 'POST',
        key: masterKey,
        payload: { serverId: server.id },
        path: PROTECT,
      });
      expect(response.matched).toBe(true);
      expect(response.status).toBe(200);

      const protectedTools = response.json?.protectedTools as string[];
      expect(protectedTools).toEqual(
        expect.arrayContaining(['vault_deliver_credential', 'vault_create_api_key', 'vault_rotate_webui_login']),
      );
      expect(protectedTools).not.toContain('vault_status');
      expect(protectedTools).not.toContain('vault_list_local_ui');
      expect(protectedTools).not.toContain('vault_get_metadata');

      const stored = repository.getServer(server.id);
      expect(stored?.approvalRequiredTools).toEqual(
        expect.arrayContaining(['vault_deliver_credential', 'vault_create_api_key', 'vault_rotate_webui_login']),
      );
      expect(stored?.highPrivilegeTools).toEqual(expect.arrayContaining(protectedTools));
      expect(stored?.approvalRequiredTools).not.toContain('vault_status');

      const serverPayload = response.json?.server as { approvalRequiredTools: string[] };
      expect(serverPayload.approvalRequiredTools).toContain('vault_deliver_credential');

      // Idempotent: applying twice keeps a single entry per tool.
      const again = await callApi(api, { method: 'POST', key: masterKey, payload: { serverId: server.id }, path: PROTECT });
      const twice = repository.getServer(server.id)?.approvalRequiredTools ?? [];
      expect(twice.filter((name) => name === 'vault_deliver_credential')).toHaveLength(1);
      expect((again.json?.protectedTools as string[]).length).toBe(protectedTools.length);
    });

    it('keeps manually configured protection entries', async () => {
      const server = seedProtectedServer({
        approvalRequiredTools: ['vault_get_metadata'],
        highPrivilegeTools: ['vault_get_metadata'],
      });
      await callApi(api, { method: 'POST', key: masterKey, payload: { serverId: server.id }, path: PROTECT });
      const stored = repository.getServer(server.id);
      expect(stored?.approvalRequiredTools).toContain('vault_get_metadata');
      expect(stored?.approvalRequiredTools).toContain('vault_deliver_credential');
    });

    it('validates auth, server ownership and the body', async () => {
      const server = seedProtectedServer();

      await expect(
        callApi(api, { method: 'POST', key: null, payload: { serverId: server.id }, path: PROTECT }),
      ).rejects.toMatchObject({ httpStatus: 401 });
      await expect(
        callApi(api, { method: 'POST', key: agentKeyPlaintext, payload: { serverId: server.id }, path: PROTECT }),
      ).rejects.toMatchObject({ httpStatus: 403 });
      await expect(
        callApi(api, { method: 'POST', key: masterKey, payload: { serverId: 'srv_missing' }, path: PROTECT }),
      ).rejects.toMatchObject({ httpStatus: 404 });
      await expect(callApi(api, { method: 'POST', key: masterKey, payload: {}, path: PROTECT })).rejects.toMatchObject({
        httpStatus: 400,
      });
    });
  });
});
