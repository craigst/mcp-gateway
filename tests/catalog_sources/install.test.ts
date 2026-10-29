import { copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCodes } from '../../src/core/errors.js';
import type { CatalogSource } from '../../src/core/types.js';
import {
  copyFixture,
  createCatalogHarness,
  gitInitRepo,
  makeTempDir,
  toFileUrl,
  type CatalogHarness,
} from './support.js';

const ECHO_SERVER = fileURLToPath(new URL('../fixtures/mcp-echo-server.mjs', import.meta.url));

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

/** manifest-repo fixture + an echo MCP server, committed as a local git repo. */
function setupManifestRepo(root: string): { repoUrl: string; repoDir: string } {
  const repoDir = join(root, 'manifest-repo');
  copyFixture('manifest-repo', repoDir);
  copyFileSync(ECHO_SERVER, join(repoDir, 'server.mjs'));
  gitInitRepo(repoDir);
  return { repoUrl: toFileUrl(repoDir), repoDir };
}

/** Plain Node MCP repo without mcp-manifest.json (auto-detect path). */
function setupNodeRepo(root: string): { repoUrl: string; repoDir: string } {
  const repoDir = join(root, 'node-repo');
  copyFixture('catalog/node-repo', repoDir);
  gitInitRepo(repoDir);
  return { repoUrl: toFileUrl(repoDir), repoDir };
}

async function addRepoSource(
  harness: CatalogHarness,
  kind: 'github-repo' | 'dsh-umbrella' | 'catalog-json',
  repoUrl: string,
): Promise<CatalogSource> {
  return harness.service.addSource({
    label: 'Example catalog',
    kind,
    repoUrl,
    ref: 'main',
  });
}

describe('GitPluginCatalog install (file:// end-to-end)', () => {
  it('installs, starts and tests a manifest repository, returning tools + build log tail', async () => {
    const { harness, root } = setup();
    harness.vault.setSecret('FIXTURE_API_TOKEN', 'test-token-value');
    const { repoUrl } = setupManifestRepo(root);
    const source = await addRepoSource(harness, 'github-repo', repoUrl);

    const entries = await harness.service.listEntries(source.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 'manifest-repo', kind: 'mcp', supported: true });

    const result = await harness.service.install({
      sourceId: source.id,
      entryId: 'manifest-repo',
      start: true,
      test: true,
    });

    expect(result.server.name).toBe('manifest-repo');
    expect(result.server.runtime).toBe('node');
    expect(result.server.status).toBe('running');
    expect(result.server.command).toBe('node');
    expect(result.server.args).toEqual(['server.mjs', '--stdio']);
    expect(result.server.manifest?.name).toBe('fixture-echo-server');
    expect(result.server.workDir).toBe(join(harness.config.reposDir, 'manifest-repo'));
    expect(result.server.sourceUrl).toBe(repoUrl);
    // Static manifest env is preserved and secrets are never persisted.
    expect(result.server.env).toMatchObject({ FIXTURE_MODE: 'test', DEFAULT_BRANCH: 'main' });
    expect(JSON.stringify(result.server)).not.toContain('test-token-value');

    expect(result.test).not.toBeNull();
    expect(result.test?.ok).toBe(true);
    expect(result.test?.toolCount).toBe(5);
    expect(result.test?.tools).toContain('echo');
    expect(result.test?.error).toBeNull();

    // Build output tail is captured for the admin response.
    expect(result.buildLogTail.join('\n')).toContain('manifest-repo fixture build complete');

    // The entry now reports the installed server id.
    const after = await harness.service.listEntries(source.id);
    expect(after[0]?.installedServerId).toBe(result.server.id);
  });

  it('auto-detects a manifest for a plain Node repo, starts it and discovers its tools', async () => {
    const { harness, root } = setup();
    const { repoUrl } = setupNodeRepo(root);
    const source = await addRepoSource(harness, 'github-repo', repoUrl);

    const result = await harness.service.install({
      sourceId: source.id,
      entryId: 'node-repo',
      name: 'auto-node',
      env: { EXAMPLE_FLAG: 'on' },
      start: true,
      test: true,
    });

    expect(result.server.name).toBe('auto-node');
    expect(result.server.runtime).toBe('node');
    expect(result.server.command).toBe('node');
    expect(result.server.args).toEqual(['server.js']);
    expect(result.server.manifest).toMatchObject({
      name: 'example-node-mcp',
      version: '1.0.0',
      runtime: 'node20',
      start_command: 'node server.js',
    });
    // Catalog-supplied env is merged into the persisted server record.
    expect(result.server.env).toMatchObject({ EXAMPLE_FLAG: 'on' });
    // No dependencies → no build command, so no build output.
    expect(result.buildLogTail).toEqual([]);

    expect(result.test).toMatchObject({ ok: true, toolCount: 5, error: null });
    expect(result.server.status).toBe('running');
    expect(harness.supervisor.status(result.server.id)).toBe('running');
  });

  it('persists an env file and stops after install when start/test are not requested', async () => {
    const { harness, root } = setup();
    const { repoUrl } = setupNodeRepo(root);
    const source = await addRepoSource(harness, 'github-repo', repoUrl);

    const envFile = join(root, 'mcp.env');
    writeFileSync(envFile, 'EXAMPLE_FLAG=from-env-file\n', 'utf8');

    const result = await harness.service.install({
      sourceId: source.id,
      entryId: 'node-repo',
      envFile,
      start: false,
      test: false,
    });

    expect(result.server.status).toBe('stopped');
    expect(result.server.envFile).toBe(envFile);
    expect(result.test).toBeNull();
    // Env-file values stay on disk — only the path is persisted.
    expect(JSON.stringify(result.server)).not.toContain('from-env-file');

    // The install marker is persisted so the entry reports the server id even
    // when the server name was overridden.
    const entries = await harness.service.listEntries(source.id);
    expect(entries[0]?.installedServerId).toBe(result.server.id);
  });

  it('imports an arbitrary repository URL without creating a catalog source', async () => {
    const { harness, root } = setup();
    const { repoUrl } = setupNodeRepo(root);
    expect(harness.service.listSources()).toEqual([]);

    const result = await harness.service.importUrl({
      url: repoUrl,
      name: 'custom-import',
      start: true,
      test: true,
    });

    expect(result.server.name).toBe('custom-import');
    expect(result.server.sourceUrl).toBe(repoUrl);
    expect(result.test).toMatchObject({ ok: true, toolCount: 5, error: null });
    expect(harness.service.listSources()).toEqual([]);
  });

  it('rejects installs for unknown sources or entries with NOT_FOUND', async () => {
    const { harness, root } = setup();

    await expect(
      harness.service.install({ sourceId: 'cat_missing', entryId: 'anything' }),
    ).rejects.toMatchObject({ code: ErrorCodes.TOOL_NOT_FOUND });

    const { repoUrl } = setupNodeRepo(root);
    const source = await addRepoSource(harness, 'github-repo', repoUrl);
    await expect(
      harness.service.install({ sourceId: source.id, entryId: 'not-an-entry' }),
    ).rejects.toMatchObject({ code: ErrorCodes.TOOL_NOT_FOUND });
  });
});
