/**
 * Auto-manifest detection for repositories that do not ship `mcp-manifest.json`.
 *
 * The Git import engine uses this so a plain Node or Python MCP repository can
 * be installed without first adding a manifest. Detection is deliberately
 * conservative: it only derives a manifest from files that are unambiguous
 * (a package entry point or a Python server module) and otherwise fails with a
 * clear `INVALID_PARAMS` error naming every location that was checked.
 *
 * Nothing here executes repository code; it only reads JSON/text metadata and
 * checks file existence.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, normalize, sep } from 'node:path';

import { ErrorCodes, GatewayError, invalidParams } from '../core/errors.js';
import type { ServerManifest } from '../core/types.js';
import { mapRuntime, parseManifestFile, validateManifest } from './manifest.js';

/** Where a derived manifest came from; `none` is used by the probe helper. */
export type DetectedFrom = 'mcp-manifest' | 'package.json' | 'pyproject.toml' | 'none';

export interface DetectedManifest {
  manifest: ServerManifest;
  detectedFrom: DetectedFrom;
  buildCommand: string | null;
  startCommand: string | null;
  warnings: string[];
}

/** Result of a non-throwing capability probe (used to flag catalog entries). */
export interface ManifestProbe {
  supported: boolean;
  detectedFrom: DetectedFrom;
  /** Human-readable reason when `supported` is false. */
  reason: string | null;
  warnings: string[];
  buildCommand: string | null;
  startCommand: string | null;
}

export const DEFAULT_NODE_BUILD_COMMAND = 'npm install --omit=dev --no-audit --no-fund';
export const DEFAULT_PYTHON_BUILD_COMMAND = 'uv sync';
export const NODE_FILE_CANDIDATES = ['server.js', 'index.js', 'main.js'] as const;

const NO_ENTRY_MESSAGE =
  'No MCP entry point detected: no mcp-manifest.json, no package.json entry ' +
  '(main/bin/server.js/index.js) and no Python server.py/main.py was found';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Validates an optional monorepo sub-directory and returns the detected base dir. */
function resolveBase(repoDir: string, subpath?: string | null): string {
  if (subpath === undefined || subpath === null || subpath.trim().length === 0) return repoDir;
  const trimmed = subpath.trim();
  if (isAbsolute(trimmed) || trimmed.includes('\0')) {
    throw invalidParams('Repository "subpath" must be a relative directory', { subpath: trimmed });
  }
  const segments = trimmed.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..' || segment === '.' || segment.length === 0)) {
    throw invalidParams('Repository "subpath" must not contain "." or ".." segments', { subpath: trimmed });
  }
  const base = join(repoDir, ...segments);
  const resolvedRepo = normalize(repoDir + sep);
  if (!normalize(base + sep).startsWith(resolvedRepo)) {
    throw invalidParams('Repository "subpath" escapes the repository', { subpath: trimmed });
  }
  if (!isDirectory(base)) {
    throw invalidParams(`Repository sub-directory "${trimmed}" does not exist`, { subpath: trimmed });
  }
  return base;
}

function safeDerivedName(baseDir: string): string {
  const raw = basename(baseDir).toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'mcp-server';
}

