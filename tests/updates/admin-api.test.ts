import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DatabaseSync } from 'node:sqlite';

import type { GatewayConfig } from '../../src/core/config.js';
import { openDatabase } from '../../src/core/db.js';
import { ErrorCodes } from '../../src/core/errors.js';
import type { AuthenticatedKey, ServerSourceInfo, UpdateCheckResult } from '../../src/core/types.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';
import { UpdatesApi, type UpdatesApiDeps } from '../../src/admin/updates-api.js';
import { makeUpdateConfig, makeRoot, removeRoot } from './support.js';

const roots: string[] = [];
const dbs: DatabaseSync[] = [];

beforeEach(() => {
  roots.push(makeRoot('updates-api-'));
});

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) removeRoot(root);
  }
});

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

function makeRequest(
  method: string,
  headers: Record<string, string> = {},
  body?: unknown,
): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const req = Readable.from(chunks) as unknown as IncomingMessage;
  const mutable = req as unknown as { method: string; url: string; headers: Record<string, string> };
  mutable.method = method;
  mutable.url = '/mcp/v1/admin/updates';
  mutable.headers = {
    ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(JSON.stringify(body))) }),
    ...headers,
  };
  return req;
}

function makeResponse(): { res: ServerResponse; done: Promise<ApiResponse> } {
  let status = 0;
  let resolveDone: (value: ApiResponse) => void = () => {};
  const done = new Promise<ApiResponse>((resolve) => {
    resolveDone = resolve;
  });
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (chunk?: string) => {
      resolveDone({ status, body: chunk ? (JSON.parse(chunk) as Record<string, unknown>) : {} });
    },
  } as unknown as ServerResponse;
  return { res, done };
}

async function call(
  api: UpdatesApi,
  method: string,
  path: string,
  options: { key?: string; body?: unknown } = {},
): Promise<{ handled: boolean; response: ApiResponse }> {
  const headers: Record<string, string> = {};
  if (options.key !== undefined) headers.authorization = `Bearer ${options.key}`;
  const req = makeRequest(method, headers, options.body);
  const { res, done } = makeResponse();
  const handled = await api.handle(req, res, new URL(`http://localhost${path}`));
  if (!handled) return { handled, response: { status: 0, body: {} } };
  return { handled, response: await done };
}

function sampleSource(): ServerSourceInfo {
  return {
    serverId: 'srv_example0000001',
    sourceKind: 'catalog',
    catalogSourceId: 'cat_example',
    catalogEntryId: 'brain-mcp',
    repoUrl: 'https://github.com/example/brain-mcp',
    requestedRef: 'v1.0.0',
    installedCommit: 'a'.repeat(40),
    installedVersion: '1.0.0',
    latestCommit: null,
    latestVersion: null,
    latestRef: null,
    updateAvailable: false,
    checkedAt: null,
    checkError: null,
    changelogUrl: null,
  };
}

function sampleCheck(): UpdateCheckResult {
  return {
    serverId: 'srv_example0000001',
    serverName: 'brain',
    status: 'update-available',
    updateAvailable: true,
    fromVersion: '1.0.0',
    toVersion: 'v2.0.0',
    fromCommit: 'a'.repeat(40),
    toCommit: 'b'.repeat(40),
    latestRef: 'v2.0.0',
    checkedAt: new Date().toISOString(),
    error: null,
  };
}

interface FakeUpdates {
  api: UpdatesApi;
  keys: SqliteKeyService;
  masterKey: string;
  agentKey: string;
  updates: {
    listSources: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    check: ReturnType<typeof vi.fn>;
    checkAll: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    recordSource: ReturnType<typeof vi.fn>;
    backfillFromCatalog: ReturnType<typeof vi.fn>;
    reinstall: ReturnType<typeof vi.fn>;
  };
}

