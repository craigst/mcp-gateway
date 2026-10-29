import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GatewayConfig } from '../../src/core/config.js';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import type { Logger } from '../../src/core/logger.js';
import type { VaultService } from '../../src/core/ports.js';
import { GitPluginCatalog, catalogTokenSecretName } from '../../src/catalog_sources/service.js';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';
import { DefaultSupervisor } from '../../src/gateway/supervisor.js';
import { scrubSecrets } from '../../src/git_engine/clone.js';
import { SqliteVaultService } from '../../src/vault/store.js';
import {
  createCatalogHarness,
  gitInitRepo,
  makeTempDir,
  toFileUrl,
  type CatalogHarness,
} from './support.js';

const NODE_FIXTURE = fileURLToPath(new URL('../fixtures/catalog/node-repo', import.meta.url));
const TOKEN = 'ghp_private_catalog_token_0123456789abcdef';
const AMBIENT_TOKEN = 'ghp_ambient_env_token_0123456789abcdef';

interface RecordingLogger {
  logger: Logger;
  records: Array<{ level: string; message: string; context?: Record<string, unknown> }>;
}

function createRecordingLogger(): RecordingLogger {
  const records: RecordingLogger['records'] = [];
  const logger: Logger = {
    module: 'catalog-test',
    debug: (message, context) => records.push({ level: 'debug', message, context }),
    info: (message, context) => records.push({ level: 'info', message, context }),
    warn: (message, context) => records.push({ level: 'warn', message, context }),
    error: (message, context) => records.push({ level: 'error', message, context }),
    child: () => logger,
  };
  return { logger, records };
}

const harnesses: CatalogHarness[] = [];
const tempDirs: string[] = [];

beforeEach(() => {
  tempDirs.push(makeTempDir('mcp-catalog-token-'));
});