function quoteIfNeeded(value: string): string {
  return /\s/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function safeEntryPath(candidate: string): boolean {
  if (candidate.trim().length === 0) return false;
  if (isAbsolute(candidate) || candidate.includes('\0') || candidate.includes('\\')) return false;
  return !candidate.split('/').some((segment) => segment === '..');
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new GatewayError(ErrorCodes.INVALID_PARAMS, `Unable to read ${path}`, {
      cause: error,
      httpStatus: 400,
      data: { status: 'INVALID_PARAMS', details: { path } },
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new GatewayError(ErrorCodes.INVALID_PARAMS, `Invalid JSON in ${path}`, {
      cause: error,
      httpStatus: 400,
      data: { status: 'INVALID_PARAMS', details: { path } },
    });
  }
}

function detectNode(baseDir: string): DetectedManifest | null {
  const packageJsonPath = join(baseDir, 'package.json');
  const hasPackageJson = isFile(packageJsonPath);
  const pkg = hasPackageJson ? readJson(packageJsonPath) : null;
  if (pkg !== null && !isPlainObject(pkg)) {
    throw invalidParams('package.json must contain a JSON object');
  }
  const packageJson = pkg ?? {};

  const warnings: string[] = [];
  const name = nonEmptyString(packageJson.name) ?? safeDerivedName(baseDir);
  const version = nonEmptyString(packageJson.version) ?? '0.0.0';

  // Entry point priority: bin (string or first value), main, then conventional
  // Node entry files that actually exist in the repository.
  const candidates: string[] = [];
  const bin = packageJson.bin;
  if (typeof bin === 'string') {
    candidates.push(bin);
  } else if (isPlainObject(bin)) {
    for (const value of Object.values(bin)) {
      if (typeof value === 'string') {
        candidates.push(value);
        break;
      }
    }
  }
  const main = nonEmptyString(packageJson.main);
  if (main !== null) candidates.push(main);
  candidates.push(`${name}.js`, ...NODE_FILE_CANDIDATES);

  let entry: string | null = null;
  for (const candidate of candidates) {
    if (!safeEntryPath(candidate)) continue;
    if (isFile(join(baseDir, candidate.split('/').join(sep)))) {
      entry = candidate;
      break;
    }
  }
  // `bin`/`main` may point at a build artefact that does not exist before the
  // build runs; accept them as a last resort rather than failing detection.
  if (entry === null) {
    const conventionalCount = NODE_FILE_CANDIDATES.length + 1; // `<name>.js` + default files
    for (const candidate of candidates.slice(0, Math.max(0, candidates.length - conventionalCount))) {
      if (safeEntryPath(candidate)) {
        entry = candidate;
        warnings.push(`Entry file "${candidate}" does not exist yet; it is assumed to be produced by the build step`);
        break;
      }
    }
  }

  if (entry === null) return null;

  const dependencies = isPlainObject(packageJson.dependencies) ? packageJson.dependencies : {};
  const hasDependencies = Object.keys(dependencies).length > 0;
  const buildCommand = hasDependencies ? DEFAULT_NODE_BUILD_COMMAND : null;
  const startCommand = `node ${quoteIfNeeded(entry)}`;

  if (hasPackageJson && isPlainObject(packageJson.scripts) && typeof packageJson.scripts.build === 'string') {
    warnings.push(
      'package.json defines a "build" script; auto-detection only installs production dependencies. ' +
        'Add an mcp-manifest.json with an explicit build_command to run it.',
    );
  }
  if (!hasPackageJson) {
    warnings.push('package.json not found; inferred a Node manifest from the entry file');
  }

  const manifest = validateManifest({
    name,
    version,
    runtime: 'node20',
    start_command: startCommand,
    ...(buildCommand === null ? {} : { build_command: buildCommand }),
  });

  return {
    manifest,
    detectedFrom: 'package.json',
    buildCommand,
    startCommand,
    warnings,
  };
}

function detectPython(baseDir: string): DetectedManifest | null {
  const hasPyProject = isFile(join(baseDir, 'pyproject.toml'));
  const hasSetupPy = isFile(join(baseDir, 'setup.py'));
  if (!hasPyProject && !hasSetupPy) return null;

  const entry = ['server.py', 'main.py'].find((candidate) => isFile(join(baseDir, candidate)));
  if (entry === undefined) {
    throw invalidParams(
      'A Python project was detected but no server.py/main.py MCP entry point was found',
      { detectedFrom: 'pyproject.toml' },
    );
  }

  const warnings: string[] = [];
  if (!hasPyProject) warnings.push('pyproject.toml not found; auto-detected a Python manifest from setup.py');

  const startCommand = `uv run python ${entry}`;
  const manifest = validateManifest({
    name: safeDerivedName(baseDir),
    version: '0.0.0',
    runtime: 'python3.12',
    start_command: startCommand,
    build_command: DEFAULT_PYTHON_BUILD_COMMAND,
  });

  return {
    manifest,
    detectedFrom: 'pyproject.toml',
    buildCommand: DEFAULT_PYTHON_BUILD_COMMAND,
    startCommand,
    warnings,
  };
}

/**
 * Derives (or parses) a `ServerManifest` for the repository at `repoDir`,
 * optionally inside a monorepo `subpath`.
 *
 * A checked-in `mcp-manifest.json` always wins. Otherwise Node (`package.json`)
 * and Python (`pyproject.toml`/`setup.py` + `server.py`/`main.py`) conventions
 * are used. Throws `GatewayError(INVALID_PARAMS)` when nothing can be detected.
 */
const DEFAULT_BUILD_COMMANDS: Partial<Record<string, string>> = {
  node: 'npm install --no-audit --no-fund',
  python: 'uv sync',
};

export function detectManifest(repoDir: string, subpath?: string | null): DetectedManifest {
  const baseDir = resolveBase(repoDir, subpath);

  const manifestPath = join(baseDir, 'mcp-manifest.json');
  if (isFile(manifestPath)) {
    const manifest = parseManifestFile(manifestPath);
    const runtime = mapRuntime(manifest.runtime);
    const defaultBuild = DEFAULT_BUILD_COMMANDS[runtime];
    const buildCommand = manifest.build_command ?? defaultBuild ?? null;
    return {
      manifest,
      detectedFrom: 'mcp-manifest',
      buildCommand: buildCommand === '' ? null : buildCommand,
      startCommand: manifest.start_command ?? null,
      warnings: [],
    };
  }

  const node = detectNode(baseDir);
  if (node !== null) return node;

  const python = detectPython(baseDir);
  if (python !== null) return python;

  throw new GatewayError(ErrorCodes.INVALID_PARAMS, NO_ENTRY_MESSAGE, {
    httpStatus: 400,
    data: { status: 'INVALID_PARAMS', details: { subpath: subpath ?? null } },
  });
}

/**
 * Non-throwing wrapper around `detectManifest` used by the catalog layer to
 * mark entries `supported: false` before an install is attempted.
 */
export function probeManifest(repoDir: string, subpath?: string | null): ManifestProbe {
  try {
    const detected = detectManifest(repoDir, subpath);
    return {
      supported: true,
      detectedFrom: detected.detectedFrom,
      reason: null,
      warnings: detected.warnings,
      buildCommand: detected.buildCommand,
      startCommand: detected.startCommand,
    };
  } catch (error) {
    return {
      supported: false,
      detectedFrom: 'none',
      reason: error instanceof Error ? error.message : String(error),
      warnings: [],
      buildCommand: null,
      startCommand: null,
    };
  }
}

/** True when a directory exists and contains at least one entry (README, etc.). */
export function isNonEmptyDirectory(path: string): boolean {
  if (!isDirectory(path)) return false;
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

/** True when a directory exists (used by catalog probes for submodule dirs). */
export function directoryExists(path: string): boolean {
  return existsSync(path) && isDirectory(path);
}
