import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCodes } from '../../src/core/errors.js';
import {
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
  roots.push(makeRoot('updates-flow-'));
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

describe('update checks + in-place update (file:// git repository)', () => {
  it('detects and applies a branch update, preserving operator configuration', async () => {
    const { harness, root } = setup();
    const repoDir = createUpstreamRepo(root);
    const v1Commit = gitHead(repoDir);

    const server = await installTracked(harness, repoDir);
    expect(harness.updates.get(server.id)).toMatchObject({
      serverId: server.id,
      sourceKind: 'git',
      repoUrl: new URL(`file://${repoDir}`).href,
      requestedRef: null,
      installedCommit: v1Commit,
      installedVersion: '1.0.0',
      updateAvailable: false,
    });

    // Configure operator policy/credentials that must survive the update.
    const envFile = join(root, 'mcp.env');
    writeFileSync(envFile, 'EXAMPLE_FLAG=from-env-file\n', 'utf8');
    const stored = harness.repository.getServer(server.id);
    expect(stored).not.toBeNull();
    harness.repository.upsertServer({
      ...(stored as NonNullable<typeof stored>),
      env: { EXAMPLE_FLAG: 'on' },
      headers: { 'x-example': '1' },
      envFile,
      approvalRequiredTools: ['echo'],
      highPrivilegeTools: ['danger_delete'],
    });
    harness.db
      .prepare('UPDATE servers SET config_profile_ids = ? WHERE id = ?')
      .run(JSON.stringify(['prof_example']), server.id);

    await harness.supervisor.start(server.id);
    expect(harness.supervisor.status(server.id)).toBe('running');

    // No upstream change yet → up to date.
    const initial = await harness.updates.check(server.id);
    expect(initial).toMatchObject({ status: 'up-to-date', updateAvailable: false, error: null });
    expect(initial.fromVersion).toBe('1.0.0');

    commitV2(repoDir);
    const v2Commit = gitHead(repoDir);

    const check = await harness.updates.check(server.id);
    expect(check).toMatchObject({
      serverId: server.id,
      serverName: 'update-fixture',
      status: 'update-available',
      updateAvailable: true,
      fromVersion: '1.0.0',
      toVersion: null,
      fromCommit: v1Commit,
      toCommit: v2Commit,
      latestRef: 'main',
      error: null,
    });
    expect(check.checkedAt).toEqual(expect.any(String));

    const persisted = harness.updates.get(server.id);
    expect(persisted).toMatchObject({
      latestCommit: v2Commit,
      latestRef: 'main',
      updateAvailable: true,
      checkError: null,
      // Local file:// remotes have no browsable changelog.
      changelogUrl: null,
    });

    const result = await harness.updates.update(server.id, { restart: true, test: true });

    expect(result.before).toEqual({ version: '1.0.0', commit: v1Commit });
    expect(result.after).toEqual({ version: '2.0.0', commit: v2Commit });
    expect(result.changed).toBe(true);

    const updated = result.server;
    expect(updated.status).toBe('running');
    expect(updated.manifest?.version).toBe('2.0.0');
    expect(updated.command).toBe('node');
    expect(updated.args).toEqual(['server.js']);
    // Operator configuration is preserved across the update.
    expect(updated.env).toMatchObject({ EXAMPLE_FLAG: 'on' });
    expect(updated.headers).toEqual({ 'x-example': '1' });
    expect(updated.envFile).toBe(envFile);
    expect(updated.approvalRequiredTools).toEqual(['echo']);
    expect(updated.highPrivilegeTools).toEqual(['danger_delete']);
    expect(updated.configProfileIds).toEqual(['prof_example']);
    expect(updated.sourceUrl).toBe(new URL(`file://${repoDir}`).href);

    // The updated server exposes the v2 tool set.
    expect(result.test).not.toBeNull();
    expect(result.test).toMatchObject({ ok: true, toolCount: 6, error: null });
    expect(result.test?.tools).toContain('update_marker');
    const toolNames = harness.repository.listToolsByServer(server.id).map((tool) => tool.name);
    expect(toolNames).toContain('update_marker');
    expect(toolNames).toHaveLength(6);

    // The working directory now contains the v2 build, not the original.
    const packageJson = JSON.parse(readFileSync(join(updated.workDir as string, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(packageJson.version).toBe('2.0.0');
    expect(updated.workDir).toBe(join(harness.config.reposDir, 'update-fixture'));
    // No staging or backup directories remain after a successful update.
    expect(listUpdateArtifacts(harness.config.reposDir)).toEqual([]);

    const afterCheck = harness.updates.get(server.id);
    expect(afterCheck).toMatchObject({
      installedVersion: '2.0.0',
      installedCommit: v2Commit,
      updateAvailable: false,
      checkError: null,
    });

    const again = await harness.updates.check(server.id);
    expect(again).toMatchObject({ status: 'up-to-date', updateAvailable: false });
  });

  it('checkAll reports every tracked server and filterable results', async () => {
    const { harness, root } = setup();
    const repoDir = createUpstreamRepo(root);
    const first = await installTracked(harness, repoDir);
    commitV2(repoDir);
    const secondRepo = createUpstreamRepo(root, 'upstream-two');
    const second = await installTracked(harness, secondRepo, { name: 'update-fixture-two' });

    const results = await harness.updates.checkAll();
    expect(results).toHaveLength(2);
    const byId = new Map(results.map((result) => [result.serverId, result]));
    expect(byId.get(first.id)).toMatchObject({ status: 'update-available', updateAvailable: true });
    expect(byId.get(second.id)).toMatchObject({ status: 'up-to-date', updateAvailable: false });

    const filtered = await harness.updates.checkAll([second.id]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.serverId).toBe(second.id);
  });

  it('update is a no-op change when the installed commit is already current', async () => {
    const { harness, root } = setup();
    const repoDir = createUpstreamRepo(root);
    const server = await installTracked(harness, repoDir, { start: true });

    const result = await harness.updates.update(server.id, { restart: true, test: true });
    expect(result.changed).toBe(false);
    expect(result.before).toEqual(result.after);
    expect(result.server.status).toBe('running');
    expect(result.test).toMatchObject({ ok: true, toolCount: 5 });
  });

  it('rejects check/update for servers without a tracked source', async () => {
    const { harness, root } = setup();
    createUpstreamRepo(root);
    await expect(harness.updates.check('srv_missing')).rejects.toMatchObject({
      code: ErrorCodes.TOOL_NOT_FOUND,
    });
    await expect(harness.updates.update('srv_missing')).rejects.toMatchObject({
      code: ErrorCodes.TOOL_NOT_FOUND,
    });
  });
});
