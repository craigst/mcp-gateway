import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import {
  buildChangelogUrl,
  compareSemverTags,
  isSemverTag,
  parseSemverTag,
  pickDefaultBranch,
  pickLatestTag,
  resolveRemoteRefs,
} from '../../src/git_engine/remote.js';

const TOKEN = 'ghp_remote_test_token_0123456789abcdef';

let root: string;
let repoDir: string;
let firstCommit: string;
let secondCommit: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-remote-'));
  repoDir = join(root, 'repo');
  execFileSync('mkdir', ['-p', repoDir]);
  git(['init', '-b', 'main'], repoDir);
  execFileSync('sh', ['-c', 'printf "v1\\n" > README.md'], { cwd: repoDir });
  git(['add', '-A'], repoDir);
  git(['-c', 'user.email=fixture@example.com', '-c', 'user.name=Fixture', 'commit', '-m', 'v1'], repoDir);
  firstCommit = git(['rev-parse', 'HEAD'], repoDir);
  git(['tag', 'v1.0.0'], repoDir);
  git(['tag', 'v1.1.0'], repoDir);

  execFileSync('sh', ['-c', 'printf "v2\\n" >> README.md'], { cwd: repoDir });
  git(['add', '-A'], repoDir);
  git(['-c', 'user.email=fixture@example.com', '-c', 'user.name=Fixture', 'commit', '-m', 'v2'], repoDir);
  secondCommit = git(['rev-parse', 'HEAD'], repoDir);
  git(['-c', 'user.email=fixture@example.com', '-c', 'user.name=Fixture', 'tag', '-a', 'v2.0.0', '-m', 'release v2'], repoDir);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveRemoteRefs', () => {
  it('lists branches and tags of a local git remote', async () => {
    const refs = await resolveRemoteRefs({ url: pathToFileURL(repoDir).href });

    expect(refs.heads.main).toBe(secondCommit);
    // Lightweight tags point at the commit they were created on.
    expect(refs.tags['v1.0.0']).toBe(firstCommit);
    expect(refs.tags['v1.1.0']).toBe(firstCommit);
    // Annotated tags resolve to the peeled commit, not the tag object.
    expect(refs.tags['v2.0.0']).toBe(secondCommit);
  });

  it('fails closed for a missing repository without leaking the token', async () => {
    const missing = pathToFileURL(join(root, 'does-not-exist')).href;
    try {
      await resolveRemoteRefs({ url: missing, token: TOKEN });
      throw new Error('expected resolveRemoteRefs to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      const gatewayError = error as GatewayError;
      expect(gatewayError.code).toBe(ErrorCodes.UPSTREAM_ERROR);
      expect(gatewayError.message).toContain('git ls-remote failed');
      expect(gatewayError.message).not.toContain(TOKEN);
      expect(JSON.stringify(gatewayError)).not.toContain(TOKEN);
      expect(JSON.stringify(gatewayError.data)).not.toContain(TOKEN);
    }
  });
});

describe('pickLatestTag', () => {
  it('picks the highest semver tag with numeric comparison', () => {
    const tags = {
      'v1.0.0': 'a',
      '1.2.0': 'b',
      'v1.10.0': 'c',
      'not-semver': 'd',
      'nightly': 'e',
      'v1.9.9': 'f',
    };
    expect(pickLatestTag(tags)).toEqual({ tag: 'v1.10.0', commit: 'c' });
  });

  it('sorts stable releases above prereleases of the same core', () => {
    expect(pickLatestTag({ 'v2.0.0-rc.1': 'a', 'v2.0.0': 'b' })).toEqual({ tag: 'v2.0.0', commit: 'b' });
    expect(pickLatestTag({ 'v2.0.0-alpha': 'a', 'v2.0.0-rc.1': 'b' })).toEqual({
      tag: 'v2.0.0-rc.1',
      commit: 'b',
    });
  });

  it('ignores non-semver/empty tables', () => {
    expect(pickLatestTag({})).toBeNull();
    expect(pickLatestTag({ latest: 'abc', main: 'def' })).toBeNull();
  });
});

describe('semver helpers', () => {
  it('parses and compares semver tags', () => {
    expect(isSemverTag('v1.2.3')).toBe(true);
    expect(isSemverTag('1.2')).toBe(false);
    expect(parseSemverTag('v1.2.3-beta.1+build5')).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(compareSemverTags('v1.9.0', 'v1.10.0')).toBeLessThan(0);
    expect(compareSemverTags('v2.0.0', 'v2.0.0-rc.1')).toBeGreaterThan(0);
  });

  it('picks a conventional default branch', () => {
    expect(pickDefaultBranch({ main: 'a' })).toBe('main');
    expect(pickDefaultBranch({ master: 'a', dev: 'b' })).toBe('master');
    expect(pickDefaultBranch({ only: 'a' })).toBe('only');
    expect(pickDefaultBranch({ feature: 'a', dev: 'b' })).toBeNull();
    expect(pickDefaultBranch({})).toBeNull();
  });
});

describe('buildChangelogUrl', () => {
  const from = 'a'.repeat(40);
  const to = 'b'.repeat(40);

  it('builds GitHub compare links from short commits', () => {
    expect(buildChangelogUrl('https://github.com/example/repo.git', from, to)).toBe(
      `https://github.com/example/repo/compare/${'a'.repeat(12)}...${'b'.repeat(12)}`,
    );
    expect(buildChangelogUrl('https://github.com/example/repo', from, null)).toBe(
      'https://github.com/example/repo/commits',
    );
  });

  it('uses releases for other http(s) remotes and null for local repos', () => {
    expect(buildChangelogUrl('https://git.example.com/example/repo.git', from, to)).toBe(
      'https://git.example.com/example/repo/releases',
    );
    expect(buildChangelogUrl(pathToFileURL(repoDir).href, from, to)).toBeNull();
    expect(buildChangelogUrl(null, from, to)).toBeNull();
  });
});
