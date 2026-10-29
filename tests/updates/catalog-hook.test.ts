import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../../src/core/db.js';
import type { ServerSourceRecordInput } from '../../src/core/ports.js';
import { GitPluginCatalog } from '../../src/catalog_sources/service.js';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';
import { DefaultSupervisor } from '../../src/gateway/supervisor.js';
import { SqliteVaultService } from '../../src/vault/store.js';
import {
  gitInitRepo,
  makeRoot,
  makeUpdateConfig,
  removeRoot,
  toFileUrl,
} from './support.js';

const NODE_FIXTURE = fileURLToPath(new URL('../fixtures/catalog/node-repo', import.meta.url));

const roots: string[] = [];
const dbs: DatabaseSync[] = [];
const disposers: Array<() => Promise<void>> = [];

beforeEach(() => {
  roots.push(makeRoot('updates-hook-'));
});

afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.();
  while (dbs.length > 0) dbs.pop()?.close();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) removeRoot(root);
  }
});

function setupCatalog(onServerSource?: (input: ServerSourceRecordInput) => void): {
  service: GitPluginCatalog;
  repository: SqliteCatalogRepository;
} {
  const root = roots[roots.length - 1] as string;
  const config = makeUpdateConfig(root);
  const db = openDatabase(':memory:');
  dbs.push(db);
  const vault = new SqliteVaultService(db, 'catalog-hook-vault-secret-0123456789');
  const repository = new SqliteCatalogRepository(db);
  const supervisor = new DefaultSupervisor({ repository, config, vault });
  disposers.push(async () => {
    await supervisor.shutdown();
  });
  const service = new GitPluginCatalog({
    db,
    config,
    repository,
    vault,
    supervisor,
    onServerSource,
  });
  return { service, repository };
}

function createNodeRepo(root: string, name: string): string {
  const repoDir = join(root, name);
  cpSync(NODE_FIXTURE, repoDir, { recursive: true });
  gitInitRepo(repoDir);
  return repoDir;
}

describe('catalog install → update source hook', () => {
  it('reports a catalog-tracked source after install', async () => {
    const onServerSource = vi.fn<(input: ServerSourceRecordInput) => void>();
    const { service } = setupCatalog(onServerSource);
    const root = roots[roots.length - 1] as string;
    const repoDir = createNodeRepo(root, 'node-repo');
    const source = await service.addSource({
      label: 'Example github repo',
      kind: 'github-repo',
      repoUrl: toFileUrl(repoDir),
      ref: 'main',
    });

    const result = await service.install({
      sourceId: source.id,
      entryId: 'node-repo',
      start: false,
      test: false,
    });

    expect(onServerSource).toHaveBeenCalledTimes(1);
    expect(onServerSource).toHaveBeenCalledWith({
      serverId: result.server.id,
      sourceKind: 'catalog',
      catalogSourceId: source.id,
      catalogEntryId: 'node-repo',
      repoUrl: toFileUrl(repoDir),
      requestedRef: 'main',
      installedVersion: '1.0.0',
    });
  });

  it('reports a plain git source after importUrl', async () => {
    const onServerSource = vi.fn<(input: ServerSourceRecordInput) => void>();
    const { service } = setupCatalog(onServerSource);
    const root = roots[roots.length - 1] as string;
    const repoDir = createNodeRepo(root, 'imported-repo');

    const result = await service.importUrl({
      url: toFileUrl(repoDir),
      name: 'imported-node',
      start: false,
      test: false,
    });

    expect(onServerSource).toHaveBeenCalledWith({
      serverId: result.server.id,
      sourceKind: 'git',
      catalogSourceId: null,
      catalogEntryId: null,
      repoUrl: toFileUrl(repoDir),
      requestedRef: null,
      installedVersion: '1.0.0',
    });
  });

  it('never fails the install when the update hook throws', async () => {
    const { service } = setupCatalog(() => {
      throw new Error('tracker unavailable');
    });
    const root = roots[roots.length - 1] as string;
    const repoDir = createNodeRepo(root, 'hook-throws');
    const source = await service.addSource({
      label: 'Example github repo',
      kind: 'github-repo',
      repoUrl: toFileUrl(repoDir),
    });

    const result = await service.install({
      sourceId: source.id,
      entryId: 'hook-throws',
      start: false,
      test: false,
    });
    expect(result.server.name).toBe('hook-throws');
    expect(result.server.status).toBe('stopped');
  });
});
