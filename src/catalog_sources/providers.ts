/**
 * Plugin-catalog providers.
 *
 * A provider turns a configured `CatalogSource` into a list of installable
 * `CatalogEntry` values. Three kinds are supported:
 *
 *  - `dsh-umbrella` — a repository whose `.gitmodules` lists plugin repos and
 *    whose `pinned.json` carries `mcp[]` / `bundles[]` metadata. Cloned
 *    shallowly (private repos authenticate with a vault token); entries are the
 *    pinned MCP servers joined with their submodule URLs.
 *  - `github-repo` — a single MCP server repository. Auto-manifest detection
 *    happens at install time, so the entry is always `supported: true`.
 *  - `catalog-json` — a raw JSON URL (http(s) or file://) returning
 *    `{ "entries": [...] }` or a bare array.
 *
 * Tokens are passed only to the clone helper (via git environment config) and
 * are never returned or logged. Provider results are cached briefly per source.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { GatewayConfig } from '../core/config.js';
import { ErrorCodes, GatewayError, invalidParams } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type { Logger } from '../core/logger.js';
import type { CatalogEntry, CatalogSource, CatalogSourceKind } from '../core/types.js';
import { directoryExists, isNonEmptyDirectory, probeManifest } from '../git_engine/autodetect.js';
import { cloneRepository } from '../git_engine/clone.js';

const DEFAULT_CACHE_TTL_MS = 45_000;
const FETCH_TIMEOUT_MS = 15_000;
export const BUNDLE_UNSUPPORTED_REASON = 'DSH runtime bundle — not a standalone MCP server';

// ---------------------------------------------------------------------------
// Pure parsers (exported for unit tests)
// ---------------------------------------------------------------------------

export interface GitmoduleEntry {
  /** Submodule section name (`[submodule "<name>"]`). */
  name: string;
  /** Repository-relative path of the submodule checkout. */
  path: string;
  url: string;
  branch: string | null;
}

interface GitmoduleSection {
  name: string;
  values: Record<string, string>;
}

/**
 * Parses a `.gitmodules` file (git-config syntax) into submodule entries.
 * Malformed lines are ignored; sections without a `path` are dropped.
 */
export function parseGitmodules(text: string): GitmoduleEntry[] {
  if (typeof text !== 'string' || text.trim().length === 0) return [];

  const sections: GitmoduleSection[] = [];
  let current: GitmoduleSection | null = null;

  const unquote = (value: string): string => {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed
        .slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
    return trimmed;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;

    const sectionMatch = /^\[\s*submodule\s+"([^"]+)"\s*\]$/i.exec(line);
    if (sectionMatch !== null) {
      current = { name: sectionMatch[1] as string, values: {} };
      sections.push(current);
      continue;
    }
    if (/^\[/.test(line)) {
      // A non-submodule section ends the current submodule block.
      current = null;
      continue;
    }
    if (current === null) continue;

    const keyMatch = /^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.*)$/.exec(line);
    if (keyMatch === null) continue;
    const key = (keyMatch[1] as string).toLowerCase();
    const value = unquote(keyMatch[2] as string);
    if (value.length > 0) current.values[key] = value;
  }

  const entries: GitmoduleEntry[] = [];
  for (const section of sections) {
    const path = normalizeRepoPath(section.values.path ?? '');
    const url = section.values.url ?? '';
    if (path.length === 0 || url.length === 0) continue;
    entries.push({
      name: section.name.length > 0 ? section.name : path,
      path,
      url,
      branch: section.values.branch ?? null,
    });
  }
  return entries;
}

export interface PinnedMcpEntry {
  name: string;
  serverName: string | null;
  path: string | null;
  entry: string | null;
  ref: string | null;
  description: string | null;
  installCommand: string | null;
  /** Explicit repository URL from pinned metadata (overrides submodule URL). */
  repoUrl: string | null;
  enabled: boolean;
}

export interface PinnedBundleEntry {
  name: string;
  path: string | null;
  entry: string | null;
  ref: string | null;
  description: string | null;
  repoUrl: string | null;
}

export interface ParsedPinnedCatalog {
  mcp: PinnedMcpEntry[];
  bundles: PinnedBundleEntry[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const found = optionalString(value);
    if (found !== null) return found;
  }
  return null;
}

