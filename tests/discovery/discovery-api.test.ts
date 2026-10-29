import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { DiscoveryApi } from '../../src/admin/discovery-api.js';
import type { GatewayConfig } from '../../src/core/config.js';
import { ErrorCodes, invalidKey } from '../../src/core/errors.js';
import type { HarnessDiscoveryService, KeyService } from '../../src/core/ports.js';
import type {
  AuthenticatedKey,
  HarnessEntry,
  HarnessImportInput,
  HarnessScanResult,
  HarnessSourceInfo,
  ServerRecord,
} from '../../src/core/types.js';
import { silentLogger } from './helpers.js';

const MASTER_KEY = 'mcp_master_fixture_master_key';
const AGENT_KEY = 'mcp_ag_fixture_agent_key';

function buildConfig(): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir: '.test-data/discovery-api',
    dbPath: '.test-data/discovery-api/gateway.db',
    uiDistDir: '.test-data/discovery-api/ui',
    vaultSecret: null,
    bootstrapMasterKey: null,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: [],
    reposDir: '.test-data/discovery-api/repos',
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 5_000,
    keyPepper: null,
    publicBaseUrl: 'http://127.0.0.1',
  };
}

function keyRecord(overrides: Partial<AuthenticatedKey>): AuthenticatedKey {
  return {
    id: 'key_fixture',
    name: 'fixture',
    keyType: 'master',
    keyPrefix: 'mcp_master_fix',
    serverGrants: [],
    delegationAllowed: false,
    escalationAllowed: false,
    expiresAt: null,
    revokedAt: null,
    pausedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    metadata: {},
    ...overrides,
  };
}

const masterKey = keyRecord({ id: 'key_master', name: 'fixture-master', keyType: 'master' });
const agentKey = keyRecord({ id: 'key_agent', name: 'fixture-agent', keyType: 'agent' });

const fakeKeys = {
  authenticate(plaintext: string): AuthenticatedKey {
    if (plaintext === MASTER_KEY) return masterKey;
    if (plaintext === AGENT_KEY) return agentKey;
    throw invalidKey();
  },
} as unknown as KeyService;

const SOURCES: HarnessSourceInfo[] = [
  { id: 'claude', label: 'Claude Code', configPath: '/home/fixture/.claude.json', exists: true, serverCount: 1 },
];

const ENTRIES: HarnessEntry[] = [
  {
    id: 'claude:brain',
    harness: 'claude',
    name: 'brain',
    transport: 'stdio',
    command: 'node',
    args: ['/opt/example/brain-mcp/index.js'],
    url: null,
    envKeys: ['BRAIN_API_KEY'],
    envFile: null,
    headerKeys: [],
    enabled: true,
  },
];

const SCAN_RESULT: HarnessScanResult = { sources: SOURCES, entries: ENTRIES, errors: [] };

