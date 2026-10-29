/**
 * Shared harness for v0.4 update-tracking tests.
 *
 * Uses the real SQLite schema, real AES vault, real catalog repository,
 * supervisor and Git import engine. Upstream repositories are local
 * `file://` git repos under `.test-data/` so tests are deterministic and never
 * touch the network.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

import type { GatewayConfig } from '../../src/core/config.js';
import { openDatabase } from '../../src/core/db.js';
import type { Logger } from '../../src/core/logger.js';
import type { PluginCatalogService, Supervisor } from '../../src/core/ports.js';
import type { ServerRecord } from '../../src/core/types.js';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';
import { DefaultSupervisor } from '../../src/gateway/supervisor.js';
import { GitImportService } from '../../src/git_engine/service.js';
import { DefaultServerUpdateService } from '../../src/updates/service.js';
import { SqliteVaultService } from '../../src/vault/store.js';

export const UPDATE_VAULT_SECRET = 'update-test-vault-secret-0123456789';
export const TEST_DATA_DIR = join(process.cwd(), '.test-data');

export interface UpdateHarness {
  root: string;
  config: GatewayConfig;
  db: DatabaseSync;
  vault: SqliteVaultService;
  repository: SqliteCatalogRepository;
  supervisor: Supervisor;
  git: GitImportService;
  updates: DefaultServerUpdateService;
  dispose(): Promise<void>;
}

export function makeUpdateConfig(root: string, overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir: join(root, 'data'),
    dbPath: join(root, 'data', 'gateway.db'),
    uiDistDir: join(root, 'ui'),
    vaultSecret: UPDATE_VAULT_SECRET,
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

export interface CreateHarnessOptions {
  configOverrides?: Partial<GatewayConfig>;
  catalog?: PluginCatalogService;
  logger?: Logger;
}

export function createUpdateHarness(root: string, options: CreateHarnessOptions = {}): UpdateHarness {
  const config = makeUpdateConfig(root, options.configOverrides);
  const db = openDatabase(':memory:');
  const vault = new SqliteVaultService(db, UPDATE_VAULT_SECRET);
  const repository = new SqliteCatalogRepository(db);
  const supervisor = new DefaultSupervisor({ repository, config, vault, logger: options.logger });
  const git = new GitImportService({ config, repository, vault, logger: options.logger });
  const updates = new DefaultServerUpdateService({
    db,
    config,
    repository,
    supervisor,
    vault,
    catalog: options.catalog,
    git,
    logger: options.logger,
  });

  return {
    root,
    config,
    db,
    vault,
    repository,
    supervisor,
    git,
    updates,
    dispose: async () => {
      try {
        await supervisor.shutdown();
      } finally {
        db.close();
      }
    },
  };
}

/** Creates a unique test root under `.test-data/` (gitignored). */
export function makeRoot(prefix = 'updates-'): string {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  return mkdtempSync(join(TEST_DATA_DIR, prefix));
}

export function removeRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

export function toFileUrl(path: string): string {
  return pathToFileURL(path).href;
}

/** Copies the v1 update-repo fixture and turns it into a git repository. */
export function createUpstreamRepo(root: string, name = 'upstream'): string {
  const repoDir = join(root, name);
  cpSync(fixturePath('update-repo'), repoDir, { recursive: true });
  gitInitRepo(repoDir);
  return repoDir;
}

/** Overlays the v2 fixture (version bump + `update_marker` tool) and commits. */
export function commitV2(repoDir: string, message = 'v2: add update_marker tool'): void {
  cpSync(fixturePath('update-repo/v2'), repoDir, { recursive: true, force: true });
  gitCommitAll(repoDir, message);
}

/** Overlays the broken-build manifest and commits. */
export function commitBrokenBuild(repoDir: string, message = 'v2: broken build'): void {
  cpSync(fixturePath('update-repo/broken'), repoDir, { recursive: true, force: true });
  gitCommitAll(repoDir, message);
}

export function gitInitRepo(dir: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  gitCommitAll(dir, 'fixture: initial commit');
}

export function gitCommitAll(dir: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync(
    'git',
    ['-c', 'user.email=fixture@example.com', '-c', 'user.name=Fixture', 'commit', '-m', message],
    { cwd: dir, stdio: 'pipe' },
  );
}

export function gitTag(dir: string, tag: string): void {
  execFileSync('git', ['tag', tag], { cwd: dir, stdio: 'pipe' });
}

export function gitHead(dir: string): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim();
}

export interface InstallOptions {
  name?: string;
  ref?: string | null;
  start?: boolean;
}

/**
 * Installs the fixture through the real Git import engine and records its
 * source, mirroring the catalog install → update-tracker hook flow.
 */
export async function installTracked(
  harness: UpdateHarness,
  repoDir: string,
  options: InstallOptions = {},
): Promise<ServerRecord> {
  const url = toFileUrl(repoDir);
  const server = await harness.git.importRepository({
    url,
    name: options.name ?? 'update-fixture',
    ref: options.ref ?? null,
  });
  harness.updates.recordSource({
    serverId: server.id,
    sourceKind: 'git',
    repoUrl: url,
    requestedRef: options.ref ?? null,
  });
  if (options.start === true) await harness.supervisor.start(server.id);
  return harness.repository.getServer(server.id) ?? server;
}

/** Lists the entries of the repos directory (sorted). */
export function listReposDir(reposDir: string): string[] {
  try {
    return readdirSync(reposDir).sort();
  } catch {
    return [];
  }
}

/** Ensures no leftover staging/backup directories remain after an update. */
export function listUpdateArtifacts(reposDir: string): string[] {
  return listReposDir(reposDir).filter((name) => name.startsWith('.update-') || name.includes('.old-'));
}

/** Creates a minimal persisted server record (used by backfill/admin tests). */
export function seedServerRecord(
  harness: UpdateHarness,
  overrides: Partial<ServerRecord> & { name: string },
): ServerRecord {
  const now = new Date().toISOString();
  const manifest = overrides.manifest ?? {
    name: overrides.name,
    version: '1.0.0',
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
    headers: {},
    manifest,
    highPrivilegeTools: [],
    delegationSupported: false,
    sourceUrl: null,
    workDir: null,
    envFile: null,
    approvalRequiredTools: [],
    configProfileIds: [],
    lastError: null,
    pid: null,
    createdAt: now,
    updatedAt: now,
  };
  const record: ServerRecord = { ...base, ...overrides, manifest };
  harness.repository.upsertServer(record);
  return record;
}
