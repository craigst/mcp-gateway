import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCodes } from '../../src/core/errors.js';
import type { ServerRecord } from '../../src/core/types.js';
import {
  commitBrokenBuild,
  createUpstreamRepo,
  createUpdateHarness,
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
  roots.push(makeRoot('updates-reinstall-'));
});

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.dispose();
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

describe('DefaultServerUpdateService.reinstall', () => {
  it('rebuilds a stopped server whose working directory was lost', async () => {
    const { harness, root } = setup();
    const repoDir = createUpstreamRepo(root);
    const head = gitHead(repoDir);
    const server = await installTracked(harness, repoDir, { start: true });
    const workDir = server.workDir as string;
    expect(harness.supervisor.status(server.id)).toBe('running');

    // Simulate a restore: server stopped and its checked-out code gone.
    await harness.supervisor.stop(server.id);
    rmSync(workDir, { recursive: true, force: true });
    const stored = harness.repository.getServer(server.id);
    expect(stored).not.toBeNull();
    const envFile = join(root, 'reinstall.env');
    writeFileSync(envFile, 'EXAMPLE_FLAG=from-file\n', 'utf8');
    harness.repository.upsertServer({
      ...(stored as NonNullable<typeof stored>),
      env: { EXAMPLE_FLAG: 'reinstall' },
      headers: { 'x-reinstall': '1' },
      envFile,
      approvalRequiredTools: ['echo'],
      highPrivilegeTools: ['danger_delete'],
      configProfileIds: ['cfg_reinstall'],
    });
    harness.db
      .prepare('UPDATE servers SET config_profile_ids = ? WHERE id = ?')
      .run(JSON.stringify(['cfg_reinstall']), server.id);
    expect(existsSync(workDir)).toBe(false);

    const result = await harness.updates.reinstall(server.id);

    expect(result.server.id).toBe(server.id);
    expect(result.server.name).toBe('update-fixture');
    expect(result.server.status).toBe('running');
    expect(result.server.workDir).toBe(workDir);
    expect(existsSync(workDir)).toBe(true);
    expect(result.test).toMatchObject({ ok: true, toolCount: 5 });
    expect(result.after).toEqual({ version: '1.0.0', commit: head });

    // Operator configuration survives the reinstall.
    expect(result.server.env).toMatchObject({ EXAMPLE_FLAG: 'reinstall' });
    expect(result.server.headers).toEqual({ 'x-reinstall': '1' });
    expect(result.server.envFile).toBe(envFile);
    expect(result.server.approvalRequiredTools).toEqual(['echo']);
    expect(result.server.highPrivilegeTools).toEqual(['danger_delete']);
    expect(result.server.configProfileIds).toEqual(['cfg_reinstall']);

    // Update state is cleared and no staging/backup artifacts remain.
    expect(harness.updates.get(server.id)).toMatchObject({
      installedCommit: head,
      installedVersion: '1.0.0',
      updateAvailable: false,
      checkError: null,
    });
    expect(listUpdateArtifacts(harness.config.reposDir)).toEqual([]);
    const packageJson = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(packageJson.version).toBe('1.0.0');
  });

  it('tolerates a server record that never had a working directory', async () => {
    const { harness, root } = setup();
    const repoDir = createUpstreamRepo(root);
    const server = await installTracked(harness, repoDir);
    const stored = harness.repository.getServer(server.id) as ServerRecord;
    const expectedDir = join(harness.config.reposDir, 'update-fixture');

    // Forget the work dir entirely (as a manually restored/imported record might).
    harness.repository.upsertServer({ ...stored, workDir: null });
    expect(existsSync(expectedDir)).toBe(true); // still there from install

    const result = await harness.updates.reinstall(server.id);
    expect(result.server.workDir).toBe(expectedDir);
    expect(result.test).toMatchObject({ ok: true });
  });

  it('rejects reinstall for servers without a tracked source', async () => {
    const { harness } = setup();
    await expect(harness.updates.reinstall('srv_missing')).rejects.toMatchObject({
      code: ErrorCodes.TOOL_NOT_FOUND,
    });
  });

  it('leaves the old server untouched when the reinstall build fails', async () => {
    const { harness, root } = setup();
    const repoDir = createUpstreamRepo(root);
    const server = await installTracked(harness, repoDir);
    const workDir = server.workDir as string;

    // Publish a broken build upstream and remove the local checkout.
    commitBrokenBuild(repoDir);
    rmSync(workDir, { recursive: true, force: true });

    await expect(harness.updates.reinstall(server.id)).rejects.toMatchObject({
      code: ErrorCodes.UPSTREAM_ERROR,
    });
    expect(existsSync(workDir)).toBe(false);
    expect(harness.repository.getServer(server.id)?.manifest?.version).toBe('1.0.0');
    expect(listUpdateArtifacts(harness.config.reposDir)).toEqual([]);
  });
});
