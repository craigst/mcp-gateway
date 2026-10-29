import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import type { GatewayConfig } from '../../src/core/config.js';
import type { ServerRecord } from '../../src/core/types.js';
import {
  stagedUpdateRepository,
  deriveSubpath,
} from '../../src/git_engine/staged.js';
import {
  commitBrokenBuild,
  commitV2,
  createUpstreamRepo,
  gitHead,
  makeRoot,
  makeUpdateConfig,
  removeRoot,
} from '../updates/support.js';

const TOKEN = 'ghp_staged_test_token_0123456789abcdef';
const roots: string[] = [];

beforeEach(() => {
  roots.push(makeRoot('updates-staged-'));
});

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) removeRoot(root);
  }
});

function makeServer(config: GatewayConfig, repoUrl: string, workDir: string | null): ServerRecord {
  const now = new Date().toISOString();
  return {
    id: 'srv_staged00000001',
    name: 'update-fixture',
    runtime: 'node',
    transport: 'stdio',
    status: 'stopped',
    command: 'node',
    args: ['server.js'],
    url: null,
    env: {},
    headers: {},
    manifest: { name: 'update-fixture', version: '1.0.0', runtime: 'node20', start_command: 'node server.js' },
    highPrivilegeTools: [],
    delegationSupported: false,
    sourceUrl: repoUrl,
    workDir: workDir ?? join(config.reposDir, 'update-fixture'),
    envFile: null,
    approvalRequiredTools: [],
    configProfileIds: [],
    lastError: null,
    pid: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('stagedUpdateRepository', () => {
  it('builds a new working copy without touching the live directory', async () => {
    const root = roots[roots.length - 1] as string;
    const config = makeUpdateConfig(root);
    const repoDir = createUpstreamRepo(root);
    const repoUrl = new URL(`file://${repoDir}`).href;
    const liveDir = join(config.reposDir, 'update-fixture');
    const server = makeServer(config, repoUrl, liveDir);

    commitV2(repoDir);
    const commit = gitHead(repoDir);

    const staged = await stagedUpdateRepository({ config, server, ref: 'main' });

    expect(staged.manifest.version).toBe('2.0.0');
    expect(staged.version).toBe('2.0.0');
    expect(staged.commit).toBe(commit);
    expect(staged.command).toBe('node');
    expect(staged.args).toEqual(['server.js']);
    expect(staged.repoRoot.startsWith(join(config.reposDir, '.update-srv_staged00000001-'))).toBe(true);
    expect(existsSync(staged.repoRoot)).toBe(true);
    // The live install does not exist (and was not created) — staging is isolated.
    expect(existsSync(liveDir)).toBe(false);

    rmSync(staged.repoRoot, { recursive: true, force: true });
  });

  it('removes the staging directory when the build fails and never touches the live dir', async () => {
    const root = roots[roots.length - 1] as string;
    const config = makeUpdateConfig(root);
    const repoDir = createUpstreamRepo(root);
    const liveDir = join(config.reposDir, 'update-fixture');
    const server = makeServer(config, new URL(`file://${repoDir}`).href, liveDir);
    commitBrokenBuild(repoDir);

    let failure: GatewayError | null = null;
    try {
      await stagedUpdateRepository({ config, server });
    } catch (error) {
      failure = error as GatewayError;
    }
    expect(failure).toBeInstanceOf(GatewayError);
    expect(failure?.code).toBe(ErrorCodes.UPSTREAM_ERROR);
    expect(failure?.message).toContain('Build failed');
    expect(existsSync(liveDir)).toBe(false);
    // reposDir exists but contains no staging leftovers.
    const entries = existsSync(config.reposDir) ? readdirSync(config.reposDir) : [];
    expect(entries.filter((name) => name.startsWith('.update-'))).toEqual([]);
  });

  it('enforces the clone allowlist and scrubs the token from failures', async () => {
    const root = roots[roots.length - 1] as string;
    const repoDir = createUpstreamRepo(root);
    const deniedConfig = makeUpdateConfig(root, { gitImportAllowedPrefixes: ['https://github.com/'] });
    const server = makeServer(deniedConfig, new URL(`file://${repoDir}`).href, null);

    await expect(stagedUpdateRepository({ config: deniedConfig, server })).rejects.toMatchObject({
      code: ErrorCodes.ACCESS_DENIED,
    });

    const missingUrl = new URL(`file://${join(root, 'missing-repo')}`).href;
    const tokenConfig = makeUpdateConfig(root);
    const tokenServer = makeServer(tokenConfig, missingUrl, null);
    let failure: GatewayError | null = null;
    try {
      await stagedUpdateRepository({ config: tokenConfig, server: tokenServer, token: TOKEN });
    } catch (error) {
      failure = error as GatewayError;
    }
    expect(failure?.code).toBe(ErrorCodes.UPSTREAM_ERROR);
    expect(failure?.message).not.toContain(TOKEN);
    expect(JSON.stringify(failure)).not.toContain(TOKEN);
  });

  it('derives the monorepo subpath from an installed work directory', () => {
    const root = roots[roots.length - 1] as string;
    const config = makeUpdateConfig(root);
    const base = makeServer(config, 'https://github.com/example/repo', null);

    expect(deriveSubpath({ ...base, workDir: join(config.reposDir, 'update-fixture') }, config)).toBeNull();
    expect(
      deriveSubpath({ ...base, workDir: join(config.reposDir, 'update-fixture', 'packages', 'server') }, config),
    ).toBe('packages/server');
    expect(deriveSubpath({ ...base, workDir: '/somewhere/else' }, config)).toBeNull();
    expect(deriveSubpath({ ...base, workDir: null }, config)).toBeNull();
  });
});
