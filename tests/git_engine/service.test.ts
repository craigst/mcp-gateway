import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GatewayConfig } from '../../src/core/config.js';
import { openDatabase } from '../../src/core/db.js';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import type { CatalogRepository } from '../../src/core/ports.js';
import type { ServerRecord } from '../../src/core/types.js';
import { GitImportService } from '../../src/git_engine/service.js';
import { SqliteVaultService } from '../../src/vault/store.js';

const FIXTURE_REPO_DIR = fileURLToPath(new URL('../fixtures/manifest-repo', import.meta.url));
const VAULT_SECRET = 'service-test-vault-secret-0123456789';
const TOKEN_NAME = 'FIXTURE_API_TOKEN';

interface ServiceHarness {
  root: string;
  config: GatewayConfig;
  vault: SqliteVaultService;
  persist: ReturnType<typeof vi.fn<(server: ServerRecord) => void>>;
  repository: { upsertServer: ReturnType<typeof vi.fn>; getServerByName: ReturnType<typeof vi.fn> } | undefined;
  service: GitImportService;
}

const dbs: DatabaseSync[] = [];
const testRoots: string[] = [];

let sharedRoot: string;
let sourceRepoDir: string;
let sourceRepoUrl: string;

function runGit(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

beforeAll(() => {
  sharedRoot = mkdtempSync(join(tmpdir(), 'mcp-git-fixture-'));
  sourceRepoDir = join(sharedRoot, 'manifest-repo');
  cpSync(FIXTURE_REPO_DIR, sourceRepoDir, { recursive: true });

  // The fixture is deliberately not a git repository; the tests create one.
  runGit(['init', '-b', 'main'], sourceRepoDir);
  runGit(['add', '-A'], sourceRepoDir);
  runGit(
    [
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'user.name=Manifest Fixture',
      'commit',
      '-m',
      'fixture: initial commit',
    ],
    sourceRepoDir,
  );
  sourceRepoUrl = pathToFileURL(sourceRepoDir).href;
});

afterAll(() => {
  rmSync(sharedRoot, { recursive: true, force: true });
});

beforeEach(() => {
  testRoots.push(mkdtempSync(join(tmpdir(), 'mcp-git-service-')));
});

afterEach(() => {
  while (dbs.length > 0) {
    const db = dbs.pop();
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
  while (testRoots.length > 0) {
    const dir = testRoots.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function makeConfig(root: string, overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir: join(root, 'data'),
    dbPath: join(root, 'data', 'gateway.db'),
    uiDistDir: join(root, 'ui'),
    vaultSecret: VAULT_SECRET,
    bootstrapMasterKey: null,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: ['file://'],
    reposDir: join(root, 'repos'),
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 60_000,
    keyPepper: null,
    publicBaseUrl: 'http://127.0.0.1:8080',
    ...overrides,
  };
}

function makeHarness(
  options: {
    root?: string;
    configOverrides?: Partial<GatewayConfig>;
    secret?: string | null;
    withRepository?: boolean;
  } = {},
): ServiceHarness {
  const root = options.root ?? testRoots[testRoots.length - 1]!;
  const config = makeConfig(root, options.configOverrides);

  const db = openDatabase(':memory:');
  dbs.push(db);
  const vault = new SqliteVaultService(db, options.secret === undefined ? VAULT_SECRET : options.secret);

  const persist = vi.fn<(server: ServerRecord) => void>();
  const repository = options.withRepository
    ? { upsertServer: vi.fn(), getServerByName: vi.fn(() => null) }
    : undefined;

  const service = new GitImportService({
    config,
    vault,
    persist,
    repository: repository as unknown as CatalogRepository | undefined,
  });

  return { root, config, vault, persist, repository, service };
}

async function captureGatewayError(promise: Promise<unknown>): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }
  throw new Error('expected the import to reject with a GatewayError');
}

function cloneDir(harness: ServiceHarness, name = 'manifest-repo'): string {
  return join(harness.config.reposDir, name);
}

describe('GitImportService', () => {
  it('clones, builds and registers a server from a local fixture repository', async () => {
    const harness = makeHarness({ withRepository: true });
    harness.vault.setSecret(TOKEN_NAME, 'test-token-value');

    const record = await harness.service.importRepository({ url: sourceRepoUrl });
    const targetDir = cloneDir(harness);

    expect(existsSync(join(targetDir, 'mcp-manifest.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'scripts', 'build.mjs'))).toBe(true);

    const built = JSON.parse(readFileSync(join(targetDir, 'built.txt'), 'utf8')) as Record<string, unknown>;
    expect(built).toEqual({ built: true, mode: 'test', hasToken: true });

    expect(record.id).toMatch(/^srv_[0-9a-f]{16}$/);
    expect(record.name).toBe('manifest-repo');
    expect(record.runtime).toBe('node');
    expect(record.transport).toBe('stdio');
    expect(record.status).toBe('stopped');
    expect(record.command).toBe('node');
    expect(record.args).toEqual(['server.mjs', '--stdio']);
    expect(record.url).toBeNull();
    expect(record.workDir).toBe(targetDir);
    expect(record.sourceUrl).toBe(sourceRepoUrl);
    expect(record.env).toEqual({ FIXTURE_MODE: 'test', DEFAULT_BRANCH: 'main' });
    expect(record.manifest?.name).toBe('fixture-echo-server');
    expect(record.manifest?.version).toBe('1.0.0');
    expect(record.manifest?.start_command).toBe('node server.mjs --stdio');
    expect(record.highPrivilegeTools).toEqual(['danger_delete']);
    expect(record.delegationSupported).toBe(true);
    expect(record.lastError).toBeNull();
    expect(record.pid).toBeNull();
    expect(new Date(record.createdAt).toISOString()).toBe(record.createdAt);
    expect(new Date(record.updatedAt).toISOString()).toBe(record.updatedAt);

    // Secrets are injected into the build environment but never persisted.
    expect(JSON.stringify(record)).not.toContain('test-token-value');

    expect(harness.persist).toHaveBeenCalledTimes(1);
    expect(harness.persist).toHaveBeenCalledWith(record);
    expect(harness.repository?.upsertServer).toHaveBeenCalledTimes(1);
    expect(harness.repository?.upsertServer).toHaveBeenCalledWith(record);
  });

  it('honours an explicit server name override', async () => {
    const harness = makeHarness();
    harness.vault.setSecret(TOKEN_NAME, 'token');

    const record = await harness.service.importRepository({
      url: sourceRepoUrl,
      name: 'custom-server-01',
    });

    expect(record.name).toBe('custom-server-01');
    expect(record.workDir).toBe(cloneDir(harness, 'custom-server-01'));
    expect(existsSync(join(cloneDir(harness, 'custom-server-01'), 'built.txt'))).toBe(true);
  });

  it('rejects an empty URL before doing any work', async () => {
    const harness = makeHarness();
    const error = await captureGatewayError(harness.service.importRepository({ url: '   ' }));
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(existsSync(harness.config.reposDir)).toBe(false);
  });

  it('rejects a disallowed clone URL before creating the repos directory', async () => {
    const harness = makeHarness({
      configOverrides: { gitImportAllowedPrefixes: ['https://github.com/'] },
    });
    const error = await captureGatewayError(
      harness.service.importRepository({ url: sourceRepoUrl }),
    );
    expect(error.code).toBe(ErrorCodes.ACCESS_DENIED);
    expect(error.message).toContain('allowed import prefixes');
    expect(existsSync(harness.config.reposDir)).toBe(false);
  });

  it('disables imports entirely when the allowlist is empty', async () => {
    const harness = makeHarness({ configOverrides: { gitImportAllowedPrefixes: [] } });
    const error = await captureGatewayError(
      harness.service.importRepository({ url: sourceRepoUrl }),
    );
    expect(error.code).toBe(ErrorCodes.ACCESS_DENIED);
    expect(error.message).toBe('Git import is disabled');
    expect(existsSync(harness.config.reposDir)).toBe(false);
  });

  it.each(['BadName', 'has space', '-leading-dash', 'a.dot', 'traversal/../name', 'x'.repeat(65)])(
    'rejects invalid server name %j before cloning',
    async (name) => {
      const harness = makeHarness();
      const error = await captureGatewayError(
        harness.service.importRepository({ url: sourceRepoUrl, name }),
      );
      expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
      expect(existsSync(harness.config.reposDir)).toBe(false);
    },
  );

  it('refuses to overwrite an existing target directory', async () => {
    const harness = makeHarness();
    const targetDir = cloneDir(harness);
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'existing.txt'), 'do not touch');

    const error = await captureGatewayError(
      harness.service.importRepository({ url: sourceRepoUrl }),
    );
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(error.message).toContain('already exists');
    expect(readFileSync(join(targetDir, 'existing.txt'), 'utf8')).toBe('do not touch');
  });

  it('rejects when required vault secrets are missing and rolls back the clone', async () => {
    const harness = makeHarness();
    // Vault is enabled but FIXTURE_API_TOKEN was never set.
    const error = await captureGatewayError(
      harness.service.importRepository({ url: sourceRepoUrl }),
    );
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(error.message).toContain(TOKEN_NAME);
    expect(existsSync(cloneDir(harness))).toBe(false);
    expect(harness.persist).not.toHaveBeenCalled();
  });

  it('cleans up and reports a failing build', async () => {
    const harness = makeHarness();
    harness.vault.setSecret(TOKEN_NAME, 'token');

    const error = await captureGatewayError(
      harness.service.importRepository({ url: sourceRepoUrl, buildCommand: 'node scripts/fail.mjs' }),
    );
    expect(error.code).toBe(ErrorCodes.UPSTREAM_ERROR);
    expect(error.message).toContain('Build failed');
    expect(error.message).toContain('fixture build failure');
    expect(existsSync(cloneDir(harness))).toBe(false);
    expect(harness.persist).not.toHaveBeenCalled();
  });

  it('cleans up and reports a clone failure', async () => {
    const harness = makeHarness();
    const missingUrl = pathToFileURL(join(sharedRoot, 'does-not-exist')).href;

    const error = await captureGatewayError(
      harness.service.importRepository({ url: missingUrl }),
    );
    expect(error.code).toBe(ErrorCodes.UPSTREAM_ERROR);
    expect(error.message).toContain('git clone failed');
    expect(existsSync(join(harness.config.reposDir, 'does-not-exist'))).toBe(false);
  });

  it('rejects repositories without a valid manifest and rolls back', async () => {
    const harness = makeHarness();
    const repoWithoutManifest = join(harness.root, 'no-manifest-repo');
    mkdirSync(repoWithoutManifest, { recursive: true });
    writeFileSync(join(repoWithoutManifest, 'README.md'), '# no manifest here\n');
    runGit(['init', '-b', 'main'], repoWithoutManifest);
    runGit(['add', '-A'], repoWithoutManifest);
    runGit(
      [
        '-c',
        'user.email=fixture@example.com',
        '-c',
        'user.name=Manifest Fixture',
        'commit',
        '-m',
        'no manifest',
      ],
      repoWithoutManifest,
    );

    const error = await captureGatewayError(
      harness.service.importRepository({ url: pathToFileURL(repoWithoutManifest).href }),
    );
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(error.message).toContain('mcp-manifest.json');
    expect(existsSync(join(harness.config.reposDir, 'no-manifest-repo'))).toBe(false);
    expect(harness.persist).not.toHaveBeenCalled();
  });
});
