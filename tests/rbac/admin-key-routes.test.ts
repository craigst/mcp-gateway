import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminApi } from '../../src/admin/router.js';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';
import type { GatewayConfig } from '../../src/core/config.js';
import { openDatabase } from '../../src/core/db.js';
import { createLogger } from '../../src/core/logger.js';
import type { AuthenticatedKey, ServerRecord } from '../../src/core/types.js';
import { SqliteAuditService } from '../../src/gateway/audit.js';
import { SqliteKeyActivityService } from '../../src/rbac/key-activity.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';

const silent = createLogger('test', 'silent');

function makeConfig(): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir: '/tmp/mcp-gateway-admin-keys-test',
    dbPath: ':memory:',
    uiDistDir: 'ui/dist',
    vaultSecret: null,
    bootstrapMasterKey: null,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: [],
    reposDir: '/tmp/mcp-gateway-admin-keys-test-repos',
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 10_000,
    keyPepper: null,
    publicBaseUrl: 'http://localhost:8080',
  };
}

function principal(overrides: Partial<AuthenticatedKey> = {}): AuthenticatedKey {
  return {
    id: 'key_test',
    name: 'tester',
    keyType: 'master',
    keyPrefix: 'mcp_master_ab',
    serverGrants: [],
    delegationAllowed: true,
    escalationAllowed: true,
    expiresAt: null,
    revokedAt: null,
    pausedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    metadata: {},
    ...overrides,
  };
}

interface MockResponse {
  statusCode: number;
  headers: Record<string, string | number | string[]>;
  payload: string;
  ended: boolean;
  writeHead(status: number, headers?: Record<string, string | number | string[]>): void;
  end(chunk?: string | Buffer): void;
  asServerResponse(): ServerResponse;
}

function mockResponse(): MockResponse {
  const response: MockResponse = {
    statusCode: 200,
    headers: {},
    payload: '',
    ended: false,
    writeHead(status, headers = {}) {
      response.statusCode = status;
      for (const [name, value] of Object.entries(headers)) response.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      response.ended = true;
      if (typeof chunk === 'string') response.payload += chunk;
      else if (chunk) response.payload += chunk.toString('utf8');
    },
    asServerResponse() {
      return response as unknown as ServerResponse;
    },
  };
  return response;
}

function mockRequest(
  method: string,
  headers: Record<string, string> = {},
  body?: unknown,
): IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const request = {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (raw !== '') yield Buffer.from(raw, 'utf8');
    },
  };
  return request as unknown as IncomingMessage;
}

interface Harness {
  db: DatabaseSync;
  keys: SqliteKeyService;
  repository: SqliteCatalogRepository;
  audit: SqliteAuditService;
  keyActivity: SqliteKeyActivityService;
  config: GatewayConfig;
  makeAdmin(options?: {
    authenticate?: (req: IncomingMessage) => AuthenticatedKey;
    includeKeyActivity?: boolean;
  }): AdminApi;
}

function createHarness(): Harness {
  const db = openDatabase(':memory:');
  const keys = new SqliteKeyService(db, { logger: silent });
  const repository = new SqliteCatalogRepository(db);
  const audit = new SqliteAuditService(db);
  const keyActivity = new SqliteKeyActivityService({ db, repository, keys, audit, logger: silent });
  const config = makeConfig();

  const server: ServerRecord = {
    id: 'srv_alpha',
    name: 'alpha',
    runtime: 'node',
    transport: 'stdio',
    status: 'running',
    command: 'node',
    args: [],
    url: null,
    env: {},
    headers: {},
    manifest: null,
    highPrivilegeTools: [],
    delegationSupported: false,
    sourceUrl: null,
    workDir: null,
    envFile: null,
    approvalRequiredTools: [],
    lastError: null,
    pid: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  repository.upsertServer(server);
  repository.upsertTools('srv_alpha', [
    {
      id: 'srv_alpha:echo',
      name: 'echo',
      description: 'Echo',
      serverId: 'srv_alpha',
      inputSchema: { type: 'object' },
      highPrivilege: false,
      tags: [],
    },
  ]);

  return {
    db,
    keys,
    repository,
    audit,
    keyActivity,
    config,
    makeAdmin(options = {}) {
      const stub = {} as never;
      return new AdminApi({
        config,
        keys,
        policy: stub,
        escalations: stub,
        catalog: stub,
        supervisor: stub,
        vault: stub,
        git: stub,
        audit,
        delegation: stub,
        mcpServer: undefined,
        keyActivity: options.includeKeyActivity === false ? undefined : keyActivity,
        authenticate: options.authenticate,
        logger: silent,
      } as ConstructorParameters<typeof AdminApi>[0]);
    },
  };
}

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => {
  harness.db.close();
});

