import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import type { ServerRecord } from '../../src/core/types.js';
import {
  commitBrokenBuild,
  commitV2,
  createUpdateHarness,
  createUpstreamRepo,
  gitHead,
  installTracked,
  listUpdateArtifacts,
  makeRoot,
  removeRoot,
  type UpdateHarness,
} from './support.js';

const harnesses: UpdateHarness[] = [];
const roots: string[] = [];

beforeEach(() => {
  roots.push(makeRoot('updates-rollback-'));
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

describe('update failure/rollback', () => {
  it('keeps the running old server untouched when the staged build fails', async () => {
    const { harness, root } = setup();
    const repoDir = createUpstreamRepo(root);
    const v1Commit = gitHead(repoDir);
    const server = await installTracked(harness, repoDir, { start: true });
    const originalWorkDir = server.workDir as string;

    expect(harness.supervisor.status(server.id)).toBe('running');
    expect(harness.repository.listToolsByServer(server.id)).toHaveLength(5);

    commitBrokenBuild(repoDir);
    const brokenCommit = gitHead(repoDir);

    const check = await harness.updates.check(server.id);
    expect(check).toMatchObject({ status: 'update-available', toCommit: brokenCommit });

    let failure: GatewayError | null = null;
    try {
      await harness.updates.update(server.id, { restart: true, test: true });
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      failure = error as GatewayError;
    }
    expect(failure).not.toBeNull();
    expect(failure?.code).toBe(ErrorCodes.UPSTREAM_ERROR);
    expect(failure?.message).toContain('Build failed');
    expect(failure?.message).toContain('simulated build failure');

    // The live server is untouched: still running the old version and tools.
    expect(harness.supervisor.status(server.id)).toBe('running');
    const live = harness.repository.getServer(server.id) as ServerRecord;
    expect(live.manifest?.version).toBe('1.0.0');
    expect(live.workDir).toBe(originalWorkDir);
    expect(harness.repository.listToolsByServer(server.id)).toHaveLength(5);
    const packageJson = JSON.parse(readFileSync(join(originalWorkDir, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(packageJson.version).toBe('1.0.0');

    // The failed update is recorded for the UI; the installed commit is unchanged.
    const source = harness.updates.get(server.id);
    expect(source).toMatchObject({ installedCommit: v1Commit, installedVersion: '1.0.0' });
    expect(source?.checkError).toContain('Build failed');
    // No staging directories or backups are left behind.
    expect(listUpdateArtifacts(harness.config.reposDir)).toEqual([]);
  });

  it('recovers once a valid upstream commit is published', async () => {
    const { harness, root } = setup();
    const repoDir = createUpstreamRepo(root);
    const server = await installTracked(harness, repoDir, { start: true });

    commitBrokenBuild(repoDir);
    await expect(harness.updates.update(server.id)).rejects.toMatchObject({
      code: ErrorCodes.UPSTREAM_ERROR,
    });

    // Publish a good v2 (the broken manifest is removed) and retry.
    rmSync(join(repoDir, 'mcp-manifest.json'), { force: true });
    commitV2(repoDir, 'v2: fixed build');
    const v2Commit = gitHead(repoDir);

    const result = await harness.updates.update(server.id, { restart: true, test: true });
    expect(result.after).toEqual({ version: '2.0.0', commit: v2Commit });
    expect(result.server.manifest?.version).toBe('2.0.0');
    expect(result.test).toMatchObject({ ok: true, toolCount: 6 });
    expect(harness.updates.get(server.id)).toMatchObject({
      installedCommit: v2Commit,
      installedVersion: '2.0.0',
      updateAvailable: false,
      checkError: null,
    });
    expect(listUpdateArtifacts(harness.config.reposDir)).toEqual([]);
  });

  it('does not start a stopped server merely because an update failed', async () => {
    const { harness, root } = setup();
    const repoDir = createUpstreamRepo(root);
    const server = await installTracked(harness, repoDir);
    commitBrokenBuild(repoDir);

    await expect(harness.updates.update(server.id)).rejects.toMatchObject({
      code: ErrorCodes.UPSTREAM_ERROR,
    });
    expect(harness.supervisor.status(server.id)).toBe('stopped');
    expect(harness.repository.getServer(server.id)?.manifest?.version).toBe('1.0.0');
  });
});
