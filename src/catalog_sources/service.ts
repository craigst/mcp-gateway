/**
 * GitHub/plugin catalog service (`PluginCatalogService` port).
 *
 * Orchestrates sources → entries → installs:
 *   1. resolve the pinned catalog entry (umbrella / single repo / JSON URL)
 *   2. resolve a clone token (vault secret first, then GITHUB_TOKEN/GH_TOKEN)
 *   3. hand the repository to the Git import engine (clone → auto-manifest →
 *      build → register)
 *   4. persist an optional env file and catalog marker
 *   5. optionally start the server and time an MCP `tools/list` round trip
 *
 * Secrets are never logged, persisted to the catalog tables, or returned. All
 * token-bearing work happens in the import engine, which scrubs captured
 * output before it reaches a log or error message.
 */
import type { DatabaseSync } from 'node:sqlite';

import type { GatewayConfig } from '../core/config.js';
import { ErrorCodes, GatewayError, invalidParams } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { createLogger } from '../core/logger.js';
import type { Logger } from '../core/logger.js';
import type {
  CatalogInstallRequest,
  CatalogImportUrlRequest,
  CatalogRepository,
  CatalogSourceInput,
  GitImportInput,
  GitImportService,
  PluginCatalogService,
  ServerSourceRecordInput,
  Supervisor,
  VaultService,
} from '../core/ports.js';
import type {
  CatalogEntry,
  CatalogInstallResult,
  CatalogSource,
  CatalogSourceKind,
  InstallTestResult,
  ServerManifest,
  ServerRecord,
} from '../core/types.js';
import { GitImportService as DefaultGitImportService } from '../git_engine/service.js';
import { scrubSecrets } from '../git_engine/clone.js';
import {
  createCatalogProvider,
  type CatalogProvider,
  type CatalogProviderDeps,
} from './providers.js';
import { SqliteCatalogSourceRepository, type CatalogSourceStore } from './store.js';

const CATALOG_SOURCE_KINDS: readonly CatalogSourceKind[] = ['dsh-umbrella', 'github-repo', 'catalog-json'];
const MAX_LABEL_LENGTH = 200;
const MAX_URL_LENGTH = 2_048;
const SAFE_URL_PATTERN = /^(https?:\/\/|file:\/\/|ssh:\/\/|git@)/i;
const AMBIENT_TOKEN_ENV_VARS = ['GITHUB_TOKEN', 'GH_TOKEN'] as const;

/** Vault secret name for a catalog source's clone token (`CATALOG_<id>_TOKEN`). */
export function catalogTokenSecretName(sourceId: string): string {
  return `CATALOG_${sourceId}_TOKEN`;
}

export interface GitPluginCatalogDeps {
  db: DatabaseSync;
  config: GatewayConfig;
  repository: CatalogRepository;
  vault: VaultService;
  supervisor: Supervisor;
  /**
   * Git import engine. Optional so tests can inject; when omitted a local
   * `GitImportService` is constructed from `config`/`repository`/`vault`.
   */
  git?: GitImportService;
  logger?: Logger;
  /** Provider overrides (tests or custom catalogs). */
  providers?: Partial<Record<CatalogSourceKind, CatalogProvider>>;
  /** Injectable fetch for `catalog-json` sources. */
  fetcher?: typeof fetch;
  /** Per-source umbrella entry cache TTL (default 45s). */
  cacheTtlMs?: number;
  /**
   * Optional hook invoked after a successful install/import so the update
   * tracker can persist the server's upstream source (v0.4). Failures are logged
   * and never fail the install — there is no hard dependency on the updates module.
   */
  onServerSource?: (input: ServerSourceRecordInput) => void;
}

