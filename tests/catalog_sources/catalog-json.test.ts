import { cpSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCodes } from '../../src/core/errors.js';
import {
  createCatalogHarness,
  gitInitRepo,
  makeTempDir,
  toFileUrl,
  type CatalogHarness,
} from './support.js';

const NODE_FIXTURE = fileURLToPath(new URL('../fixtures/catalog/node-repo', import.meta.url));

const harnesses: CatalogHarness[] = [];
const tempDirs: string[] = [];
const servers: Array<() => Promise<void>> = [];

beforeEach(() => {
  tempDirs.push(makeTempDir('mcp-catalog-json-'));
});

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.();
  }
  while (harnesses.length > 0) {
    await harnesses.pop()?.dispose();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function setup(overrides: Parameters<typeof createCatalogHarness>[1] = {}): {
  harness: CatalogHarness;
  root: string;
} {
  const root = tempDirs[tempDirs.length - 1] as string;
  const harness = createCatalogHarness(root, overrides);
  harnesses.push(harness);
  return { harness, root };
}

/** Commits the plain Node MCP fixture so it can be installed by the engine. */
function setupNodeRepo(root: string): string {
  const repoDir = join(root, 'node-repo');
  cpSync(NODE_FIXTURE, repoDir, { recursive: true });
  gitInitRepo(repoDir);
  return toFileUrl(repoDir);
}

function startJsonServer(payload: unknown, status = 200): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      servers.push(
        () => new Promise<void>((done) => server.close(() => done())),
      );
      resolve(`http://127.0.0.1:${address.port}/catalog.json`);
    });
  });
}

describe('catalog-json provider', () => {
  it('loads entries from a file:// JSON catalog and installs one end-to-end', async () => {
    const { harness, root } = setup();
    const repoUrl = setupNodeRepo(root);
    const catalogPath = join(root, 'catalog.json');
    writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          {
            name: 'json-node',
            repoUrl,
            ref: 'main',
            description: 'Node MCP server from a JSON catalog',
            serverName: 'json-node',
            kind: 'mcp',
          },
        ],
      }),
      'utf8',
    );

    const source = await harness.service.addSource({
      label: 'File JSON catalog',
      kind: 'catalog-json',
      repoUrl: toFileUrl(catalogPath),
    });
    const entries = await harness.service.listEntries(source.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'json-node',
      sourceId: source.id,
      repoUrl,
      ref: 'main',
      kind: 'mcp',
      supported: true,
      installedServerId: null,
    });

    const result = await harness.service.install({
      sourceId: source.id,
      entryId: 'json-node',
      name: 'from-json',
      start: true,
      test: true,
    });

    expect(result.server.name).toBe('from-json');
    expect(result.test).toMatchObject({ ok: true, toolCount: 5, error: null });
    expect(result.server.status).toBe('running');
  });

  it('loads a catalog from a local HTTP server', async () => {
    const { harness } = setup();
    const catalogUrl = await startJsonServer({
      entries: [
        {
          name: 'remote-catalog-server',
          repoUrl: 'https://github.com/example/remote-catalog-server',
          ref: 'v1.0.0',
          entry: 'dist/index.js',
          description: 'Example remote entry',
        },
      ],
    });

    const source = await harness.service.addSource({
      label: 'HTTP JSON catalog',
      kind: 'catalog-json',
      repoUrl: catalogUrl,
    });
    const entries = await harness.service.listEntries(source.id);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'remote-catalog-server',
      repoUrl: 'https://github.com/example/remote-catalog-server',
      ref: 'v1.0.0',
      entry: 'dist/index.js',
      description: 'Example remote entry',
      supported: true,
    });
  });

  it('is exempt from the git clone allowlist (entries are fetched, not cloned)', async () => {
    const { harness, root } = setup({ gitImportAllowedPrefixes: [] });
    const catalogPath = join(root, 'catalog.json');
    writeFileSync(catalogPath, JSON.stringify([]), 'utf8');

    const source = await harness.service.addSource({
      label: 'Public JSON catalog',
      kind: 'catalog-json',
      repoUrl: toFileUrl(catalogPath),
    });
    expect(await harness.service.listEntries(source.id)).toEqual([]);
  });

  it('reports non-2xx catalog endpoints as upstream errors', async () => {
    const { harness } = setup();
    const catalogUrl = await startJsonServer({ error: 'nope' }, 500);
    const source = await harness.service.addSource({
      label: 'Broken JSON catalog',
      kind: 'catalog-json',
      repoUrl: catalogUrl,
    });

    await expect(harness.service.listEntries(source.id)).rejects.toMatchObject({
      code: ErrorCodes.UPSTREAM_ERROR,
    });
  });

  it('rejects catalog sources whose URL scheme is unsupported', async () => {
    const { harness } = setup();
    await expect(
      harness.service.addSource({
        label: 'Bad scheme',
        kind: 'catalog-json',
        repoUrl: 'ftp://example.com/catalog.json',
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
  });
});