interface CallResult {
  handled: boolean;
  status: number;
  body: any;
}

async function call(
  admin: AdminApi,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<CallResult> {
  const request = mockRequest(method, options.headers, options.body);
  const response = mockResponse();
  const handled = await admin.handle(
    request,
    response.asServerResponse(),
    new URL(`http://localhost:8080${path}`),
  );
  return {
    handled,
    status: response.statusCode,
    body: response.payload === '' ? null : JSON.parse(response.payload),
  };
}

function masterAdmin(): AdminApi {
  return harness.makeAdmin({ authenticate: () => principal() });
}

describe('AdminApi key management routes', () => {
  it('lists, reads and creates keys with pausedAt', async () => {
    const admin = masterAdmin();
    const listed = await call(admin, 'GET', '/mcp/v1/admin/keys');
    expect(listed.status).toBe(200);
    expect(listed.body.keys).toEqual([]);

    const created = await call(admin, 'POST', '/mcp/v1/admin/keys/create', {
      body: { name: 'agent', keyType: 'agent' },
    });
    expect(created.status).toBe(201);
    expect(created.body.key.pausedAt).toBeNull();
    expect(created.body.key).not.toHaveProperty('keyHash');
    const keyId = created.body.key.id as string;

    const fetched = await call(admin, 'GET', `/mcp/v1/admin/keys/${keyId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.key.pausedAt).toBeNull();

    const all = await call(admin, 'GET', '/mcp/v1/admin/keys');
    expect(all.body.keys[0]).toMatchObject({ id: keyId, pausedAt: null });
  });

  it('patches name, paused and expiry with validation', async () => {
    const admin = masterAdmin();
    const created = await call(admin, 'POST', '/mcp/v1/admin/keys/create', {
      body: { name: 'agent', keyType: 'agent' },
    });
    const keyId = created.body.key.id as string;

    const patched = await call(admin, 'PATCH', `/mcp/v1/admin/keys/${keyId}`, {
      body: { name: '  renamed  ', paused: true, expiresAt: '2030-01-01T00:00:00.000Z' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.key).toMatchObject({
      name: 'renamed',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(patched.body.key.pausedAt).not.toBeNull();
    expect(harness.keys.get(keyId)?.pausedAt).not.toBeNull();

    const cleared = await call(admin, 'PATCH', `/mcp/v1/admin/keys/${keyId}`, {
      body: { paused: false, expiresAt: null },
    });
    expect(cleared.body.key.pausedAt).toBeNull();
    expect(cleared.body.key.expiresAt).toBeNull();

    expect(
      (await call(admin, 'PATCH', `/mcp/v1/admin/keys/${keyId}`, { body: { name: '' } })).status,
    ).toBe(400);
    expect(
      (await call(admin, 'PATCH', `/mcp/v1/admin/keys/${keyId}`, { body: { expiresAt: 'soon' } }))
        .status,
    ).toBe(400);
    expect(
      (await call(admin, 'PATCH', '/mcp/v1/admin/keys/key_missing', { body: { name: 'x' } })).status,
    ).toBe(404);
  });

  it('pauses and resumes a key idempotently', async () => {
    const admin = masterAdmin();
    const issued = harness.keys.issue({ name: 'agent', keyType: 'agent' });

    const paused = await call(admin, 'POST', `/mcp/v1/admin/keys/${issued.key.id}/pause`, {
      body: {},
    });
    expect(paused.status).toBe(200);
    expect(paused.body.key.pausedAt).not.toBeNull();
    const timestamp = paused.body.key.pausedAt;

    const pausedAgain = await call(admin, 'POST', `/mcp/v1/admin/keys/${issued.key.id}/pause`, {
      body: {},
    });
    expect(pausedAgain.body.key.pausedAt).toBe(timestamp);

    const resumed = await call(admin, 'POST', `/mcp/v1/admin/keys/${issued.key.id}/resume`, {
      body: {},
    });
    expect(resumed.status).toBe(200);
    expect(resumed.body.key.pausedAt).toBeNull();

    expect(
      (await call(admin, 'POST', '/mcp/v1/admin/keys/key_missing/pause', { body: {} })).status,
    ).toBe(404);
    expect(
      (await call(admin, 'POST', '/mcp/v1/admin/keys/key_missing/resume', { body: {} })).status,
    ).toBe(404);
  });

  it('returns the access view for a key', async () => {
    const admin = masterAdmin();
    const issued = harness.keys.issue({
      name: 'agent',
      keyType: 'agent',
      serverGrants: [{ serverId: 'srv_alpha', pausedTools: ['echo'] }],
    });

    const result = await call(admin, 'GET', `/mcp/v1/admin/keys/${issued.key.id}/access`);
    expect(result.status).toBe(200);
    expect(result.body.key.id).toBe(issued.key.id);
    expect(result.body.grants).toHaveLength(1);
    expect(result.body.grants[0]).toMatchObject({
      serverId: 'srv_alpha',
      serverName: 'alpha',
      serverStatus: 'running',
      paused: false,
    });
    expect(result.body.grants[0].tools[0]).toMatchObject({
      name: 'echo',
      granted: true,
      paused: true,
      available: true,
    });

    expect(
      (await call(admin, 'GET', '/mcp/v1/admin/keys/key_missing/access')).status,
    ).toBe(404);
  });

  it('returns the paginated activity page and forwards filters', async () => {
    const admin = masterAdmin();
    const issued = harness.keys.issue({ name: 'agent', keyType: 'agent' });
    const rowId = harness.audit.record({
      requestId: null,
      keyId: issued.key.id,
      method: 'tools/call',
      serverId: 'srv_alpha',
      toolId: 'srv_alpha:echo',
      status: 'denied',
      latencyMs: 12,
      errorCode: -32001,
    });
    harness.audit.record({
      requestId: null,
      keyId: issued.key.id,
      method: 'tools/list',
      status: 'ok',
      latencyMs: 4,
    });
    harness.db.prepare('UPDATE audit_log SET ts = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', rowId);

    const page = await call(
      admin,
      'GET',
      `/mcp/v1/admin/keys/${issued.key.id}/activity?status=denied&serverId=srv_alpha&toolId=srv_alpha%3Aecho&limit=10&offset=0`,
    );
    expect(page.status).toBe(200);
    expect(page.body.total).toBe(1);
    expect(page.body.entries).toHaveLength(1);
    expect(page.body.entries[0].status).toBe('denied');
    expect(page.body.stats).toMatchObject({ total: 2, denied: 1, ok: 1 });
    expect(page.body.key.id).toBe(issued.key.id);

    expect(
      (await call(admin, 'GET', `/mcp/v1/admin/keys/${issued.key.id}/activity?status=weird`)).status,
    ).toBe(400);
    expect(
      (await call(admin, 'GET', '/mcp/v1/admin/keys/key_missing/activity')).status,
    ).toBe(404);
  });

  it('returns 503 for access/activity when the service is not wired', async () => {
    const admin = harness.makeAdmin({
      authenticate: () => principal(),
      includeKeyActivity: false,
    });
    const issued = harness.keys.issue({ name: 'agent', keyType: 'agent' });
    expect(
      (await call(admin, 'GET', `/mcp/v1/admin/keys/${issued.key.id}/access`)).status,
    ).toBe(503);
    expect(
      (await call(admin, 'GET', `/mcp/v1/admin/keys/${issued.key.id}/activity`)).status,
    ).toBe(503);
  });

  it('is master-session-only and returns false for other admin areas', async () => {
    const agentAdmin = harness.makeAdmin({
      authenticate: () => principal({ keyType: 'agent', keyPrefix: 'mcp_ag_ab' }),
    });
    expect((await call(agentAdmin, 'GET', '/mcp/v1/admin/keys')).status).toBe(403);

    // No injected authenticator and no Authorization header -> 401.
    const bearerAdmin = harness.makeAdmin();
    expect((await call(bearerAdmin, 'GET', '/mcp/v1/admin/keys')).status).toBe(401);

    const other = await call(masterAdmin(), 'GET', '/mcp/v1/admin/nope');
    expect(other.handled).toBe(false);
  });
});