function setup(): FakeUpdates {
  const root = roots[roots.length - 1] as string;
  const config: GatewayConfig = makeUpdateConfig(root);
  const db = openDatabase(':memory:');
  dbs.push(db);
  const keys = new SqliteKeyService(db, { pepper: null });
  const masterKey = keys.issue({ name: 'master', keyType: 'master' }).plaintext;
  const agentKey = keys.issue({ name: 'agent', keyType: 'agent' }).plaintext;

  const updates = {
    listSources: vi.fn(() => [sampleSource()]),
    get: vi.fn(() => sampleSource()),
    check: vi.fn(async () => sampleCheck()),
    checkAll: vi.fn(async () => [sampleCheck()]),
    update: vi.fn(async () => ({
      server: { id: 'srv_example0000001', name: 'brain' },
      before: { version: '1.0.0', commit: 'a'.repeat(40) },
      after: { version: '2.0.0', commit: 'b'.repeat(40) },
      test: { ok: true, toolCount: 6, tools: ['echo'], latencyMs: 1, error: null },
      changed: true,
    })),
    recordSource: vi.fn(),
    backfillFromCatalog: vi.fn(async () => ({ recorded: 2, skipped: 1, errors: [] })),
    reinstall: vi.fn(async () => ({
      server: { id: 'srv_example0000001', name: 'brain' },
      before: { version: null, commit: null },
      after: { version: '1.0.0', commit: 'c'.repeat(40) },
      test: { ok: true, toolCount: 6, tools: ['echo'], latencyMs: 1, error: null },
      changed: true,
    })),
  };

  const api = new UpdatesApi({ config, keys, updates: updates as unknown as UpdatesApiDeps['updates'] });
  return { api, keys, masterKey, agentKey, updates };
}

