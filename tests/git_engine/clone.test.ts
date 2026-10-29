import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ErrorCodes } from '../../src/core/errors.js';
import {
  assertSafeRef,
  basicAuthHeader,
  cloneEnvExtras,
  cloneRepository,
} from '../../src/git_engine/clone.js';

const TEST_TOKEN = 'ghp_clone_env_token_0123456789abcdef';
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('cloneEnvExtras', () => {
  it('injects a http.extraheader through git env config without touching argv', () => {
    const env = cloneEnvExtras(TEST_TOKEN);

    expect(env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: basicAuthHeader(TEST_TOKEN),
    });
    // The value is a basic-auth header, i.e. the token is base64-encoded rather
    // than embedded in the clone URL or on the command line.
    expect(env.GIT_CONFIG_VALUE_0).toMatch(/^AUTHORIZATION: basic /);
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TEST_TOKEN}`).toString('base64')}`,
    );
    expect(Object.values(env).join('\n')).not.toContain(TEST_TOKEN);
  });

  it('returns no extra environment for public clones', () => {
    expect(cloneEnvExtras(null)).toEqual({});
    expect(cloneEnvExtras(undefined)).toEqual({});
    expect(cloneEnvExtras('')).toEqual({});
  });
});

describe('assertSafeRef', () => {
  it('accepts branches and tags', () => {
    expect(assertSafeRef('main')).toBe('main');
    expect(assertSafeRef('v1.2.3')).toBe('v1.2.3');
    expect(assertSafeRef(' release/1.x ')).toBe('release/1.x');
    expect(assertSafeRef(null)).toBeNull();
    expect(assertSafeRef(undefined)).toBeNull();
  });

  it.each(['', '--upload-pack=evil', 'has space', 'a..b', 'a@{1}', 'a\nb', '/leading', 'trailing/'])(
    'rejects unsafe ref %j',
    (ref) => {
      expect(() => assertSafeRef(ref)).toThrowError();
    },
  );
});

describe('cloneRepository', () => {
  it('fails closed with a scrubbed upstream error for a missing repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-clone-'));
    tempDirs.push(root);

    try {
      await cloneRepository({
        url: pathToFileURL(join(root, 'missing-repo')).href,
        targetDir: join(root, 'clone-target'),
        token: TEST_TOKEN,
      });
      throw new Error('expected cloneRepository to reject');
    } catch (error) {
      const gatewayError = error as { code?: number; message?: string; data?: unknown };
      expect(gatewayError.code).toBe(ErrorCodes.UPSTREAM_ERROR);
      expect(gatewayError.message).toContain('git clone failed');
      expect(gatewayError.message).not.toContain(TEST_TOKEN);
      expect(JSON.stringify(gatewayError)).not.toContain(TEST_TOKEN);
    }
  });
});
