/**
 * Shared harness for v0.7 credential-provider tests.
 *
 * In-memory SQLite with the full gateway schema, a real AES vault, catalog
 * repository, supervisor and audit service, plus a temporary HOME so the
 * Vaultwarden `mcp.env` materialisation is exercised without touching the
 * operator's real home directory. Scratch files live under `.test-data/`.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import type { GatewayConfig } from '../../src/core/config.js';
import { openDatabase } from '../../src/core/db.js';
import { nowIso } from '../../src/core/ids.js';
import type { CredentialProviderService } from '../../src/core/ports.js';
import type { ServerRecord } from '../../src/core/types.js';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';
import { DefaultCredentialProviderService } from '../../src/credentials/service.js';
import { SqliteAuditService } from '../../src/gateway/audit.js';
import { DefaultSupervisor } from '../../src/gateway/supervisor.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';
import { SqliteVaultService } from '../../src/vault/store.js';

export const CREDENTIALS_VAULT_SECRET = 'credentials-test-vault-secret-0123456789';
export const VAULTWARDEN_FIXTURE = fileURLToPath(
  new URL('../fixtures/vaultwarden-fake-server.mjs', import.meta.url),
);
const TEST_DATA_DIR = join(process.cwd(), '.test-data');
const VAULTWARDEN_ENV_RELATIVE = ['.config', 'vaultwarden', 'mcp.env'] as const;

export const VAULTWARDEN_SAMPLE_VALUES: Record<string, string> = {
  VAULTWARDEN_URL: 'https://vault.example.internal',
  BW_CLIENTID: 'user.example.internal',
  BW_CLIENTSECRET: 'client-secret-fixture-value',
  BW_PASSWORD: 'master-password-fixture-value',
  VAULT_ORG_ID: 'org-fixture',
};

export const OP_CONNECT_TOKEN = 'op-connect-fixture-token-0123456789';
export const OP_CONNECT_SECRET_VALUE = 'op-connect-secret-value';

export interface CredentialsHarness {
  root: string;
  homeDir: string;
  config: GatewayConfig;
  db: DatabaseSync;
  vault: SqliteVaultService;
  repository: SqliteCatalogRepository;
  supervisor: DefaultSupervisor;
  audit: SqliteAuditService;
  keys: SqliteKeyService;
  credentials: DefaultCredentialProviderService;
  registerVaultwardenServer(): ServerRecord;
  dispose(): Promise<void>;
}

export function makeCredentialsConfig(root: string, overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir: join(root, 'data'),
    dbPath: join(root, 'data', 'gateway.db'),
    uiDistDir: join(root, 'ui'),
    vaultSecret: CREDENTIALS_VAULT_SECRET,
    bootstrapMasterKey: null,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: [],
    reposDir: join(root, 'data', 'repos'),
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 15_000,
    keyPepper: null,
    publicBaseUrl: 'http://127.0.0.1:8080',
    ...overrides,
  };
}

export function makeRoot(prefix = 'credentials-'): string {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  return mkdtempSync(join(TEST_DATA_DIR, prefix));
}

export function removeRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export function vaultwardenEnvPath(harness: Pick<CredentialsHarness, 'homeDir'>): string {
  return join(harness.homeDir, ...VAULTWARDEN_ENV_RELATIVE);
}

export function createCredentialsHarness(
  root: string,
  overrides: Partial<GatewayConfig> = {},
): CredentialsHarness {
  const homeDir = join(root, 'home');
  mkdirSync(homeDir, { recursive: true });
  const config = makeCredentialsConfig(root, overrides);
  const db = openDatabase(':memory:');
  const vault = new SqliteVaultService(db, overrides.vaultSecret === null ? null : CREDENTIALS_VAULT_SECRET);
  const repository = new SqliteCatalogRepository(db);
  const supervisor = new DefaultSupervisor({ repository, config, vault });
  const audit = new SqliteAuditService(db);
  const keys = new SqliteKeyService(db, { pepper: null });
  const credentials = new DefaultCredentialProviderService({
    db,
    config,
    vault,
    repository,
    supervisor,
    audit,
    homeDir,
  });

  const harness: CredentialsHarness = {
    root,
    homeDir,
    config,
    db,
    vault,
    repository,
    supervisor,
    audit,
    keys,
    credentials,
    registerVaultwardenServer(): ServerRecord {
      const now = nowIso();
      const record: ServerRecord = {
        id: 'srv_vaultwarden0001',
        name: 'vaultwarden',
        runtime: 'node',
        transport: 'stdio',
        status: 'stopped',
        command: process.execPath,
        args: [VAULTWARDEN_FIXTURE],
        url: null,
        env: {},
        headers: {},
        manifest: {
          name: 'vaultwarden-mcp',
          version: '1.0.0',
          runtime: 'node20',
          start_command: `${process.execPath} ${VAULTWARDEN_FIXTURE}`,
        },
        highPrivilegeTools: ['vault_deliver_credential'],
        delegationSupported: false,
        sourceUrl: 'https://github.com/example/vaultwarden-mcp',
        workDir: null,
        envFile: vaultwardenEnvPath({ homeDir }),
        approvalRequiredTools: [],
        configProfileIds: [],
        lastError: null,
        pid: null,
        createdAt: now,
        updatedAt: now,
      };
      repository.upsertServer(record);
      return record;
    },
    dispose: async () => {
      try {
        await supervisor.shutdown();
      } finally {
        db.close();
      }
    },
  };
  return harness;
}

// ---------------------------------------------------------------------------
// Fake 1Password Connect REST server
// ---------------------------------------------------------------------------

export interface FakeOnepassword {
  url: string;
  requests: Array<{ method: string; path: string; authorization: string | null }>;
  expectedToken: string;
  close(): Promise<void>;
}

interface FakeVault {
  id: string;
  name: string;
}

interface FakeItemOverview {
  id: string;
  title: string;
  category: string;
  urls: Array<{ href: string }>;
}

interface FakeItemDetail extends FakeItemOverview {
  fields: Array<{ id: string; label: string; type: string; value: string }>;
}

const FAKE_VAULTS: FakeVault[] = [{ id: 'vault1', name: 'Example vault' }];
const FAKE_ITEMS: FakeItemOverview[] = [
  {
    id: 'item1',
    title: 'Example API token',
    category: 'LOGIN',
    urls: [{ href: 'https://example.internal' }],
  },
];
const FAKE_ITEM_DETAILS: Record<string, FakeItemDetail> = {
  item1: {
    ...(FAKE_ITEMS[0] as FakeItemOverview),
    fields: [
      { id: 'username', label: 'username', type: 'STRING', value: 'example-user' },
      { id: 'password', label: 'password', type: 'CONCEALED', value: OP_CONNECT_SECRET_VALUE },
    ],
  },
};

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** Starts an in-test 1Password Connect HTTP server (vaults/items/detail). */
export function startFakeOnepassword(expectedToken = OP_CONNECT_TOKEN): Promise<FakeOnepassword> {
  const requests: FakeOnepassword['requests'] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : null;
    requests.push({ method: req.method ?? 'GET', path: url.pathname, authorization });
    if (authorization !== `Bearer ${expectedToken}`) {
      sendJson(res, 401, { message: 'invalid token' });
      return;
    }
    if (url.pathname === '/v1/vaults') {
      sendJson(res, 200, FAKE_VAULTS);
      return;
    }
    const listMatch = /^\/v1\/vaults\/([^/]+)\/items$/.exec(url.pathname);
    if (listMatch !== null) {
      const vaultId = decodeURIComponent(listMatch[1] as string);
      if (vaultId !== 'vault1') {
        sendJson(res, 404, { message: 'vault not found' });
        return;
      }
      const filter = (url.searchParams.get('filter') ?? '').toLowerCase();
      const items = FAKE_ITEMS.filter(
        (item) => filter.length === 0 || item.title.toLowerCase().includes(filter),
      );
      sendJson(res, 200, items);
      return;
    }
    const detailMatch = /^\/v1\/vaults\/([^/]+)\/items\/([^/]+)$/.exec(url.pathname);
    if (detailMatch !== null) {
      const vaultId = decodeURIComponent(detailMatch[1] as string);
      const itemId = decodeURIComponent(detailMatch[2] as string);
      const detail = FAKE_ITEM_DETAILS[itemId];
      if (vaultId !== 'vault1' || detail === undefined) {
        sendJson(res, 404, { message: 'item not found' });
        return;
      }
      sendJson(res, 200, detail);
      return;
    }
    sendJson(res, 404, { message: 'not found' });
  });

  return new Promise<FakeOnepassword>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        expectedToken,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

export function gatewaySecretNameFor(provider: 'vaultwarden' | 'onepassword', field: string): string {
  return `CRED_${provider.toUpperCase()}_${field.toUpperCase()}`;
}

export type { CredentialProviderService };
