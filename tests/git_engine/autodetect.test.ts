import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import {
  DEFAULT_NODE_BUILD_COMMAND,
  detectManifest,
  probeManifest,
} from '../../src/git_engine/autodetect.js';

const NODE_REPO = fileURLToPath(new URL('../fixtures/catalog/node-repo', import.meta.url));
const PYTHON_REPO = fileURLToPath(new URL('../fixtures/catalog/python-repo', import.meta.url));
const MANIFEST_REPO = fileURLToPath(new URL('../fixtures/manifest-repo', import.meta.url));

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-autodetect-'));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('detectManifest — Node', () => {
  it('derives a manifest from package.json main with no build when dependencies are empty', () => {
    const detected = detectManifest(NODE_REPO);

    expect(detected.detectedFrom).toBe('package.json');
    expect(detected.manifest).toMatchObject({
      name: 'example-node-mcp',
      version: '1.0.0',
      runtime: 'node20',
      start_command: 'node server.js',
    });
    expect(detected.startCommand).toBe('node server.js');
    expect(detected.buildCommand).toBeNull();
    expect(detected.manifest.build_command).toBeUndefined();
  });

  it('prefers package.json bin over main and adds npm install when dependencies exist', () => {
    const repo = makeTempDir();
    writeJson(join(repo, 'package.json'), {
      name: 'bin-repo',
      version: '2.3.4',
      bin: { 'bin-repo': 'cli.js' },
      main: 'main.js',
      dependencies: { 'left-pad': '^1.0.0' },
    });
    writeFileSync(join(repo, 'cli.js'), '#!/usr/bin/env node\n');
    writeFileSync(join(repo, 'main.js'), '// main entry\n');

    const detected = detectManifest(repo);

    expect(detected.manifest.name).toBe('bin-repo');
    expect(detected.manifest.version).toBe('2.3.4');
    expect(detected.startCommand).toBe('node cli.js');
    expect(detected.buildCommand).toBe(DEFAULT_NODE_BUILD_COMMAND);
    expect(detected.manifest.build_command).toBe(DEFAULT_NODE_BUILD_COMMAND);
    expect(detected.warnings).toEqual([]);
  });

  it('accepts a bin object and falls back to a conventional entry file', () => {
    const repo = makeTempDir();
    writeJson(join(repo, 'package.json'), { name: 'conventional', version: '0.2.0' });
    writeFileSync(join(repo, 'index.js'), '// index entry\n');

    const detected = detectManifest(repo);
    expect(detected.startCommand).toBe('node index.js');
    expect(detected.warnings).toEqual([]);
  });

  it('falls back to a Node entry file when package.json is absent', () => {
    const repo = makeTempDir();
    writeFileSync(join(repo, 'server.js'), '// standalone node mcp server\n');

    const detected = detectManifest(repo);
    expect(detected.detectedFrom).toBe('package.json');
    expect(detected.startCommand).toBe('node server.js');
    expect(detected.warnings).toContain(
      'package.json not found; inferred a Node manifest from the entry file',
    );
  });
});

describe('detectManifest — Python', () => {
  it('derives uv sync + uv run python server.py from pyproject.toml', () => {
    const detected = detectManifest(PYTHON_REPO);

    expect(detected.detectedFrom).toBe('pyproject.toml');
    expect(detected.manifest.runtime).toBe('python3.12');
    expect(detected.buildCommand).toBe('uv sync');
    expect(detected.startCommand).toBe('uv run python server.py');
  });
});

describe('detectManifest — precedence and subpaths', () => {
  it('prefers a checked-in mcp-manifest.json over package.json', () => {
    const repo = makeTempDir();
    cpSync(MANIFEST_REPO, repo, { recursive: true });
    writeJson(join(repo, 'package.json'), { name: 'ignored', version: '9.9.9', main: 'index.js' });

    const detected = detectManifest(repo);
    expect(detected.detectedFrom).toBe('mcp-manifest');
    expect(detected.manifest.name).toBe('fixture-echo-server');
    expect(detected.startCommand).toBe('node server.mjs --stdio');
    expect(detected.buildCommand).toBe('node scripts/build.mjs');
  });

  it('detects a manifest inside a monorepo subpath', () => {
    const repo = makeTempDir();
    writeJson(join(repo, 'package.json'), { name: 'monorepo-root', version: '1.0.0', main: 'root.js' });
    const packageDir = join(repo, 'monorepo', 'packages', 'a');
    mkdirSync(packageDir, { recursive: true });
    writeJson(join(packageDir, 'package.json'), {
      name: 'sub-server',
      version: '3.0.0',
      main: 'srv.js',
      dependencies: {},
    });
    writeFileSync(join(packageDir, 'srv.js'), '// sub-server entry\n');

    const detected = detectManifest(repo, 'monorepo/packages/a');
    expect(detected.manifest.name).toBe('sub-server');
    expect(detected.manifest.version).toBe('3.0.0');
    expect(detected.startCommand).toBe('node srv.js');
  });

  it('rejects subpaths that escape the repository or do not exist', () => {
    const repo = makeTempDir();
    writeFileSync(join(repo, 'server.js'), '// entry\n');

    expect(() => detectManifest(repo, '../outside')).toThrowError(GatewayError);
    expect(() => detectManifest(repo, '/etc')).toThrowError(GatewayError);
    expect(() => detectManifest(repo, 'missing-dir')).toThrowError(GatewayError);
  });
});

describe('detectManifest — no entry point', () => {
  it('throws INVALID_PARAMS naming every location that was checked', () => {
    const repo = makeTempDir();
    writeFileSync(join(repo, 'README.md'), '# nothing installable here\n');

    try {
      detectManifest(repo);
      throw new Error('expected detectManifest to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      const gatewayError = error as GatewayError;
      expect(gatewayError.code).toBe(ErrorCodes.INVALID_PARAMS);
      expect(gatewayError.message).toMatch(/no MCP entry point detected/i);
      expect(gatewayError.message).toContain('mcp-manifest.json');
      expect(gatewayError.message).toContain('package.json');
    }
  });

  it('probeManifest reports unsupported instead of throwing', () => {
    const supported = probeManifest(NODE_REPO);
    expect(supported.supported).toBe(true);
    expect(supported.detectedFrom).toBe('package.json');
    expect(supported.startCommand).toBe('node server.js');

    const repo = makeTempDir();
    writeFileSync(join(repo, 'README.md'), '# not an MCP server\n');
    const unsupported = probeManifest(repo);
    expect(unsupported.supported).toBe(false);
    expect(unsupported.detectedFrom).toBe('none');
    expect(unsupported.reason).toMatch(/no MCP entry point detected/i);
  });
});