interface InstallCommonOptions {
  url: string;
  ref: string | null;
  subpath: string | null;
  name: string | undefined;
  env: Record<string, string> | undefined;
  envFile: string | null | undefined;
  start: boolean | undefined;
  test: boolean | undefined;
  token: string | null;
  marker: { sourceId: string; entryId: string } | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notFound(message: string, details?: unknown): GatewayError {
  return new GatewayError(ErrorCodes.TOOL_NOT_FOUND, message, {
    data: { status: 'NOT_FOUND', details },
    httpStatus: 404,
  });
}

function validateSourceUrl(kind: CatalogSourceKind, repoUrl: string): string {
  const trimmed = repoUrl.trim();
  if (trimmed.length === 0) throw invalidParams('"repoUrl" is required');
  if (trimmed.length > MAX_URL_LENGTH) throw invalidParams('"repoUrl" is too long');
  if (/\s/u.test(trimmed)) throw invalidParams('"repoUrl" must not contain whitespace');
  if (!SAFE_URL_PATTERN.test(trimmed)) {
    throw invalidParams('"repoUrl" must be an http(s), file://, ssh:// or git@ URL');
  }
  if (kind === 'catalog-json' && !/^(https?:\/\/|file:\/\/)/i.test(trimmed)) {
    throw invalidParams('"catalog-json" sources require an http(s) or file:// repoUrl');
  }
  return trimmed;
}

function normalizeOptionalRef(ref: string | null | undefined): string | null {
  if (ref === undefined || ref === null) return null;
  if (typeof ref !== 'string') throw invalidParams('"ref" must be a string');
  const trimmed = ref.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeOptionalSubpath(subpath: string | null | undefined): string | null {
  if (subpath === undefined || subpath === null) return null;
  if (typeof subpath !== 'string') throw invalidParams('"subpath" must be a string');
  const trimmed = subpath.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes('\0') || trimmed.startsWith('/') || trimmed.includes('..')) {
    throw invalidParams('"subpath" must be a safe relative directory');
  }
  return trimmed.replace(/\\/g, '/');
}

function normalizeEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (env === undefined || env === null) return undefined;
  if (!isPlainObject(env)) throw invalidParams('"env" must be an object of string values');
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw invalidParams(`Invalid environment variable name "${key}"`, { name: key });
    }
    if (typeof value !== 'string') {
      throw invalidParams(`Environment variable "${key}" must be a string`, { name: key });
    }
    result[key] = value;
  }
  return result;
}

