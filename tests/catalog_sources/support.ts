/**
 * Shared harness for catalog-source tests.
 *
 * Builds an in-memory SQLite database with the real schema, a real AES vault
 * (test-only secret), the real catalog repository/supervisor and the
 * `GitPluginCatalog` service. Fixtures are copied into per-test temp dirs and
 * turned into local git repositories so tests never touch the network and never
 * contain personal paths.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DatabaseSync } from 'node:sqlite';

import type { GatewayConfig } from '../../src/core/config.js';
import { openDatabase } from '../../src/core/db.js';
import type { Logger } from '../../src/core/logger.js';
import { nowIso } from '../../src/core/ids.js';
import type { CatalogRepository, Supervisor } from '../../src/core/ports.js';
import type { ServerManifest, ServerRecord } from '../../src/core/types.js';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';
import { GitPluginCatalog } from '../../src/catalog_sources/service.js';
import { DefaultSupervisor } from '../../src/gateway/supervisor.js';
import { SqliteVaultService } from '../../src/vault/store.js';

export const CATALOG_VAULT_SECRET = 'catalog-test-vault-secret-0123456789';
export const CATALOG_TEST_TOKEN = 'ghp_catalog_test_token_0123456789';

export interface CatalogHarness {
  root: string;
  config: GatewayConfig;
  db: DatabaseSync;
  vault: SqliteVaultService;
  repository: CatalogRepository;
  supervisor: Supervisor;
  service: GitPluginCatalog;
  dispose(): Promise<void>;
}

export function makeConfig(root: string, overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir: join(root, 'data'),
    dbPath: join(root, 'data', 'gateway.db'),
    uiDistDir: join(root, 'ui'),
    vaultSecret: CATALOG_VAULT_SECRET,
    bootstrapMasterKey: null,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: ['file://'],
    reposDir: join(root, 'repos'),
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 30_000,
    keyPepper: null,
    publicBaseUrl: 'http://127.0.0.1:8080',
    ...overrides,
  };
}

export function createCatalogHarness(
  root: string,
  overrides: Partial<GatewayConfig> = {},
  logger?: Logger,
): CatalogHarness {
  const config = makeConfig(root, overrides);
  const db = openDatabase(':memory:');
  const vault = new SqliteVaultService(db, CATALOG_VAULT_SECRET);
  const repository = new SqliteCatalogRepository(db);
  const supervisor = new DefaultSupervisor({ repository, config, vault, logger });
  const service = new GitPluginCatalog({ db, config, repository, vault, supervisor, logger });

  return {
    root,
    config,
    db,
    vault,
    repository,
    supervisor,
    service,
    dispose: async () => {
      try {
        await supervisor.shutdown();
      } finally {
        db.close();
      }
    },
  };
}

/** Copies a fixture directory into `target` (which must not exist). */
export function copyFixture(name: string, target: string): string {
  const source = new URL(`../fixtures/${name}`, import.meta.url);
  cpSync(source, target, { recursive: true });
  return target;
}

export function toFileUrl(path: string): string {
  return pathToFileURL(path).href;
}

export function gitInitRepo(dir: string, message = 'fixture: initial commit'): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync(
    'git',
    ['-c', 'user.email=fixture@example.com', '-c', 'user.name=Fixture', 'commit', '-m', message],
    { cwd: dir, stdio: 'pipe' },
  );
}

/** Creates a fresh temp directory owned by the caller (cleaned up by the test). */
export function makeTempDir(prefix = 'mcp-catalog-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Creates a child directory inside a test root. */
export function makeDir(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Minimal persisted `ServerRecord` for installed-matching tests. */
export function makeServerRecord(overrides: Partial<ServerRecord> & { name: string }): ServerRecord {
  const now = nowIso();
  const manifest: ServerManifest = overrides.manifest ?? {
    name: overrides.name,
    version: '0.0.0',
    runtime: 'node20',
    start_command: 'node server.js',
  };
  const base: ServerRecord = {
    id: `srv_${overrides.name.replace(/[^a-z0-9]/gi, '').slice(0, 16).padEnd(16, '0')}`,
    name: overrides.name,
    runtime: 'node',
    transport: 'stdio',
    status: 'stopped',
    command: 'node',
    args: ['server.js'],
    url: null,
    env: {},
    manifest,
    highPrivilegeTools: [],
    delegationSupported: false,
    sourceUrl: null,
    workDir: null,
    envFile: null,
    approvalRequiredTools: [],
    lastError: null,
    pid: null,
    createdAt: now,
    updatedAt: now,
  };
  return { ...base, ...overrides, manifest };
}
