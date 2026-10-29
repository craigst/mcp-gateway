import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import type { CatalogSource } from '../../src/core/types.js';
import { BUNDLE_UNSUPPORTED_REASON } from '../../src/catalog_sources/providers.js';
import {
  copyFixture,
  createCatalogHarness,
  gitInitRepo,
  makeServerRecord,
  makeTempDir,
  toFileUrl,
  type CatalogHarness,
} from './support.js';

const harnesses: CatalogHarness[] = [];
const tempDirs: string[] = [];

beforeEach(() => {
  tempDirs.push(makeTempDir());
});

afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()?.dispose();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function setup(): { harness: CatalogHarness; root: string } {
  const root = tempDirs[tempDirs.length - 1] as string;
  const harness = createCatalogHarness(root);
  harnesses.push(harness);
  return { harness, root };
}

/** Creates a git repo from the umbrella fixture and returns its file:// URL. */
function setupUmbrellaRepo(root: string): { repoUrl: string; repoDir: string } {
  const repoDir = join(root, 'umbrella-repo');
  copyFixture('catalog/umbrella', repoDir);
  gitInitRepo(repoDir);
  return { repoUrl: toFileUrl(repoDir), repoDir };
}

async function addUmbrella(harness: CatalogHarness, root: string): Promise<CatalogSource> {
  const { repoUrl } = setupUmbrellaRepo(root);
  return harness.service.addSource({
    label: 'Example umbrella catalog',
    kind: 'dsh-umbrella',
    repoUrl,
    ref: 'main',
  });
}

describe('DshUmbrellaCatalogProvider', () => {
  it('lists pinned mcp entries joined with .gitmodules metadata', async () => {
    const { harness, root } = setup();
    const source = await addUmbrella(harness, root);
    const entries = await harness.service.listEntries(source.id);

    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect(entries).toHaveLength(5);

    const brain = byName.get('brain-mcp');
    expect(brain).toMatchObject({
      id: 'brain-mcp',
      sourceId: source.id,
      name: 'brain-mcp',
      serverName: 'brain',
      repoUrl: 'https://github.com/example/brain-mcp.git',
      ref: 'v1.1.0',
      entry: 'server.js',
      kind: 'mcp',
      description: 'Example brain MCP server',
      installCommand: './scripts/dsh-wire.sh --deploy',
      supported: true,
      unsupportedReason: null,
      installedServerId: null,
    });

    // Repo URL comes from .gitmodules; the pinned item has no entry file.
    const noEntry = byName.get('no-entry-mcp');
    expect(noEntry).toMatchObject({
      repoUrl: 'https://github.com/example/no-entry-mcp.git',
      ref: 'v2.0.0',
      supported: false,
    });
    expect(noEntry?.unsupportedReason).toMatch(/does not define an entry file/i);

    // Explicit pinned repoUrl wins over anything derived.
    const urlOnly = byName.get('url-only-mcp');
    expect(urlOnly).toMatchObject({
      repoUrl: 'https://github.com/example/url-only-mcp.git',
      ref: 'v3.0.0',
      entry: 'cli.js',
      supported: true,
    });
  });

  it('flags vendored submodules without an MCP entry point as unsupported', async () => {
    const { harness, root } = setup();
    const source = await addUmbrella(harness, root);
    const entries = await harness.service.listEntries(source.id);

    const broken = entries.find((entry) => entry.name === 'broken-mcp');
    expect(broken?.supported).toBe(false);
    expect(broken?.unsupportedReason).toMatch(/no detectable MCP entry point/i);
  });

  it('includes bundles as unsupported bundle entries', async () => {
    const { harness, root } = setup();
    const source = await addUmbrella(harness, root);
    const entries = await harness.service.listEntries(source.id);

    const bundle = entries.find((entry) => entry.name === 'dsh-runtime');
    expect(bundle).toMatchObject({
      id: 'dsh-runtime',
      kind: 'bundle',
      supported: false,
      unsupportedReason: BUNDLE_UNSUPPORTED_REASON,
      repoUrl: 'https://github.com/example/dsh-runtime.git',
      ref: 'v0.9.0',
    });
    expect(BUNDLE_UNSUPPORTED_REASON).toContain('DSH runtime bundle');
  });

  it('marks installed servers by name and by persisted catalog marker', async () => {
    const { harness, root } = setup();
    const source = await addUmbrella(harness, root);

    const brainServer = makeServerRecord({ name: 'brain', id: 'srv_brain000000000' });
    harness.repository.upsertServer(brainServer);

    const markerServer = makeServerRecord({
      name: 'custom-url-only',
      id: 'srv_marker00000000',
      manifest: {
        name: 'custom-url-only',
        version: '0.0.0',
        runtime: 'node20',
        start_command: 'node cli.js',
        x_catalog_source_id: source.id,
        x_catalog_entry_id: 'url-only-mcp',
      },
    });
    harness.repository.upsertServer(markerServer);

    const entries = await harness.service.listEntries(source.id);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));

    // serverName 'brain' matches the recorded server name.
    expect(byName.get('brain-mcp')?.installedServerId).toBe(brainServer.id);
    // No name match, but the install marker on the server manifest identifies it.
    expect(byName.get('url-only-mcp')?.installedServerId).toBe(markerServer.id);
    expect(byName.get('broken-mcp')?.installedServerId).toBeNull();
  });

  it('caches entries per source and supports an explicit refresh', async () => {
    const { harness, root } = setup();
    const source = await addUmbrella(harness, root);

    const first = await harness.service.listEntries(source.id);
    const second = await harness.service.listEntries(source.id);
    expect(second.map((entry) => entry.id)).toEqual(first.map((entry) => entry.id));

    const refreshed = await harness.service.listEntries(source.id, { refresh: true });
    expect(refreshed.map((entry) => entry.id)).toEqual(first.map((entry) => entry.id));
    // Umbrella clones are cached under a private directory in reposDir.
    expect(existsSync(join(harness.config.reposDir, '_catalog', source.id, 'pinned.json'))).toBe(true);
  });

  it('rejects installs of unsupported entries before cloning', async () => {
    const { harness, root } = setup();
    const source = await addUmbrella(harness, root);

    await expect(
      harness.service.install({ sourceId: source.id, entryId: 'broken-mcp' }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
  });

  it('fails with a clear error when the umbrella repo has no pinned.json', async () => {
    const { harness, root } = setup();
    const repoDir = join(root, 'not-an-umbrella');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, 'README.md'), '# no pinned catalog here\n');
    gitInitRepo(repoDir);

    const source = await harness.service.addSource({
      label: 'Broken umbrella',
      kind: 'dsh-umbrella',
      repoUrl: toFileUrl(repoDir),
    });

    try {
      await harness.service.listEntries(source.id);
      throw new Error('expected listEntries to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe(ErrorCodes.INVALID_PARAMS);
      expect((error as GatewayError).message).toContain('pinned.json');
    }
  });
});
