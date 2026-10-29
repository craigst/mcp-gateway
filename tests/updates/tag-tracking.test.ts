import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PluginCatalogService } from '../../src/core/ports.js';
import type { CatalogEntry, CatalogSource } from '../../src/core/types.js';
import {
  commitV2,
  createUpdateHarness,
  createUpstreamRepo,
  gitHead,
  gitTag,
  installTracked,
  makeRoot,
  removeRoot,
  type UpdateHarness,
} from './support.js';

const harnesses: UpdateHarness[] = [];
const roots: string[] = [];

beforeEach(() => {
  roots.push(makeRoot('updates-tags-'));
});

afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()?.dispose();
  }
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) removeRoot(root);
  }
});

function setup(): { harness: UpdateHarness; root: string } {
  const root = roots[roots.length - 1] as string;
  const harness = createUpdateHarness(root);
  harnesses.push(harness);
  return { harness, root };
}

function fakeCatalog(entries: CatalogEntry[], sourceId = 'cat_example'): PluginCatalogService {
  const source: CatalogSource = {
    id: sourceId,
    label: 'Example catalog',
    kind: 'github-repo',
    repoUrl: 'https://github.com/example/catalog',
    ref: null,
    subpath: null,
    tokenSecretName: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    listSources: () => [source],
    addSource: async () => source,
    removeSource: () => undefined,
    listEntries: async () => entries,
    install: async () => {
      throw new Error('not used');
    },
    importUrl: async () => {
      throw new Error('not used');
    },
  };
}

describe('semver-tag tracking', () => {
  it('reports the latest semver tag and updates to it', async () => {
    const { harness, root } = setup();
    const repoDir = createUpstreamRepo(root);
    const v1Commit = gitHead(repoDir);
    gitTag(repoDir, 'v1.0.0');

    const server = await installTracked(harness, repoDir, { ref: 'v1.0.0' });
    expect(server.manifest?.version).toBe('1.0.0');
    expect(harness.updates.get(server.id)?.requestedRef).toBe('v1.0.0');

    commitV2(repoDir);
    const v2Commit = gitHead(repoDir);
    gitTag(repoDir, 'v2.0.0');

    const check = await harness.updates.check(server.id);
    expect(check).toMatchObject({
      status: 'update-available',
      updateAvailable: true,
      fromVersion: '1.0.0',
      toVersion: 'v2.0.0',
      fromCommit: v1Commit,
      toCommit: v2Commit,
      latestRef: 'v2.0.0',
    });
    expect(harness.updates.get(server.id)?.latestVersion).toBe('v2.0.0');

    // A plain one-click update (no explicit ref) follows the checked latest tag
    // for tag-tracked servers; branch-tracked servers fall back to requestedRef.
    const result = await harness.updates.update(server.id, { restart: true, test: true });
    expect(result.after).toEqual({ version: '2.0.0', commit: v2Commit });
    expect(result.test).toMatchObject({ ok: true, toolCount: 6 });
    expect(harness.updates.get(server.id)).toMatchObject({
      installedCommit: v2Commit,
      installedVersion: '2.0.0',
      updateAvailable: false,
    });
  });

  it('flags an update when the catalog entry pins a different ref', async () => {
    const { root } = setup();
    const repoDir = createUpstreamRepo(root);
    const head = gitHead(repoDir);
    gitTag(repoDir, 'v1.0.0');

    const entry: CatalogEntry = {
      id: 'update-fixture',
      sourceId: 'cat_example',
      name: 'update-fixture',
      repoUrl: new URL(`file://${repoDir}`).href,
      ref: 'v2.0.0',
      entry: null,
      kind: 'mcp',
      serverName: null,
      description: null,
      installCommand: null,
      supported: true,
      unsupportedReason: null,
      installedServerId: null,
    };
    const catalog = fakeCatalog([entry]);
    const harnessWithCatalog = createUpdateHarness(root, { catalog });
    harnesses.push(harnessWithCatalog);

    const server = await installTracked(harnessWithCatalog, repoDir, { ref: 'v1.0.0' });
    harnessWithCatalog.updates.recordSource({
      serverId: server.id,
      sourceKind: 'catalog',
      catalogSourceId: 'cat_example',
      catalogEntryId: 'update-fixture',
      repoUrl: new URL(`file://${repoDir}`).href,
      requestedRef: 'v1.0.0',
      installedCommit: head,
    });

    // The installed commit equals the latest tag, but the catalog now pins v2.0.0.
    const check = await harnessWithCatalog.updates.check(server.id);
    expect(check).toMatchObject({ status: 'update-available', updateAvailable: true, latestRef: 'v1.0.0' });
  });
});