describe('UpdatesApi (admin REST)', () => {
  it('requires a master key and returns the standard error envelope', async () => {
    const { api, agentKey } = setup();

    const anonymous = await call(api, 'GET', '/mcp/v1/admin/updates');
    expect(anonymous.response.status).toBe(401);
    expect(anonymous.response.body.error).toMatchObject({ code: ErrorCodes.KEY_INVALID });

    const agent = await call(api, 'GET', '/mcp/v1/admin/updates', { key: agentKey });
    expect(agent.response.status).toBe(403);
    expect(agent.response.body.error).toMatchObject({ code: ErrorCodes.ACCESS_DENIED });
  });

  it('serves tracked sources and check results', async () => {
    const { api, masterKey, updates } = setup();

    const sources = await call(api, 'GET', '/mcp/v1/admin/updates', { key: masterKey });
    expect(sources.response.status).toBe(200);
    expect(sources.response.body).toMatchObject({ sources: [sampleSource()] });

    // Body omitted → check every tracked server.
    const all = await call(api, 'POST', '/mcp/v1/admin/updates/check', { key: masterKey });
    expect(all.response.status).toBe(200);
    expect(updates.checkAll).toHaveBeenCalledWith(undefined);
    expect((all.response.body.results as unknown[]).length).toBe(1);

    const filtered = await call(api, 'POST', '/mcp/v1/admin/updates/check', {
      key: masterKey,
      body: { serverIds: ['srv_example0000001'] },
    });
    expect(filtered.response.status).toBe(200);
    expect(updates.checkAll).toHaveBeenCalledWith(['srv_example0000001']);
  });

  it('checks and updates one server', async () => {
    const { api, masterKey, updates } = setup();

    const check = await call(api, 'POST', '/mcp/v1/admin/updates/servers/srv_example0000001/check', {
      key: masterKey,
    });
    expect(check.response.status).toBe(200);
    expect(check.response.body.update).toMatchObject({ status: 'update-available' });
    expect(updates.check).toHaveBeenCalledWith('srv_example0000001');

    const update = await call(api, 'POST', '/mcp/v1/admin/updates/servers/srv_example0000001/update', {
      key: masterKey,
      body: { ref: 'v2.0.0', restart: false, test: true },
    });
    expect(update.response.status).toBe(200);
    expect(update.response.body.result).toMatchObject({ changed: true });
    expect(updates.update).toHaveBeenCalledWith('srv_example0000001', {
      ref: 'v2.0.0',
      restart: false,
      test: true,
    });

    // Optional body: defaults are passed through as undefined/null.
    const minimal = await call(api, 'POST', '/mcp/v1/admin/updates/servers/srv_example0000001/update', {
      key: masterKey,
    });
    expect(minimal.response.status).toBe(200);
    expect(updates.update).toHaveBeenLastCalledWith('srv_example0000001', {
      ref: null,
      restart: undefined,
      test: undefined,
    });
  });

  it('reinstalls one server from its tracked source', async () => {
    const { api, masterKey, updates } = setup();
    const response = await call(api, 'POST', '/mcp/v1/admin/updates/servers/srv_example0000001/reinstall', {
      key: masterKey,
    });
    expect(response.response.status).toBe(200);
    expect(response.response.body.result).toMatchObject({ changed: true });
    expect(updates.reinstall).toHaveBeenCalledWith('srv_example0000001');
  });

  it('runs the catalog backfill route', async () => {
    const { api, masterKey, updates } = setup();
    const backfill = await call(api, 'POST', '/mcp/v1/admin/updates/backfill', { key: masterKey });
    expect(backfill.response.status).toBe(200);
    expect(backfill.response.body).toEqual({ recorded: 2, skipped: 1, errors: [] });
    expect(updates.backfillFromCatalog).toHaveBeenCalledTimes(1);
  });

  it('supports an injected request authenticator (session cookie principals)', async () => {
    const { updates, masterKey, agentKey } = setup();
    const authenticate = (req: IncomingMessage): AuthenticatedKey => ({
      id: 'ui:admin',
      name: 'ui-admin',
      keyType: req.headers['authorization'] === 'Bearer session-master' ? 'master' : 'agent',
      keyPrefix: 'ui',
      serverGrants: [],
      delegationAllowed: true,
      escalationAllowed: true,
      expiresAt: null,
      revokedAt: null,
      pausedAt: null,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      metadata: {},
    });
    const root = roots[roots.length - 1] as string;
    const api = new UpdatesApi({
      config: makeUpdateConfig(root),
      keys: { authenticate: () => { throw new Error('unused'); } } as unknown as UpdatesApiDeps['keys'],
      updates: updates as unknown as UpdatesApiDeps['updates'],
      authenticate,
    });

    const denied = await call(api, 'GET', '/mcp/v1/admin/updates', { key: agentKey });
    expect(denied.response.status).toBe(403);

    const allowed = await call(api, 'GET', '/mcp/v1/admin/updates', { key: 'session-master' });
    expect(allowed.response.status).toBe(200);
    expect(masterKey.startsWith('mcp_master_')).toBe(true);
  });

  it('returns false for non-updates routes', async () => {
    const { api, masterKey } = setup();
    const other = await call(api, 'GET', '/mcp/v1/admin/servers', { key: masterKey });
    expect(other.handled).toBe(false);
    const unknown = await call(api, 'GET', '/mcp/v1/admin/updates/nope', { key: masterKey });
    expect(unknown.handled).toBe(false);
  });

  it('rejects malformed bodies', async () => {
    const { api, masterKey } = setup();
    const bad = await call(api, 'POST', '/mcp/v1/admin/updates/check', {
      key: masterKey,
      body: { serverIds: 'not-an-array' },
    });
    expect(bad.response.status).toBe(400);
    expect(bad.response.body.error).toMatchObject({ code: ErrorCodes.INVALID_PARAMS });

    const badRestart = await call(api, 'POST', '/mcp/v1/admin/updates/servers/srv_x/update', {
      key: masterKey,
      body: { restart: 'yes' },
    });
    expect(badRestart.response.status).toBe(400);
  });
});