function makeRecord(input: HarnessImportInput): ServerRecord {
  return {
    id: 'srv_fixture',
    name: input.name,
    runtime: 'node',
    transport: input.transport ?? 'stdio',
    status: 'stopped',
    command: input.command ?? null,
    args: input.args ?? [],
    url: input.url ?? null,
    env: input.env ?? {},
    manifest: null,
    highPrivilegeTools: input.highPrivilegeTools ?? [],
    delegationSupported: false,
    sourceUrl: null,
    workDir: null,
    envFile: input.envFile ?? null,
    approvalRequiredTools: input.approvalRequiredTools ?? [],
    lastError: null,
    pid: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeApi() {
  const listSources = vi.fn(() => SOURCES);
  const scan = vi.fn(async (_harnessIds?: string[]) => SCAN_RESULT);
  const importEntry = vi.fn(async (input: HarnessImportInput) => makeRecord(input));
  const discovery = { listSources, scan, importEntry } as unknown as HarnessDiscoveryService;
  const api = new DiscoveryApi({ config: buildConfig(), keys: fakeKeys, discovery, logger: silentLogger });
  return { api, listSources, scan, importEntry };
}

interface FakeRequestOptions {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}

function fakeRequest(options: FakeRequestOptions = {}): IncomingMessage {
  const chunks: Buffer[] = [];
  if (options.rawBody !== undefined) chunks.push(Buffer.from(options.rawBody, 'utf8'));
  else if (options.body !== undefined) chunks.push(Buffer.from(JSON.stringify(options.body), 'utf8'));
  const stream = Readable.from(chunks);
  return Object.assign(stream, {
    method: options.method ?? 'GET',
    url: options.url ?? '/mcp/v1/admin/discovery/sources',
    headers: options.headers ?? {},
  }) as unknown as IncomingMessage;
}

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function fakeResponse(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' };
  const res = {
    writeHead(status: number, headers?: Record<string, string | number>) {
      captured.status = status;
      for (const [key, value] of Object.entries(headers ?? {})) captured.headers[key.toLowerCase()] = String(value);
      return this;
    },
    end(chunk?: unknown) {
      if (typeof chunk === 'string') captured.body = chunk;
      else if (chunk instanceof Uint8Array) captured.body = Buffer.from(chunk).toString('utf8');
      return this;
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

async function call(
  api: DiscoveryApi,
  req: IncomingMessage,
  path: string,
): Promise<{ matched: boolean; captured: CapturedResponse }> {
  const { res, captured } = fakeResponse();
  const matched = await api.handle(req, res, new URL(`http://127.0.0.1${path}`));
  return { matched, captured };
}

function authHeaders(key = MASTER_KEY): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

function parseBody(captured: CapturedResponse): any {
  return JSON.parse(captured.body) as unknown;
}

describe('DiscoveryApi', () => {
  it('returns the source list for a master key', async () => {
    const { api, listSources } = makeApi();
    const { matched, captured } = await call(
      api,
      fakeRequest({ headers: authHeaders() }),
      '/mcp/v1/admin/discovery/sources',
    );

    expect(matched).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(parseBody(captured)).toEqual({ sources: SOURCES });
    expect(listSources).toHaveBeenCalledTimes(1);
  });

  it('accepts the x-mcp-api-key header as well as bearer auth', async () => {
    const { api } = makeApi();
    const { matched, captured } = await call(
      api,
      fakeRequest({ headers: { 'x-mcp-api-key': MASTER_KEY } }),
      '/mcp/v1/admin/discovery/sources',
    );

    expect(matched).toBe(true);
    expect(captured.status).toBe(200);
  });

  it('denies agent keys with a 403 error envelope', async () => {
    const { api, listSources } = makeApi();
    const { matched, captured } = await call(
      api,
      fakeRequest({ headers: authHeaders(AGENT_KEY) }),
      '/mcp/v1/admin/discovery/sources',
    );

    expect(matched).toBe(true);
    expect(captured.status).toBe(403);
    expect(parseBody(captured).error.code).toBe(ErrorCodes.ACCESS_DENIED);
    expect(parseBody(captured).error.data.reason).toBe('SCOPE_RESTRICTION');
    expect(listSources).not.toHaveBeenCalled();
  });

  it('rejects requests without a key', async () => {
    const { api } = makeApi();
    const { matched, captured } = await call(api, fakeRequest(), '/mcp/v1/admin/discovery/sources');

    expect(matched).toBe(true);
    expect(captured.status).toBe(401);
    expect(parseBody(captured).error.code).toBe(ErrorCodes.KEY_INVALID);
  });

  it('scans all harnesses when the body is omitted', async () => {
    const { api, scan } = makeApi();
    const { captured } = await call(
      api,
      fakeRequest({ method: 'POST', headers: authHeaders() }),
      '/mcp/v1/admin/discovery/scan',
    );

    expect(captured.status).toBe(200);
    expect(scan).toHaveBeenCalledWith(undefined);
    expect(parseBody(captured)).toEqual(SCAN_RESULT);
  });

  it('passes harnessIds through to the scan', async () => {
    const { api, scan } = makeApi();
    const { captured } = await call(
      api,
      fakeRequest({ method: 'POST', headers: authHeaders(), body: { harnessIds: ['claude'] } }),
      '/mcp/v1/admin/discovery/scan',
    );

    expect(captured.status).toBe(200);
    expect(scan).toHaveBeenCalledWith(['claude']);
  });

  it('rejects a non-array harnessIds value', async () => {
    const { api, scan } = makeApi();
    const { captured } = await call(
      api,
      fakeRequest({ method: 'POST', headers: authHeaders(), body: { harnessIds: 'claude' } }),
      '/mcp/v1/admin/discovery/scan',
    );

    expect(captured.status).toBe(400);
    expect(parseBody(captured).error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(scan).not.toHaveBeenCalled();
  });

  it('imports an entry and returns 201 with the server', async () => {
    const { api, importEntry } = makeApi();
    const body = {
      harness: 'claude',
      name: 'brain',
      transport: 'stdio',
      command: 'node',
      args: ['/opt/example/brain-mcp/index.js'],
      env: { BRAIN_API_KEY: 'user-supplied-value' },
      envFile: '~/.config/example/mcp.env',
      highPrivilegeTools: ['brain_delete'],
      approvalRequiredTools: ['brain_delete', 'brain_rotate'],
    };
    const { matched, captured } = await call(
      api,
      fakeRequest({ method: 'POST', headers: authHeaders(), body }),
      '/mcp/v1/admin/discovery/import',
    );

    expect(matched).toBe(true);
    expect(captured.status).toBe(201);
    expect(parseBody(captured).server.name).toBe('brain');
    expect(importEntry).toHaveBeenCalledWith({
      harness: 'claude',
      name: 'brain',
      transport: 'stdio',
      command: 'node',
      args: ['/opt/example/brain-mcp/index.js'],
      env: { BRAIN_API_KEY: 'user-supplied-value' },
      envFile: '~/.config/example/mcp.env',
      highPrivilegeTools: ['brain_delete'],
      approvalRequiredTools: ['brain_delete', 'brain_rotate'],
    });
  });

  it('rejects imports without a harness or name and never calls the service', async () => {
    const { api, importEntry } = makeApi();

    const missingHarness = await call(
      api,
      fakeRequest({ method: 'POST', headers: authHeaders(), body: { name: 'brain' } }),
      '/mcp/v1/admin/discovery/import',
    );
    expect(missingHarness.captured.status).toBe(400);
    expect(parseBody(missingHarness.captured).error.message).toContain('harness is required');

    const missingName = await call(
      api,
      fakeRequest({ method: 'POST', headers: authHeaders(), body: { harness: 'claude' } }),
      '/mcp/v1/admin/discovery/import',
    );
    expect(missingName.captured.status).toBe(400);
    expect(parseBody(missingName.captured).error.message).toContain('name is required');
    expect(importEntry).not.toHaveBeenCalled();
  });

  it('rejects invalid import body fields', async () => {
    const { api } = makeApi();

    const invalidTransport = await call(
      api,
      fakeRequest({
        method: 'POST',
        headers: authHeaders(),
        body: { harness: 'claude', name: 'brain', transport: 'carrier-pigeon' },
      }),
      '/mcp/v1/admin/discovery/import',
    );
    expect(invalidTransport.captured.status).toBe(400);
    expect(parseBody(invalidTransport.captured).error.message).toContain('transport must be one of');

    const invalidEnv = await call(
      api,
      fakeRequest({
        method: 'POST',
        headers: authHeaders(),
        body: { harness: 'claude', name: 'brain', env: { BRAIN_API_KEY: { nested: true } } },
      }),
      '/mcp/v1/admin/discovery/import',
    );
    expect(invalidEnv.captured.status).toBe(400);
    expect(parseBody(invalidEnv.captured).error.message).toContain('env values must be strings');
  });

  it('does not import for agent keys', async () => {
    const { api, importEntry } = makeApi();
    const { captured } = await call(
      api,
      fakeRequest({
        method: 'POST',
        headers: authHeaders(AGENT_KEY),
        body: { harness: 'claude', name: 'brain', command: 'node' },
      }),
      '/mcp/v1/admin/discovery/import',
    );

    expect(captured.status).toBe(403);
    expect(importEntry).not.toHaveBeenCalled();
  });

  it('rejects wrong methods and unknown discovery endpoints', async () => {
    const { api } = makeApi();

    const wrongMethod = await call(api, fakeRequest({ headers: authHeaders() }), '/mcp/v1/admin/discovery/scan');
    expect(wrongMethod.matched).toBe(true);
    expect(wrongMethod.captured.status).toBe(405);

    const unknown = await call(
      api,
      fakeRequest({ method: 'POST', headers: authHeaders() }),
      '/mcp/v1/admin/discovery/nope',
    );
    expect(unknown.matched).toBe(true);
    expect(unknown.captured.status).toBe(404);
    expect(parseBody(unknown.captured).error.code).toBe(ErrorCodes.METHOD_NOT_FOUND);
  });

  it('leaves non-discovery admin URLs to the parent router', async () => {
    const { api } = makeApi();
    const { matched, captured } = await call(
      api,
      fakeRequest({ headers: authHeaders() }),
      '/mcp/v1/admin/servers',
    );

    expect(matched).toBe(false);
    expect(captured.status).toBe(0);
  });
});
