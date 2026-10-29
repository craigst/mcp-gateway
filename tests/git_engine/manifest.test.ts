import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import {
  mapRuntime,
  parseManifestFile,
  splitCommand,
  validateManifest,
} from '../../src/git_engine/manifest.js';

const FIXTURE_MANIFEST = fileURLToPath(
  new URL('../fixtures/manifest-repo/mcp-manifest.json', import.meta.url),
);

const VALID_MANIFEST = {
  name: 'github-mcp-connector',
  version: '2.1.0',
  runtime: 'node20',
  build_command: 'npm install && npm run build',
  start_command: 'node dist/index.js',
  environment: { DEFAULT_BRANCH: 'main' },
  required_secrets: ['GITHUB_PAT_TOKEN'],
  capabilities: {
    high_privilege_tools: ['repo_delete', 'force_push'],
    delegation_supported: false,
  },
};

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manifest-test-'));
  tempDirs.push(dir);
  return dir;
}

function captureGatewayError(run: () => unknown): GatewayError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }
  throw new Error('expected a GatewayError');
}

afterAll(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('validateManifest', () => {
  it('accepts a complete manifest and preserves unknown keys', () => {
    const manifest = validateManifest({ ...VALID_MANIFEST, extra_field: { nested: true } });
    expect(manifest.name).toBe('github-mcp-connector');
    expect(manifest.version).toBe('2.1.0');
    expect(manifest.runtime).toBe('node20');
    expect(manifest.start_command).toBe('node dist/index.js');
    expect(manifest.build_command).toBe('npm install && npm run build');
    expect(manifest.environment).toEqual({ DEFAULT_BRANCH: 'main' });
    expect(manifest.required_secrets).toEqual(['GITHUB_PAT_TOKEN']);
    expect(manifest.capabilities?.high_privilege_tools).toEqual(['repo_delete', 'force_push']);
    expect(manifest.capabilities?.delegation_supported).toBe(false);
    expect(manifest.extra_field).toEqual({ nested: true });
  });

  it('accepts a minimal manifest and normalises the "command" alias', () => {
    const manifest = validateManifest({
      name: 'minimal',
      version: '0.0.1',
      runtime: 'python3.12',
      command: 'python -m minimal_server',
    });
    expect(manifest.start_command).toBe('python -m minimal_server');
    expect(manifest.environment).toBeUndefined();
    expect(manifest.required_secrets).toBeUndefined();
    expect(manifest.capabilities).toBeUndefined();
  });

  it.each([
    ['not an object', null],
    ['an array', []],
    ['a string', 'nope'],
  ])('rejects %s', (_label, raw) => {
    const error = captureGatewayError(() => validateManifest(raw));
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it.each([
    ['name', { ...VALID_MANIFEST, name: undefined }],
    ['name blank', { ...VALID_MANIFEST, name: '   ' }],
    ['version', { ...VALID_MANIFEST, version: undefined }],
    ['runtime', { ...VALID_MANIFEST, runtime: undefined }],
    ['unknown runtime', { ...VALID_MANIFEST, runtime: 'deno' }],
    ['missing start command', { ...VALID_MANIFEST, start_command: undefined }],
    ['blank start command', { ...VALID_MANIFEST, start_command: '  ' }],
    ['non-string build command', { ...VALID_MANIFEST, build_command: 42 }],
    ['environment array', { ...VALID_MANIFEST, environment: ['A=1'] }],
    ['environment non-string value', { ...VALID_MANIFEST, environment: { PORT: 8080 } }],
    ['required_secrets non-array', { ...VALID_MANIFEST, required_secrets: 'GITHUB_PAT_TOKEN' }],
    ['required_secrets non-string item', { ...VALID_MANIFEST, required_secrets: [42] }],
    ['required_secrets blank item', { ...VALID_MANIFEST, required_secrets: [''] }],
    ['capabilities non-object', { ...VALID_MANIFEST, capabilities: 'yes' }],
    [
      'capabilities.high_privilege_tools non-array',
      { ...VALID_MANIFEST, capabilities: { high_privilege_tools: 'repo_delete' } },
    ],
    [
      'capabilities.delegation_supported non-boolean',
      { ...VALID_MANIFEST, capabilities: { delegation_supported: 'true' } },
    ],
  ])('rejects invalid %s', (_label, raw) => {
    const error = captureGatewayError(() => validateManifest(raw));
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
  });
});

describe('mapRuntime', () => {
  it.each([
    ['node', 'node'],
    ['node20', 'node'],
    ['node22', 'node'],
    ['NODE20', 'node'],
    ['python', 'python'],
    ['python3', 'python'],
    ['python3.12', 'python'],
    ['binary', 'binary'],
    ['go', 'binary'],
    ['go1.22', 'binary'],
    ['rust', 'binary'],
    ['c', 'binary'],
    ['cpp', 'binary'],
    ['native', 'binary'],
  ])('maps %j to %j', (runtime, expected) => {
    expect(mapRuntime(runtime)).toBe(expected);
  });

  it.each(['deno', 'ruby', 'remote-agent', 'java', ''])('rejects %j', (runtime) => {
    const error = captureGatewayError(() => mapRuntime(runtime));
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
  });
});

describe('parseManifestFile', () => {
  it('parses the fixture manifest from disk', () => {
    const manifest = parseManifestFile(FIXTURE_MANIFEST);
    expect(manifest.name).toBe('fixture-echo-server');
    expect(manifest.runtime).toBe('node20');
    expect(manifest.build_command).toBe('node scripts/build.mjs');
    expect(manifest.start_command).toBe('node server.mjs --stdio');
    expect(manifest.required_secrets).toEqual(['FIXTURE_API_TOKEN']);
    expect(manifest.capabilities?.high_privilege_tools).toEqual(['danger_delete']);
    expect(manifest.capabilities?.delegation_supported).toBe(true);
  });

  it('wraps invalid JSON in an INVALID_PARAMS error', () => {
    const dir = makeTempDir();
    const path = join(dir, 'mcp-manifest.json');
    writeFileSync(path, '{ not json');
    const error = captureGatewayError(() => parseManifestFile(path));
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(error.message).toContain(path);
  });

  it('wraps a missing file in an INVALID_PARAMS error', () => {
    const dir = makeTempDir();
    const error = captureGatewayError(() => parseManifestFile(join(dir, 'absent.json')));
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it('validates parsed JSON content', () => {
    const dir = makeTempDir();
    const path = join(dir, 'mcp-manifest.json');
    writeFileSync(path, JSON.stringify({ name: 'x' }));
    const error = captureGatewayError(() => parseManifestFile(path));
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
  });
});

describe('splitCommand', () => {
  it('splits plain commands', () => {
    expect(splitCommand('npm install && npm run build')).toEqual([
      'npm',
      'install',
      '&&',
      'npm',
      'run',
      'build',
    ]);
    expect(splitCommand('node server.mjs --stdio')).toEqual(['node', 'server.mjs', '--stdio']);
  });

  it('collapses runs of whitespace', () => {
    expect(splitCommand('  node   server.mjs\t--flag  ')).toEqual([
      'node',
      'server.mjs',
      '--flag',
    ]);
  });

  it('honours single and double quotes', () => {
    expect(splitCommand(`node "my script.js" --path='some dir/file'`)).toEqual([
      'node',
      'my script.js',
      '--path=some dir/file',
    ]);
    expect(splitCommand(`echo 'hello "world"'`)).toEqual(['echo', 'hello "world"']);
  });

  it('honours backslash escapes', () => {
    expect(splitCommand('node "a \\"quoted\\" value"')).toEqual(['node', 'a "quoted" value']);
    expect(splitCommand('node a\\ b')).toEqual(['node', 'a b']);
  });

  it('keeps shell metacharacters as literal argv entries', () => {
    expect(splitCommand('echo $HOME; rm -rf /')).toEqual(['echo', '$HOME;', 'rm', '-rf', '/']);
    expect(splitCommand('node x.mjs | tee log')).toEqual(['node', 'x.mjs', '|', 'tee', 'log']);
  });

  it('returns an empty array for empty or whitespace-only commands', () => {
    expect(splitCommand('')).toEqual([]);
    expect(splitCommand('   \t  ')).toEqual([]);
  });

  it('keeps empty quoted arguments', () => {
    expect(splitCommand('node ""')).toEqual(['node', '']);
    expect(splitCommand("node ''")).toEqual(['node', '']);
  });

  it.each(['node "unterminated', "node 'unterminated"])(
    'rejects unterminated quotes: %j',
    (command) => {
      const error = captureGatewayError(() => splitCommand(command));
      expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
      expect(error.message).toContain('Unterminated');
    },
  );
});