function normalizeEnabled(value: unknown): boolean {
  return value !== false;
}

/**
 * Normalizes `pinned.json` into typed MCP/bundle entries.
 *
 * Accepted shapes: an object with `mcp[]` and/or `bundles[]` (the documented
 * umbrella layout) or a bare array of MCP entries. Field aliases are tolerated
 * (`tag` for `ref`, `install_command`/`installCommand`, `repo_url`/`repoUrl`, …)
 * so different umbrella repos can be imported without code changes.
 */
export function parsePinnedCatalog(pinned: unknown): ParsedPinnedCatalog {
  let mcpRaw: unknown[] = [];
  let bundlesRaw: unknown[] = [];

  if (Array.isArray(pinned)) {
    mcpRaw = pinned;
  } else {
    const root = asRecord(pinned);
    if (root === null) {
      throw invalidParams('pinned.json must be a JSON object with an "mcp" array');
    }
    if (Array.isArray(root.mcp)) mcpRaw = root.mcp;
    if (Array.isArray(root.bundles)) bundlesRaw = root.bundles;
    if (!Array.isArray(root.mcp) && !Array.isArray(root.bundles)) {
      throw invalidParams('pinned.json must define an "mcp" and/or "bundles" array');
    }
  }

  const mcp: PinnedMcpEntry[] = [];
  for (const raw of mcpRaw) {
    if (typeof raw === 'string') {
      const name = raw.trim();
      if (name.length === 0) continue;
      mcp.push({
        name,
        serverName: null,
        path: null,
        entry: null,
        ref: null,
        description: null,
        installCommand: null,
        repoUrl: null,
        enabled: true,
      });
      continue;
    }
    const item = asRecord(raw);
    if (item === null) continue;
    const name = firstString(item.name, item.id, item.serverName, item.server_name);
    if (name === null) continue;
    mcp.push({
      name,
      serverName: firstString(item.serverName, item.server_name),
      path: firstString(item.path, item.submodule, item.subpath, item.dir, item.directory),
      entry: firstString(item.entry, item.entryFile, item.entry_file, item.main),
      ref: firstString(item.ref, item.tag, item.version),
      description: firstString(item.description),
      installCommand: firstString(item.installCommand, item.install_command),
      repoUrl: firstString(item.repoUrl, item.repo_url, item.url),
      enabled: normalizeEnabled(item.enabled),
    });
  }

  const bundles: PinnedBundleEntry[] = [];
  for (const raw of bundlesRaw) {
    if (typeof raw === 'string') {
      const name = raw.trim();
      if (name.length === 0) continue;
      bundles.push({ name, path: null, entry: null, ref: null, description: null, repoUrl: null });
      continue;
    }
    const item = asRecord(raw);
    if (item === null) continue;
    const name = firstString(item.name, item.id);
    if (name === null) continue;
    bundles.push({
      name,
      path: firstString(item.path, item.submodule, item.subpath, item.dir, item.directory),
      entry: firstString(item.entry, item.entryFile, item.entry_file, item.main),
      ref: firstString(item.ref, item.tag, item.version),
      description: firstString(item.description),
      repoUrl: firstString(item.repoUrl, item.repo_url, item.url),
    });
  }

  return { mcp, bundles };
}

/**
 * Normalizes a `catalog-json` payload (array or `{entries:[...]}`) into
 * `CatalogEntry` values. Entries without a `name`/`id` are ignored; entries
 * without a `repoUrl` are marked unsupported (they cannot be installed).
 */
