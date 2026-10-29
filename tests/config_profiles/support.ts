/**
 * Shared helpers for the configuration-profile test suites (not a test file).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

import type { GatewayConfig } from '../../src/core/config.js';
import { openDatabase } from '../../src/core/db.js';
import type { Logger } from '../../src/core/logger.js';
import type { McpClient, Supervisor } from '../../src/core/ports.js';
import type { ServerRecord } from '../../src/core/types.js';
import { DefaultConfigProfileService } from '../../src/config_profiles/service.js';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';
import { DefaultSupervisor } from '../../src/gateway/supervisor.js';
import { SqliteVaultService } from '../../src/vault/store.js';

export const TEST_VAULT_SECRET = 'test-vault-secret-0123456789abcdef';
export const ENV_FIXTURE_PATH = fileURLToPath(new URL('./fixtures/env-server.mjs', import.meta.url));

export function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir: '/tmp/mcp-gateway-config-profiles-test',
    dbPath: ':memory:',
    uiDistDir: 'ui/dist',
    vaultSecret: TEST_VAULT_SECRET,
    bootstrapMasterKey: null,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: [],
    reposDir: '/tmp/mcp-gateway-config-profiles-test-repos',
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 10_000,
    keyPepper: null,
    publicBaseUrl: 'http://localhost:8080',
    ...overrides,
  };
}

const noop = (): void => undefined;

export function silentLogger(): Logger {
  return {
    module: 'test',
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => silentLogger(),
  };
}

export interface Harness {
  db: DatabaseSync;
  config: GatewayConfig;
  vault: SqliteVaultService;
  repository: SqliteCatalogRepository;
  supervisor: DefaultSupervisor;
  service: DefaultConfigProfileService;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Pass null to simulate a vault-disabled gateway. */
  vaultSecret?: string | null;
  config?: Partial<GatewayConfig>;
}

/**
 * Boot the profile stack with a real supervisor wired to the profile resolver,
 * mirroring the production container.
 */
export function createHarness(options: HarnessOptions = {}): Harness {
  const db = openDatabase(':memory:');
  const config = makeConfig(options.config);
  const logger = silentLogger();
  const vaultSecret = options.vaultSecret === undefined ? TEST_VAULT_SECRET : options.vaultSecret;
  const vault = new SqliteVaultService(db, vaultSecret, { logger });
  const repository = new SqliteCatalogRepository(db);
  // The resolver closes over a holder because the supervisor is constructed before
  // the service that implements it (mirrors the container wiring).
  const holder: { service: DefaultConfigProfileService | null } = { service: null };
  const supervisor = new DefaultSupervisor({
    repository,
    config,
    vault,
    logger,
    profileResolver: (serverId) => {
      if (!holder.service) throw new Error('configuration profile service is not initialised');
      return holder.service.resolveForServer(serverId);
    },
  });
  const service = new DefaultConfigProfileService({
    db,
    repository,
    vault,
    supervisor,
    logger,
  });
  holder.service = service;

  return {
    db,
    config,
    vault,
    repository,
    supervisor,
    service,
    async close() {
      await supervisor.shutdown();
      db.close();
    },
  };
}

const BASE_SERVER: ServerRecord = {
  id: 'srv_env_fixture',
  name: 'env-fixture',
  runtime: 'node',
  transport: 'stdio',
  status: 'stopped',
  command: process.execPath,
  args: [ENV_FIXTURE_PATH],
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

/** Register the env-reporting fixture server (stopped). */
export function addEnvServer(harness: Harness, overrides: Partial<ServerRecord> = {}): ServerRecord {
  const server: ServerRecord = {
    ...BASE_SERVER,
    ...overrides,
    id: overrides.id ?? BASE_SERVER.id,
    name: overrides.name ?? BASE_SERVER.name,
    args: overrides.args ?? [...BASE_SERVER.args],
    env: overrides.env ?? {},
    headers: overrides.headers ?? {},
  };
  harness.repository.upsertServer(server);
  return server;
}

/** Read the raw `servers.config_profile_ids` column (repository does not project it). */
export function serverProfileIds(harness: Harness, serverId: string): string[] {
  const row = harness.db
    .prepare('SELECT config_profile_ids FROM servers WHERE id = ?')
    .get(serverId) as unknown as { config_profile_ids?: string } | undefined;
  if (!row?.config_profile_ids) return [];
  const parsed = JSON.parse(row.config_profile_ids) as unknown;
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

/** Call the fixture's `env_report` tool and parse its JSON text response. */
export async function reportEnv(
  supervisor: Supervisor,
  serverId: string,
  keys: string[],
): Promise<Record<string, string | null>> {
  const client: McpClient | null = supervisor.client(serverId);
  if (!client) throw new Error(`Server '${serverId}' is not running`);
  const result = await client.callTool('env_report', { keys });
  const first = Array.isArray(result.content) ? (result.content[0] as { text?: string } | undefined) : undefined;
  if (!first || typeof first.text !== 'string') throw new Error('env_report returned no text content');
  return JSON.parse(first.text) as Record<string, string | null>;
}

// ---------------------------------------------------------------------------
// Minimal HTTP mocks for direct sub-router tests
// ---------------------------------------------------------------------------

export interface MockRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export function mockRequest(options: MockRequestOptions = {}): IncomingMessage {
  const raw = options.body === undefined ? '' : JSON.stringify(options.body);
  const request = {
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    async *[Symbol.asyncIterator]() {
      if (raw !== '') yield Buffer.from(raw, 'utf8');
    },
  };
  return request as unknown as IncomingMessage;
}

export interface MockResponse {
  statusCode: number;
  headersSent: boolean;
  writableEnded: boolean;
  headers: Record<string, string | number | string[]>;
  payload: string;
  writeHead(status: number, headers?: Record<string, string | number | string[]>): void;
  setHeader(name: string, value: string | number | string[]): void;
  getHeader(name: string): string | number | string[] | undefined;
  end(chunk?: string | Buffer): void;
  asServerResponse(): ServerResponse;
}

export function mockResponse(): MockResponse {
  const response: MockResponse = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    headers: {},
    payload: '',
    writeHead(status, headers = {}) {
      response.statusCode = status;
      for (const [name, value] of Object.entries(headers)) {
        response.headers[name.toLowerCase()] = value;
      }
    },
    setHeader(name, value) {
      response.headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return response.headers[name.toLowerCase()];
    },
    end(chunk) {
      response.headersSent = true;
      response.writableEnded = true;
      if (typeof chunk === 'string') response.payload += chunk;
      else if (chunk) response.payload += chunk.toString('utf8');
    },
    asServerResponse() {
      return response as unknown as ServerResponse;
    },
  };
  return response;
}

export function jsonBody(res: MockResponse): any {
  return JSON.parse(res.payload);
}