function normalizeEnvFile(envFile: string | null | undefined): string | null | undefined {
  if (envFile === undefined || envFile === null) return envFile;
  if (typeof envFile !== 'string') throw invalidParams('"envFile" must be a string or null');
  const trimmed = envFile.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export class GitPluginCatalog implements PluginCatalogService {
  private readonly config: GatewayConfig;
  private readonly repository: CatalogRepository;
  private readonly vault: VaultService;
  private readonly supervisor: Supervisor;
  private readonly git: GitImportService & { getLastBuildLogTail?: () => string[] };
  private readonly logger: Logger;
  private readonly store: CatalogSourceStore;
  private readonly providers: Record<CatalogSourceKind, CatalogProvider>;
  private readonly onServerSource: ((input: ServerSourceRecordInput) => void) | undefined;

  constructor(deps: GitPluginCatalogDeps) {
    this.config = deps.config;
    this.repository = deps.repository;
    this.vault = deps.vault;
    this.supervisor = deps.supervisor;
    this.logger = deps.logger ?? createLogger('catalog_sources', 'silent');
    this.store = new SqliteCatalogSourceRepository(deps.db);
    this.onServerSource = deps.onServerSource;
    this.git = (deps.git ??
      new DefaultGitImportService({
        config: deps.config,
        repository: deps.repository,
        vault: deps.vault,
        logger: this.logger,
      })) as GitImportService & { getLastBuildLogTail?: () => string[] };

    const providerDeps: CatalogProviderDeps = {
      config: deps.config,
      logger: this.logger,
      fetcher: deps.fetcher,
      cacheTtlMs: deps.cacheTtlMs,
    };
    this.providers = {
      'dsh-umbrella': deps.providers?.['dsh-umbrella'] ?? createCatalogProvider('dsh-umbrella', providerDeps),
      'github-repo': deps.providers?.['github-repo'] ?? createCatalogProvider('github-repo', providerDeps),
      'catalog-json': deps.providers?.['catalog-json'] ?? createCatalogProvider('catalog-json', providerDeps),
    };
  }

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  listSources(): CatalogSource[] {
    // `tokenSecretName` is safe to return; the token itself lives only in the vault.
    return this.store.list();
  }

  async addSource(input: CatalogSourceInput): Promise<CatalogSource> {
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (label.length === 0) throw invalidParams('"label" is required');
    if (label.length > MAX_LABEL_LENGTH) throw invalidParams('"label" is too long');
    if (!CATALOG_SOURCE_KINDS.includes(input.kind)) {
      throw invalidParams(`"kind" must be one of ${CATALOG_SOURCE_KINDS.join(', ')}`, { kind: input.kind });
    }
    const repoUrl = validateSourceUrl(input.kind, input.repoUrl);
    this.assertCloneAllowed(input.kind, repoUrl);
    const ref = normalizeOptionalRef(input.ref);
    const subpath = normalizeOptionalSubpath(input.subpath);

    let token: string | null = null;
    if (input.token !== undefined && input.token !== null) {
      if (typeof input.token !== 'string') throw invalidParams('"token" must be a string');
      token = input.token.trim().length === 0 ? null : input.token;
    }

    const id = newId('cat');
    let tokenSecretName: string | null = null;
    if (token !== null) {
      if (!this.vault.isEnabled()) {
        throw new GatewayError(
          ErrorCodes.NOT_IMPLEMENTED,
          'Vault is not configured (set MCP_VAULT_SECRET); a catalog token cannot be stored',
          { httpStatus: 503, data: { status: 'NOT_CONFIGURED', reason: 'VAULT_DISABLED' } },
        );
      }
      tokenSecretName = catalogTokenSecretName(id);
      this.vault.setSecret(tokenSecretName, token);
    }

    const now = nowIso();
    const source: CatalogSource = {
      id,
      label,
      kind: input.kind,
      repoUrl,
      ref,
      subpath,
      tokenSecretName,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insert(source);
    this.invalidateProvider(source);
    this.logger.info('catalog source added', {
      sourceId: source.id,
      kind: source.kind,
      hasToken: tokenSecretName !== null,
      ref: source.ref,
      subpath: source.subpath,
    });
    return source;
  }

  /**
   * Catalog repositories are cloned/executed by the same import engine, so the
   * operator's clone allowlist applies to them as well (defence in depth: the
   * engine checks again before executing anything).
   */
  private assertCloneAllowed(kind: CatalogSourceKind, repoUrl: string): void {
    if (kind === 'catalog-json') return;
    const prefixes = this.config.gitImportAllowedPrefixes;
    if (prefixes.length === 0) {
      throw new GatewayError(ErrorCodes.ACCESS_DENIED, 'Git import is disabled', {
        data: { status: 'FORBIDDEN', reason: 'GIT_IMPORT_DISABLED' },
        httpStatus: 403,
      });
    }
    if (!prefixes.some((prefix) => prefix.length > 0 && repoUrl.startsWith(prefix))) {
      throw new GatewayError(
        ErrorCodes.ACCESS_DENIED,
        'Catalog repository URL is not in the allowed import prefixes',
        {
          data: { status: 'FORBIDDEN', reason: 'GIT_IMPORT_URL_NOT_ALLOWED', details: { repoUrl } },
          httpStatus: 403,
        },
      );
    }
  }

  removeSource(id: string): void {
    const source = this.store.get(id);
    if (source === null) throw notFound(`Catalog source '${id}' was not found`, { sourceId: id });

    if (source.tokenSecretName !== null && this.vault.isEnabled()) {
      try {
        this.vault.deleteSecret(source.tokenSecretName);
      } catch (error) {
        this.logger.warn('failed to delete catalog token secret', {
          sourceId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.store.delete(id);
    this.invalidateProvider(source);
    this.logger.info('catalog source removed', { sourceId: id });
  }

  // -------------------------------------------------------------------------
  // Entries
  // -------------------------------------------------------------------------

  /**
   * Lists installable entries for a source.
   *
   * The optional `options.refresh` bypasses the provider's short-lived cache
   * (the admin API exposes it as `?refresh=1`); it is not part of the port.
   */
  async listEntries(sourceId: string, options?: { refresh?: boolean }): Promise<CatalogEntry[]> {
    const source = this.store.get(sourceId);
    if (source === null) throw notFound(`Catalog source '${sourceId}' was not found`, { sourceId });

    const provider = this.providers[source.kind];
    if (options?.refresh === true) provider?.invalidate(source.id);
    const token = this.resolveToken(source);
    const entries = await provider.listEntries(source, token);
    return this.markInstalled(entries);
  }

  // -------------------------------------------------------------------------
  // Install
  // -------------------------------------------------------------------------

  async install(request: CatalogInstallRequest): Promise<CatalogInstallResult> {
    const sourceId = typeof request.sourceId === 'string' ? request.sourceId : '';
    const entryId = typeof request.entryId === 'string' ? request.entryId : '';
    if (sourceId.length === 0) throw invalidParams('"sourceId" is required');
    if (entryId.length === 0) throw invalidParams('"entryId" is required');

    const source = this.store.get(sourceId);
    if (source === null) throw notFound(`Catalog source '${sourceId}' was not found`, { sourceId });

    const entries = await this.listEntries(sourceId);
    const entry = entries.find((candidate) => candidate.id === entryId);
    if (entry === undefined) {
      throw notFound(`Catalog entry '${entryId}' was not found in source '${sourceId}'`, { sourceId, entryId });
    }
    if (entry.kind === 'bundle') {
      throw invalidParams(`Catalog entry '${entry.name}' is not installable: ${entry.unsupportedReason ?? 'bundle'}`, {
        entryId,
      });
    }
    if (!entry.supported) {
      throw invalidParams(
        `Catalog entry '${entry.name}' is not installable: ${entry.unsupportedReason ?? 'unsupported'}`,
        { entryId, reason: entry.unsupportedReason },
      );
    }
    if (entry.repoUrl.trim().length === 0) {
      throw invalidParams(`Catalog entry '${entry.name}' has no repository URL`, { entryId });
    }

    const token = this.resolveToken(source);
    const name = this.normalizeName(request.name, entry.serverName ?? entry.name);
    return this.runInstall({
      url: entry.repoUrl,
      ref: entry.ref ?? source.ref,
      subpath: source.subpath,
      name,
      env: normalizeEnv(request.env),
      envFile: normalizeEnvFile(request.envFile),
      start: request.start,
      test: request.test,
      token,
      marker: { sourceId: source.id, entryId: entry.id },
    });
  }

  async importUrl(request: CatalogImportUrlRequest): Promise<CatalogInstallResult> {
    if (typeof request.url !== 'string' || request.url.trim().length === 0) {
      throw invalidParams('"url" is required');
    }
    const url = validateSourceUrl('github-repo', request.url);
    const ref = normalizeOptionalRef(request.ref);
    const subpath = normalizeOptionalSubpath(request.subpath);
    const name = request.name === undefined ? undefined : this.normalizeName(request.name, '');
    // Imported-by-URL repositories are not attached to a catalog source; their
    // token (for private repos) can only come from the ambient environment.
    const token = this.resolveAmbientToken();
    return this.runInstall({
      url,
      ref,
      subpath,
      name,
      env: normalizeEnv(request.env),
      envFile: normalizeEnvFile(request.envFile),
      start: request.start,
      test: request.test,
      token,
      marker: null,
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async runInstall(options: InstallCommonOptions): Promise<CatalogInstallResult> {
    const importInput: GitImportInput = {
      url: options.url,
      name: options.name,
      ref: options.ref,
      subpath: options.subpath,
      token: options.token,
      env: options.env,
    };
    const server = await this.git.importRepository(importInput);

    let record: ServerRecord = server;
    if (options.envFile !== undefined) {
      record = { ...record, envFile: options.envFile ?? null };
    }
    if (options.marker !== null) {
      record = this.withCatalogMarker(record, options.marker.sourceId, options.marker.entryId);
    }
    if (record !== server) this.repository.upsertServer(record);

    // Track the upstream repository for update checks (best effort).
    this.publishServerSource({
      serverId: record.id,
      sourceKind: options.marker === null ? 'git' : 'catalog',
      catalogSourceId: options.marker?.sourceId ?? null,
      catalogEntryId: options.marker?.entryId ?? null,
      repoUrl: options.url,
      requestedRef: options.ref,
      installedVersion: record.manifest?.version ?? null,
    });

    const shouldStart = options.start === true || options.test === true;
    let started = record;
    if (shouldStart) started = await this.supervisor.start(record.id);

    let test: InstallTestResult | null = null;
    if (options.test === true) test = await this.runTest(record.id, options.token, options.env);

    return {
      server: started,
      test,
      buildLogTail: this.buildLogTail(),
    };
  }

  /** Invokes the optional update-tracking hook without ever failing the install. */
  private publishServerSource(input: ServerSourceRecordInput): void {
    if (this.onServerSource === undefined) return;
    try {
      this.onServerSource(input);
    } catch (error) {
      this.logger.warn('failed to record installed server source for updates', {
        serverId: input.serverId,
        error: scrubSecrets(error instanceof Error ? error.message : String(error), []),
      });
    }
  }

  private async runTest(
    serverId: string,
    token: string | null,
    env: Record<string, string> | undefined,
  ): Promise<InstallTestResult> {
    const started = performance.now();
    try {
      if (this.supervisor.status(serverId) !== 'running') await this.supervisor.start(serverId);
      const client = this.supervisor.client(serverId);
      if (client === null) throw new Error('Server did not start');
      const tools = await client.listTools();
      return {
        ok: true,
        toolCount: tools.length,
        tools: tools.map((tool) => tool.name),
        latencyMs: Number((performance.now() - started).toFixed(2)),
        error: null,
      };
    } catch (error) {
      const message = scrubSecrets(
        error instanceof Error ? error.message : String(error),
        [token, ...Object.values(env ?? {})],
      );
      return {
        ok: false,
        toolCount: 0,
        tools: [],
        latencyMs: Number((performance.now() - started).toFixed(2)),
        error: message,
      };
    }
  }

  private withCatalogMarker(server: ServerRecord, sourceId: string, entryId: string): ServerRecord {
    const base: ServerManifest =
      server.manifest ?? { name: server.name, version: '0.0.0', runtime: server.runtime };
    const manifest: ServerManifest = {
      ...base,
      // Persisted markers only; they are never turned into child-process env.
      x_catalog_source_id: sourceId,
      x_catalog_entry_id: entryId,
    };
    return { ...server, manifest };
  }

  private markInstalled(entries: CatalogEntry[]): CatalogEntry[] {
    const servers = this.repository.listServers();
    const byName = new Map(servers.map((server) => [server.name, server.id]));

    return entries.map((entry) => {
      const nameMatch = byName.get(entry.serverName ?? entry.name) ?? null;
      let markerMatch: string | null = null;
      for (const server of servers) {
        if (
          server.manifest !== null &&
          server.manifest['x_catalog_source_id'] === entry.sourceId &&
          server.manifest['x_catalog_entry_id'] === entry.id
        ) {
          markerMatch = server.id;
          break;
        }
      }
      return { ...entry, installedServerId: markerMatch ?? nameMatch };
    });
  }

  private buildLogTail(): string[] {
    try {
      const getter = this.git.getLastBuildLogTail;
      return typeof getter === 'function' ? getter.call(this.git) : [];
    } catch {
      return [];
    }
  }

  private normalizeName(requested: string | undefined, fallback: string): string | undefined {
    const trimmed = requested?.trim();
    if (trimmed !== undefined && trimmed.length > 0) return trimmed;
    const fallbackTrimmed = fallback.trim();
    return fallbackTrimmed.length > 0 ? fallbackTrimmed : undefined;
  }

  private invalidateProvider(source: CatalogSource): void {
    try {
      this.providers[source.kind]?.invalidate(source.id);
    } catch {
      /* cache invalidation must never fail a request */
    }
  }

  /**
   * Resolves the clone token for a source: the vault secret first, then
   * `GITHUB_TOKEN`/`GH_TOKEN`. The value is never logged or returned.
   */
  private resolveToken(source: CatalogSource): string | null {
    if (source.tokenSecretName !== null) {
      if (!this.vault.isEnabled()) {
        throw new GatewayError(
          ErrorCodes.NOT_IMPLEMENTED,
          'Vault is not configured (set MCP_VAULT_SECRET); the catalog token cannot be resolved',
          { httpStatus: 503, data: { status: 'NOT_CONFIGURED', reason: 'VAULT_DISABLED' } },
        );
      }
      const value = this.vault.getSecret(source.tokenSecretName);
      if (value === null) {
        throw invalidParams(
          `Catalog token secret "${source.tokenSecretName}" is missing from the vault`,
          { sourceId: source.id },
        );
      }
      return value;
    }
    return this.resolveAmbientToken();
  }

  private resolveAmbientToken(): string | null {
    for (const name of AMBIENT_TOKEN_ENV_VARS) {
      const value = process.env[name]?.trim();
      if (value !== undefined && value.length > 0) return value;
    }
    return null;
  }
}