export function normalizeCatalogJson(raw: unknown, sourceId: string): CatalogEntry[] {
  let items: unknown[];
  if (Array.isArray(raw)) {
    items = raw;
  } else {
    const root = asRecord(raw);
    if (root !== null && Array.isArray(root.entries)) items = root.entries;
    else if (root !== null && Array.isArray(root.servers)) items = root.servers;
    else {
      throw invalidParams('Catalog JSON must be an array or an object with an "entries" array');
    }
  }

  const usedIds = new Set<string>();
  const entries: CatalogEntry[] = [];
  for (const rawItem of items) {
    const item = asRecord(rawItem);
    if (item === null) continue;
    const name = firstString(item.name, item.id);
    if (name === null) continue;
    const requestedId = firstString(item.id) ?? name;
    const id = uniqueId(requestedId, usedIds);

    const repoUrl = firstString(item.repoUrl, item.repo_url, item.url) ?? '';
    const kind = item.kind === 'bundle' ? 'bundle' : 'mcp';
    const explicitSupported = typeof item.supported === 'boolean' ? item.supported : null;
    const explicitReason = firstString(item.unsupportedReason, item.unsupported_reason);
    let supported = explicitSupported ?? true;
    let unsupportedReason = explicitReason;
    if (repoUrl.length === 0) {
      supported = false;
      unsupportedReason = unsupportedReason ?? 'Catalog entry does not define a repository URL';
    }

    entries.push({
      id,
      sourceId,
      name,
      repoUrl,
      ref: firstString(item.ref, item.tag) ?? null,
      entry: firstString(item.entry) ?? null,
      kind,
      serverName: firstString(item.serverName, item.server_name),
      description: firstString(item.description),
      installCommand: firstString(item.installCommand, item.install_command),
      supported,
      unsupportedReason: supported ? null : unsupportedReason,
      installedServerId: null,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Normalizes a repository-relative path (`./a//b/` → `a/b`). */
export function normalizeRepoPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/');
}

/** True for a safe relative entry path (no absolute paths / traversal). */
export function isSafeEntryPath(path: string): boolean {
  if (typeof path !== 'string' || path.trim().length === 0) return false;
  if (path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return false;
  return !path.replace(/\\/g, '/').split('/').some((segment) => segment === '..');
}

function uniqueId(base: string, used: Set<string>): string {
  let candidate = base;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

/** Extracts the GitHub owner from an https, ssh or git URL. */
export function githubOwner(url: string): string | null {
  const trimmed = url.trim();
  const https = /^https?:\/\/github\.com\/([^/]+)\//i.exec(trimmed);
  if (https !== null) return https[1] as string;
  const ssh = /^git@github\.com:([^/]+)\//i.exec(trimmed);
  if (ssh !== null) return ssh[1] as string;
  const sshUrl = /^ssh:\/\/git@github\.com\/([^/]+)\//i.exec(trimmed);
  if (sshUrl !== null) return sshUrl[1] as string;
  return null;
}

/** Derives an entry name from a repository URL basename. */
export function repoNameFromUrl(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const base = basename(cleaned.replace(/\\/g, '/'));
  return base.length > 0 ? base : 'repository';
}

export interface CatalogProvider {
  listEntries(source: CatalogSource, token: string | null): Promise<CatalogEntry[]>;
  /** Clears any cached entries for a source. */
  invalidate(sourceId: string): void;
}

// ---------------------------------------------------------------------------
// dsh-umbrella provider
// ---------------------------------------------------------------------------

export interface UmbrellaProviderOptions {
  config: GatewayConfig;
  logger?: Logger;
  /** Per-source entry cache TTL (task requires 30–60s). */
  cacheTtlMs?: number;
}

interface UmbrellaCacheEntry {
  at: number;
  updatedAt: string;
  entries: CatalogEntry[];
}

export class DshUmbrellaCatalogProvider implements CatalogProvider {
  private readonly config: GatewayConfig;
  private readonly logger: Logger;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, UmbrellaCacheEntry>();

  constructor(options: UmbrellaProviderOptions) {
    this.config = options.config;
    this.logger = options.logger ?? createLogger('catalog_sources', 'silent');
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  invalidate(sourceId: string): void {
    this.cache.delete(sourceId);
  }

  async listEntries(source: CatalogSource, token: string | null): Promise<CatalogEntry[]> {
    const cached = this.cache.get(source.id);
    if (
      cached !== undefined &&
      cached.updatedAt === source.updatedAt &&
      Date.now() - cached.at < this.cacheTtlMs
    ) {
      return cached.entries.map((entry) => ({ ...entry }));
    }

    const repoDir = await this.ensureClone(source, token);
    const entries = this.readEntries(source, repoDir);
    this.cache.set(source.id, { at: Date.now(), updatedAt: source.updatedAt, entries });
    return entries.map((entry) => ({ ...entry }));
  }

  private async ensureClone(source: CatalogSource, token: string | null): Promise<string> {
    const repoDir = join(this.config.reposDir, '_catalog', source.id);
    mkdirSync(dirname(repoDir), { recursive: true });
    rmSync(repoDir, { recursive: true, force: true });
    this.logger.debug('cloning umbrella catalog source', {
      sourceId: source.id,
      repoUrl: source.repoUrl,
      ref: source.ref,
      private: token !== null,
    });
    await cloneRepository({ url: source.repoUrl, targetDir: repoDir, ref: source.ref, token });
    return repoDir;
  }

  private readEntries(source: CatalogSource, repoDir: string): CatalogEntry[] {
    const baseDir = source.subpath === null ? repoDir : join(repoDir, source.subpath);
    const pinnedPath = join(baseDir, 'pinned.json');
    if (!existsSync(pinnedPath)) {
      throw invalidParams(`Umbrella repository "${source.label}" does not contain pinned.json`, {
        sourceId: source.id,
      });
    }
    let pinned: unknown;
    try {
      pinned = JSON.parse(readFileSync(pinnedPath, 'utf8')) as unknown;
    } catch (error) {
      throw new GatewayError(ErrorCodes.INVALID_PARAMS, 'Invalid JSON in pinned.json', {
        cause: error,
        httpStatus: 400,
        data: { status: 'INVALID_PARAMS', details: { sourceId: source.id } },
      });
    }
    const parsed = parsePinnedCatalog(pinned);

    // `.gitmodules` lives at the repository root; tolerate a copy in the source subpath.
    const gitmoduleCandidates = [
      join(baseDir, '.gitmodules'),
      join(repoDir, '.gitmodules'),
    ];
    let gitmodulesText = '';
    for (const candidate of gitmoduleCandidates) {
      if (!existsSync(candidate)) continue;
      gitmodulesText = readFileSync(candidate, 'utf8');
      break;
    }
    const submodules = parseGitmodules(gitmodulesText);
    const submodulesByPath = new Map(submodules.map((module) => [normalizeRepoPath(module.path), module]));
    const owner = githubOwner(source.repoUrl);

    const usedIds = new Set<string>();
    const entries: CatalogEntry[] = [];

    for (const item of parsed.mcp) {
      const id = uniqueId(item.name, usedIds);
      // pinned.json's mcp[] rows omit `path`; in umbrella catalogs the submodule
      // path is conventionally the entry name, so fall back to it.
      const path = normalizeRepoPath(item.path ?? item.name);
      const submodule = path === null ? undefined : submodulesByPath.get(path);
      const repoUrl = item.repoUrl ?? submodule?.url ?? fallbackRepoUrl(owner, path);
      const problems: string[] = [];

      if (!item.enabled) problems.push('Entry is disabled in pinned.json');
      if (repoUrl === null || repoUrl.length === 0) {
        problems.push('Unable to resolve a repository URL for this entry');
      }
      if (item.entry === null) {
        problems.push('pinned.json entry does not define an entry file');
      } else if (!isSafeEntryPath(item.entry)) {
        problems.push('pinned.json entry defines an invalid entry path');
      }
      if (path !== null && repoUrl !== null) {
        // When the submodule content is present (file:// catalog or a vendored
        // submodule), probe it so unsupported entries are flagged before install.
        const localSubmoduleDir = join(repoDir, path);
        if (directoryExists(localSubmoduleDir) && isNonEmptyDirectory(localSubmoduleDir)) {
          const probe = probeManifest(localSubmoduleDir);
          if (!probe.supported) problems.push(`Submodule at "${path}" has no detectable MCP entry point`);
        }
      }

      entries.push({
        id,
        sourceId: source.id,
        name: item.name,
        repoUrl: repoUrl ?? '',
        ref: item.ref ?? submodule?.branch ?? null,
        entry: item.entry,
        kind: 'mcp',
        serverName: item.serverName,
        description: item.description,
        installCommand: item.installCommand,
        supported: problems.length === 0,
        unsupportedReason: problems.length === 0 ? null : problems.join('; '),
        installedServerId: null,
      });
    }

    for (const bundle of parsed.bundles) {
      const id = uniqueId(bundle.name, usedIds);
      const path = normalizeRepoPath(bundle.path ?? bundle.name);
      const submodule = path === null ? undefined : submodulesByPath.get(path);
      entries.push({
        id,
        sourceId: source.id,
        name: bundle.name,
        repoUrl: bundle.repoUrl ?? submodule?.url ?? fallbackRepoUrl(owner, path) ?? '',
        ref: bundle.ref ?? submodule?.branch ?? null,
        entry: bundle.entry,
        kind: 'bundle',
        serverName: null,
        description: bundle.description,
        installCommand: null,
        supported: false,
        unsupportedReason: BUNDLE_UNSUPPORTED_REASON,
        installedServerId: null,
      });
    }

    return entries;
  }
}

function fallbackRepoUrl(owner: string | null, path: string | null): string | null {
  if (owner === null || path === null || path.length === 0) return null;
  return `https://github.com/${owner}/${path.replace(/\.git$/i, '')}`;
}

// ---------------------------------------------------------------------------
// github-repo provider
// ---------------------------------------------------------------------------

/** A single MCP server repository; manifest detection happens at install time. */
export class GithubRepoCatalogProvider implements CatalogProvider {
  listEntries(source: CatalogSource): Promise<CatalogEntry[]> {
    const name = repoNameFromUrl(source.repoUrl);
    return Promise.resolve([
      {
        id: name,
        sourceId: source.id,
        name,
        repoUrl: source.repoUrl,
        ref: source.ref,
        entry: null,
        kind: 'mcp',
        serverName: null,
        description: null,
        installCommand: null,
        supported: true,
        unsupportedReason: null,
        installedServerId: null,
      },
    ]);
  }

  invalidate(): void {
    // Stateless.
  }
}

// ---------------------------------------------------------------------------
// catalog-json provider
// ---------------------------------------------------------------------------

export interface CatalogJsonProviderOptions {
  /** Injectable fetch (tests / determinism); defaults to the global fetch. */
  fetcher?: typeof fetch;
  logger?: Logger;
}

export class CatalogJsonCatalogProvider implements CatalogProvider {
  private readonly fetcher: typeof fetch;
  private readonly logger: Logger;

  constructor(options: CatalogJsonProviderOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.logger = options.logger ?? createLogger('catalog_sources', 'silent');
  }

  async listEntries(source: CatalogSource): Promise<CatalogEntry[]> {
    const raw = await this.loadJson(source.repoUrl);
    const entries = normalizeCatalogJson(raw, source.id);
    this.logger.debug('loaded catalog JSON entries', { sourceId: source.id, entries: entries.length });
    return entries;
  }

  invalidate(): void {
    // Stateless.
  }

  private async loadJson(url: string): Promise<unknown> {
    if (url.startsWith('file://')) {
      try {
        return JSON.parse(readFileSync(new URL(url), 'utf8')) as unknown;
      } catch (error) {
        throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, 'Unable to read catalog JSON file', {
          cause: error,
          data: { status: 'UPSTREAM_ERROR', details: { url } },
        });
      }
    }

    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, 'Failed to fetch catalog JSON', {
        cause: error,
        data: { status: 'UPSTREAM_ERROR', details: { url } },
      });
    }
    if (!response.ok) {
      throw new GatewayError(
        ErrorCodes.UPSTREAM_ERROR,
        `Catalog JSON endpoint returned HTTP ${String(response.status)}`,
        { data: { status: 'UPSTREAM_ERROR', details: { url, status: response.status } } },
      );
    }
    try {
      return (await response.json()) as unknown;
    } catch (error) {
      throw new GatewayError(ErrorCodes.INVALID_PARAMS, 'Catalog JSON response is not valid JSON', {
        cause: error,
        httpStatus: 400,
        data: { status: 'INVALID_PARAMS', details: { url } },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CatalogProviderDeps {
  config: GatewayConfig;
  logger?: Logger;
  fetcher?: typeof fetch;
  cacheTtlMs?: number;
}

export function createCatalogProvider(
  kind: CatalogSourceKind,
  deps: CatalogProviderDeps,
): CatalogProvider {
  switch (kind) {
    case 'dsh-umbrella':
      return new DshUmbrellaCatalogProvider({
        config: deps.config,
        logger: deps.logger,
        cacheTtlMs: deps.cacheTtlMs,
      });
    case 'github-repo':
      return new GithubRepoCatalogProvider();
    case 'catalog-json':
      return new CatalogJsonCatalogProvider({ fetcher: deps.fetcher, logger: deps.logger });
    default: {
      const exhaustive: never = kind;
      throw invalidParams(`Unknown catalog source kind "${String(exhaustive)}"`);
    }
  }
}
