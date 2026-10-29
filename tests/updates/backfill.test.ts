import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PluginCatalogService } from '../../src/core/ports.js';
import type { CatalogEntry, CatalogSource } from '../../src/core/types.js';
import {
  createUpdateHarness,
  createUpstreamRepo,
  gitHead,
  makeRoot,
  removeRoot,
  seedServerRecord,
  toFileUrl,
  type UpdateHarness,
} from './support.js';

const harnesses: UpdateHarness[] = [];
const roots: string[] = [];

beforeEach(() => {
  roots.push(makeRoot('updates-backfill-'));
});

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.dispose();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) removeRoot(root);
  }
});

function setup(catalog?: PluginCatalogService): { harness: UpdateHarness; root: string } {
  const root = roots[roots.length - 1] as string;
  const harness = createUpdateHarness(root, { catalog });
  harnesses.push(harness);
  return { harness, root };
}

function catalogSource(id = 'cat_example'): CatalogSource {
  return {
    id,
    label: 'Example catalog',
    kind: 'github-repo',
    repoUrl: 'https://github.com/example/catalog',
    ref: null,
    subpath: null,
    tokenSecretName: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'brain-mcp',
    sourceId: 'cat_example',
    name: 'brain-mcp',
    repoUrl: 'https://github.com/example/brain-mcp',
    ref: 'v1.2.0',
    entry: 'brain-mcp.js',
    kind: 'mcp',
    serverName: 'brain',
    description: null,
    installCommand: null,
    supported: true,
    unsupportedReason: null,
    installedServerId: null,
    ...overrides,
  };
}

function fakeCatalog(
  entries: CatalogEntry[],
  options: { failForSourceIds?: string[] } = {},
): PluginCatalogService {
  const source = catalogSource();
  return {
    listSources: () => [source],
    addSource: async () => source,
    removeSource: () => undefined,
    listEntries: async (sourceId: string) => {
      if (options.failForSourceIds?.includes(sourceId)) throw new Error('catalog source unreachable');
      return entries;
    },
    install: async () => {
      throw new Error('not used');
    },
    importUrl: async () => {
      throw new Error('not used');
    },
  };
}

describe('DefaultServerUpdateService.backfillFromCatalog', () => {
  it('records servers carrying catalog markers and skips local servers', async () => {
    const { harness, root } = setup();
    const repoDir = createUpstreamRepo(root);
    const head = gitHead(repoDir);
    const marked = seedServerRecord(harness, {
      name: 'brain',
      sourceUrl: toFileUrl(repoDir),
      workDir: repoDir,
      manifest: {
        name: 'brain',
        version: '1.3.0',
        runtime: 'node20',
        start_command: 'node server.js',
        x_catalog_source_id: 'cat_example',
        x_catalog_entry_id: 'brain-mcp',
      },
    });
    seedServerRecord(harness, { name: 'local-harness-server' });

    const result = await harness.updates.backfillFromCatalog();

    expect(result).toEqual({ recorded: 1, skipped: 1, errors: [] });
    const recorded = harness.updates.get(marked.id);
    expect(recorded).toMatchObject({
      serverId: marked.id,
      sourceKind: 'catalog',
      catalogSourceId: 'cat_example',
      catalogEntryId: 'brain-mcp',
      repoUrl: toFileUrl(repoDir),
      installedCommit: head,
      installedVersion: '1.3.0',
      updateAvailable: false,
    });
    expect(harness.updates.listSources()).toHaveLength(1);
  });

  it('matches an untracked server to a catalog entry by name and adopts its ref', async () => {
    const { harness } = setup(fakeCatalog([entry()]));
    const server = seedServerRecord(harness, { name: 'brain' });

    const result = await harness.updates.backfillFromCatalog();

    expect(result.recorded).toBe(1);
    expect(harness.updates.get(server.id)).toMatchObject({
      sourceKind: 'catalog',
      catalogSourceId: 'cat_example',
      catalogEntryId: 'brain-mcp',
      repoUrl: 'https://github.com/example/brain-mcp',
      requestedRef: 'v1.2.0',
      installedCommit: null,
      installedVersion: '1.0.0',
    });
  });

  it('is idempotent and never throws when a catalog source fails', async () => {
    const failingCatalog = fakeCatalog([entry()], { failForSourceIds: ['cat_example'] });
    const { harness, root } = setup(failingCatalog);
    const repoDir = createUpstreamRepo(root);
    const marked = seedServerRecord(harness, {
      name: 'brain',
      sourceUrl: toFileUrl(repoDir),
      workDir: repoDir,
      manifest: {
        name: 'brain',
        version: '1.0.0',
        runtime: 'node20',
        start_command: 'node server.js',
        x_catalog_source_id: 'cat_example',
        x_catalog_entry_id: 'brain-mcp',
      },
    });

    const first = await harness.updates.backfillFromCatalog();
    // Marker-based recording succeeds; the unreachable catalog source is reported.
    expect(first.recorded).toBe(1);
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]).toContain('Example catalog');

    const second = await harness.updates.backfillFromCatalog();
    expect(second).toEqual({ recorded: 0, skipped: 0, errors: [] });
    expect(harness.updates.listSources().map((source) => source.serverId)).toEqual([marked.id]);
  });

  it('skips servers whose manifest markers cannot be resolved to a repo URL', async () => {
    const { harness } = setup();
    seedServerRecord(harness, {
      name: 'unresolvable',
      workDir: null,
      sourceUrl: null,
      manifest: {
        name: 'unresolvable',
        version: '1.0.0',
        runtime: 'node20',
        start_command: 'node server.js',
        x_catalog_source_id: 'cat_example',
        x_catalog_entry_id: 'brain-mcp',
      },
    });

    const result = await harness.updates.backfillFromCatalog();
    expect(result).toEqual({ recorded: 0, skipped: 1, errors: [] });
  });
});