afterEach(async () => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  while (harnesses.length > 0) {
    await harnesses.pop()?.dispose();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function setup(): { harness: CatalogHarness; root: string; recording: RecordingLogger } {
  const root = tempDirs[tempDirs.length - 1] as string;
  const recording = createRecordingLogger();
  const harness = createCatalogHarness(root, {}, recording.logger);
  harnesses.push(harness);
  return { harness, root, recording };
}

function dbDump(harness: CatalogHarness): string {
  const sources = harness.db.prepare('SELECT * FROM catalog_sources').all();
  const secrets = harness.db.prepare('SELECT * FROM vault_secrets').all();
  return JSON.stringify({ sources, secrets });
}

function assertNoToken(value: unknown, token: string): void {
  expect(JSON.stringify(value)).not.toContain(token);
}

function capture(promise: Promise<unknown>): Promise<GatewayError> {
  return promise.then(
    () => {
      throw new Error('expected the call to reject with a GatewayError');
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(GatewayError);
      return error as GatewayError;
    },
  );
}

describe('catalog token handling', () => {
  it('stores the token in the AES vault and never returns it from sources', async () => {
    const { harness, recording } = setup();
    const repoDir = join(harness.root, 'umbrella');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, 'README.md'), '# private umbrella\n');
    gitInitRepo(repoDir);

    const source = await harness.service.addSource({
      label: 'Private umbrella',
      kind: 'dsh-umbrella',
      repoUrl: toFileUrl(repoDir),
      ref: 'main',
      token: TOKEN,
    });

    // The API shape exposes only the vault secret NAME.
    expect(source.tokenSecretName).toBe(catalogTokenSecretName(source.id));
    expect(source.tokenSecretName).toBe(`CATALOG_${source.id}_TOKEN`);
    expect(harness.vault.getSecret(source.tokenSecretName as string)).toBe(TOKEN);
    assertNoToken(source, TOKEN);

    const sources = harness.service.listSources();
    expect(sources).toHaveLength(1);
    assertNoToken(sources, TOKEN);

    // Token lives in the vault only: not in the catalog table, not in plaintext
    // in the vault table, and never in log records.
    const dump = dbDump(harness);
    expect(dump).not.toContain(TOKEN);
    expect(dump).toContain('CATALOG_');
    const rawSources = JSON.stringify(harness.db.prepare('SELECT * FROM catalog_sources').all());
    expect(rawSources).toContain(source.tokenSecretName as string);
    assertNoToken(recording.records, TOKEN);
  });

  it('never leaks the token through provider errors', async () => {
    const { harness, root, recording } = setup();
    // A missing private repository forces a clone failure whose stderr is scrubbed.
    const source = await harness.service.addSource({
      label: 'Private umbrella',
      kind: 'dsh-umbrella',
      repoUrl: toFileUrl(join(root, 'does-not-exist')),
      token: TOKEN,
    });

    const error = await capture(harness.service.listEntries(source.id));
    expect(error.code).toBe(ErrorCodes.UPSTREAM_ERROR);
    expect(error.message).not.toContain(TOKEN);
    assertNoToken(error, TOKEN);
    assertNoToken(error.data, TOKEN);
    assertNoToken(recording.records, TOKEN);
  });

  it('never leaks the token through listEntries or install errors', async () => {
    const { harness, root } = setup();
    const repoDir = join(root, 'node-repo');
    cpSync(NODE_FIXTURE, repoDir, { recursive: true });
    gitInitRepo(repoDir);

    const source = await harness.service.addSource({
      label: 'Node repo',
      kind: 'github-repo',
      repoUrl: toFileUrl(repoDir),
      token: TOKEN,
    });
    const entries = await harness.service.listEntries(source.id);
    assertNoToken(entries, TOKEN);

    const error = await capture(
      harness.service.install({ sourceId: source.id, entryId: 'missing-entry' }),
    );
    expect(error.message).not.toContain(TOKEN);
    assertNoToken(error, TOKEN);
  });

  it('uses GITHUB_TOKEN/GH_TOKEN as an ambient fallback without exposing it', async () => {
    process.env.GITHUB_TOKEN = AMBIENT_TOKEN;
    const { harness, root } = setup();
    const source = await harness.service.addSource({
      label: 'Ambient token umbrella',
      kind: 'dsh-umbrella',
      repoUrl: toFileUrl(join(root, 'missing-umbrella')),
    });
    // No token was supplied, so nothing is stored in the vault.
    expect(source.tokenSecretName).toBeNull();
    assertNoToken(harness.service.listSources(), AMBIENT_TOKEN);

    const error = await capture(harness.service.listEntries(source.id));
    expect(error.message).not.toContain(AMBIENT_TOKEN);
    assertNoToken(error, AMBIENT_TOKEN);
    // The ambient token is never persisted either.
    expect(dbDump(harness)).not.toContain(AMBIENT_TOKEN);
  });

  it('rejects a token when the vault is disabled', async () => {
    const { harness } = setup();
    const config: GatewayConfig = { ...harness.config, vaultSecret: null };
    const vault: VaultService = new SqliteVaultService(harness.db, null);
    const repository = new SqliteCatalogRepository(harness.db);
    const supervisor = new DefaultSupervisor({ repository, config, vault });
    const service = new GitPluginCatalog({
      db: harness.db,
      config,
      repository,
      vault,
      supervisor,
    });

    const error = await capture(
      service.addSource({
        label: 'No vault',
        kind: 'github-repo',
        repoUrl: toFileUrl(join(harness.root, 'repo')),
        token: TOKEN,
      }),
    );
    expect(error.code).toBe(ErrorCodes.NOT_IMPLEMENTED);
    expect(error.message).toContain('MCP_VAULT_SECRET');
    expect(error.message).not.toContain(TOKEN);
    assertNoToken(service.listSources(), TOKEN);
  });

  it('does not store a token for file:// catalog-json sources', async () => {
    const { harness, root } = setup();
    const catalogJson = join(root, 'catalog.json');
    writeFileSync(catalogJson, JSON.stringify({ entries: [] }), 'utf8');
    const source = await harness.service.addSource({
      label: 'Public JSON catalog',
      kind: 'catalog-json',
      repoUrl: toFileUrl(catalogJson),
    });
    expect(source.tokenSecretName).toBeNull();
    expect(await harness.service.listEntries(source.id)).toEqual([]);
  });
});

describe('scrubSecrets', () => {
  it('redacts raw, base64 and header forms', () => {
    const encoded = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    const scrubbed = scrubSecrets(
      `token=${TOKEN} header=AUTHORIZATION: basic ${encoded}`,
      [TOKEN],
    );
    expect(scrubbed).not.toContain(TOKEN);
    expect(scrubbed).not.toContain(encoded);
    expect(scrubbed).toContain('[REDACTED]');
  });
});
