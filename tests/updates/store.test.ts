import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../../src/core/db.js';
import { nowIso } from '../../src/core/ids.js';
import type { ServerRecord, ServerSourceInfo } from '../../src/core/types.js';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';
import {
  resolveInstalledCommit,
  resolveInstalledVersion,
  SqliteServerSourceStore,
} from '../../src/updates/store.js';
import { createUpstreamRepo, gitTag, makeRoot, removeRoot } from './support.js';

const roots: string[] = [];
const dbs: DatabaseSync[] = [];

beforeEach(() => {
  roots.push(makeRoot('updates-store-'));
});

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) removeRoot(root);
  }
});

function track(db: DatabaseSync): DatabaseSync {
  dbs.push(db);
  return db;
}

function seedServer(db: DatabaseSync, id: string, name = 'tracked-server'): void {
  const now = nowIso();
  const record: ServerRecord = {
    id,
    name,
    runtime: 'node',
    transport: 'stdio',
    status: 'stopped',
    command: 'node',
    args: ['server.js'],
    url: null,
    env: {},
    headers: {},
    manifest: { name, version: '1.0.0', runtime: 'node20', start_command: 'node server.js' },
    highPrivilegeTools: [],
    delegationSupported: false,
    sourceUrl: 'https://github.com/example/update-fixture',
    workDir: null,
    envFile: null,
    approvalRequiredTools: [],
    configProfileIds: [],
    lastError: null,
    pid: null,
    createdAt: now,
    updatedAt: now,
  };
  new SqliteCatalogRepository(db).upsertServer(record);
}

function sampleSource(overrides: Partial<ServerSourceInfo> = {}): ServerSourceInfo {
  return {
    serverId: 'srv_test000000001',
    sourceKind: 'git',
    catalogSourceId: null,
    catalogEntryId: null,
    repoUrl: 'https://github.com/example/update-fixture',
    requestedRef: 'main',
    installedCommit: 'a'.repeat(40),
    installedVersion: '1.0.0',
    latestCommit: null,
    latestVersion: null,
    latestRef: null,
    updateAvailable: false,
    checkedAt: null,
    checkError: null,
    changelogUrl: null,
    ...overrides,
  };
}

describe('SqliteServerSourceStore', () => {
  it('round-trips a source row and lists it', () => {
    const db = track(openDatabase(':memory:'));
    const store = new SqliteServerSourceStore(db);
    seedServer(db, 'srv_test000000001');
    const source = sampleSource({
      catalogSourceId: 'cat_ab12',
      catalogEntryId: 'brain-mcp',
      changelogUrl: 'https://github.com/example/update-fixture/releases',
    });

    store.upsert(source);
    expect(store.get(source.serverId)).toEqual(source);
    expect(store.list()).toEqual([source]);
  });

  it('patches check state without losing installed fields', () => {
    const db = track(openDatabase(':memory:'));
    const store = new SqliteServerSourceStore(db);
    seedServer(db, 'srv_test000000001');
    const source = sampleSource();
    store.upsert(source);

    const patched = store.patch(source.serverId, {
      latestCommit: 'b'.repeat(40),
      latestVersion: '2.0.0',
      latestRef: 'v2.0.0',
      updateAvailable: true,
      checkedAt: nowIso(),
      checkError: null,
    });

    expect(patched).toMatchObject({
      serverId: source.serverId,
      installedCommit: source.installedCommit,
      installedVersion: '1.0.0',
      latestCommit: 'b'.repeat(40),
      latestVersion: '2.0.0',
      updateAvailable: true,
    });
    expect(store.get(source.serverId)?.updateAvailable).toBe(true);
    expect(store.patch('srv_missing', { updateAvailable: true })).toBeNull();
  });

  it('upserts (idempotent) and deletes', () => {
    const db = track(openDatabase(':memory:'));
    const store = new SqliteServerSourceStore(db);
    seedServer(db, 'srv_test000000001');
    store.upsert(sampleSource({ installedVersion: '1.0.0' }));
    store.upsert(sampleSource({ installedVersion: '1.1.0' }));

    expect(store.list()).toHaveLength(1);
    expect(store.get('srv_test000000001')?.installedVersion).toBe('1.1.0');
    expect(store.delete('srv_test000000001')).toBe(true);
    expect(store.delete('srv_test000000001')).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('rejects rows without a repository URL', () => {
    const db = track(openDatabase(':memory:'));
    const store = new SqliteServerSourceStore(db);
    seedServer(db, 'srv_test000000001');
    expect(() => store.upsert(sampleSource({ repoUrl: '   ' }))).toThrow();
  });
});

describe('installed version/commit resolution', () => {
  it('reads the commit from the checked-out git repository', () => {
    const root = roots[roots.length - 1] as string;
    const repoDir = createUpstreamRepo(root);
    gitTag(repoDir, 'v1.0.0');

    const commit = resolveInstalledCommit(repoDir);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(resolveInstalledCommit(join(root, 'not-a-repo'))).toBeNull();
    expect(resolveInstalledCommit(null)).toBeNull();
  });

  it('prefers the manifest version and falls back to package.json', () => {
    const root = roots[roots.length - 1] as string;
    const repoDir = createUpstreamRepo(root);

    expect(
      resolveInstalledVersion({
        manifest: { name: 'x', version: '9.9.9', runtime: 'node20', start_command: 'node server.js' },
        workDir: repoDir,
      }),
    ).toBe('9.9.9');

    expect(resolveInstalledVersion({ manifest: null, workDir: repoDir })).toBe('1.0.0');
    expect(resolveInstalledVersion({ manifest: null, workDir: join(root, 'missing') })).toBeNull();
  });
});
