/**
 * Server update tracking and in-place updates (v0.4).
 *
 * Responsibilities:
 *  - persist which upstream repository a server came from (`server_sources`)
 *  - check upstream refs (branch commit or latest semver tag) and classify the
 *    update state, with a GitHub compare/releases changelog link
 *  - update ONE server safely: staged clone+build first, then stop → swap the
 *    working directory → start/probe → delete the backup. The live install is
 *    never touched when the staged build fails.
 *  - backfill source rows for servers installed before v0.4 (catalog markers /
 *    catalog entry matching) so the UI can show update state without a reinstall.
 *
 * Security: tokens are resolved from the catalog vault secret or
 * `GITHUB_TOKEN`/`GH_TOKEN`, passed only to the git env-header mechanism, and
 * scrubbed from every error/log that leaves this module.
 */
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { GatewayConfig } from '../core/config.js';
import { parseJson } from '../core/db.js';
import { ErrorCodes, GatewayError, invalidParams } from '../core/errors.js';
import { nowIso } from '../core/ids.js';
import { createLogger } from '../core/logger.js';
import type { Logger } from '../core/logger.js';
import type {
  CatalogRepository,
  GitImportService,
  PluginCatalogService,
  ServerSourceRecordInput,
  ServerUpdateService,
  Supervisor,
  VaultService,
} from '../core/ports.js';
import type {
  CatalogEntry,
  CatalogSource,
  InstallTestResult,
  ServerRecord,
  ServerSourceInfo,
  ServerUpdateResult,
  UpdateCheckResult,
  UpdateStatus,
} from '../core/types.js';
import { scrubSecrets } from '../git_engine/clone.js';
import {
  buildChangelogUrl,
  isSemverTag,
  pickDefaultBranch,
  pickLatestTag,
  resolveRemoteRefs,
  type RemoteRefs,
} from '../git_engine/remote.js';
import { stagedUpdateRepository, type StagedUpdate } from '../git_engine/staged.js';
import {
  resolveInstalledCommit,
  resolveInstalledVersion,
  SqliteServerSourceStore,
  type ServerSourceStore,
} from './store.js';

const AMBIENT_TOKEN_ENV_VARS = ['GITHUB_TOKEN', 'GH_TOKEN'] as const;
const CHECK_CONCURRENCY = 3;

export interface DefaultServerUpdateServiceDeps {
  db: DatabaseSync;
  config: GatewayConfig;
  repository: CatalogRepository;
  supervisor: Supervisor;
  vault: VaultService;
  logger?: Logger;
  catalog?: PluginCatalogService;
  git?: GitImportService;
}

export interface BackfillResult {
  recorded: number;
  skipped: number;
  errors: string[];
}

interface TrackedTarget {
  ref: string;
  commit: string;
  version: string | null;
}

interface CatalogEntryMatch {
  source: CatalogSource;
  entry: CatalogEntry;
}

function notFound(message: string, details?: unknown): GatewayError {
  return new GatewayError(ErrorCodes.TOOL_NOT_FOUND, message, {
    data: { status: 'NOT_FOUND', details },
    httpStatus: 404,
  });
}

function normalizeRepoKey(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

export class DefaultServerUpdateService implements ServerUpdateService {
  private readonly db: DatabaseSync;
  private readonly config: GatewayConfig;
  private readonly repository: CatalogRepository;
  private readonly supervisor: Supervisor;
  private readonly vault: VaultService;
  private readonly logger: Logger;
  private readonly store: ServerSourceStore;
  private readonly catalog: PluginCatalogService | undefined;
  /** Retained for API symmetry / future engine hooks; staged builds are stateless. */
  private readonly git: GitImportService | undefined;

  constructor(deps: DefaultServerUpdateServiceDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.repository = deps.repository;
    this.supervisor = deps.supervisor;
    this.vault = deps.vault;
    this.logger = deps.logger ?? createLogger('updates', 'silent');
    this.store = new SqliteServerSourceStore(deps.db);
    this.catalog = deps.catalog;
    this.git = deps.git;
    void this.git;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  listSources(): ServerSourceInfo[] {
    return this.store.list();
  }

  get(serverId: string): ServerSourceInfo | null {
    return this.store.get(serverId);
  }

  // -------------------------------------------------------------------------
  // Check
  // -------------------------------------------------------------------------

  async check(serverId: string): Promise<UpdateCheckResult> {
    const source = this.store.get(serverId);
    if (source === null) {
      throw notFound(`Server '${serverId}' has no tracked update source`, { serverId });
    }
    const server = this.repository.getServer(serverId);
    const serverName = server?.name ?? serverId;

    let token: string | null;
    try {
      token = this.resolveToken(source);
    } catch (error) {
      return this.failedCheck(source, serverName, error);
    }

    if (source.repoUrl === null || source.repoUrl.trim().length === 0) {
      return this.failedCheck(
        source,
        serverName,
        new GatewayError(ErrorCodes.UPSTREAM_ERROR, 'Tracked source has no repository URL', {
          data: { status: 'UPSTREAM_ERROR', details: { serverId } },
        }),
      );
    }

    let refs: RemoteRefs;
    try {
      refs = await resolveRemoteRefs({ url: source.repoUrl, token });
    } catch (error) {
      this.logger.debug('update check failed to resolve remote refs', {
        serverId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.failedCheck(source, serverName, error);
    }

    const catalogEntryRef = await this.catalogEntryRef(source);
    const target = this.selectTarget(source, refs);
    if (target === null) {
      return this.failedCheck(
        source,
        serverName,
        new GatewayError(
          ErrorCodes.UPSTREAM_ERROR,
          'Unable to resolve an upstream branch or tag to track for this server',
          { data: { status: 'UPSTREAM_ERROR', details: { serverId } } },
        ),
      );
    }

    const catalogRefChanged =
      catalogEntryRef !== null && source.requestedRef !== null && catalogEntryRef !== source.requestedRef;
    const updateAvailable =
      source.installedCommit === null ||
      source.installedCommit !== target.commit ||
      catalogRefChanged;
    const checkedAt = nowIso();
    const changelogUrl = buildChangelogUrl(source.repoUrl, source.installedCommit, target.commit);

    this.store.patch(serverId, {
      latestCommit: target.commit,
      latestVersion: target.version,
      latestRef: target.ref,
      updateAvailable,
      checkedAt,
      checkError: null,
      changelogUrl,
    });

    const status: UpdateStatus = updateAvailable ? 'update-available' : 'up-to-date';
    return {
      serverId,
      serverName,
      status,
      updateAvailable,
      fromVersion: source.installedVersion,
      toVersion: target.version,
      fromCommit: source.installedCommit,
      toCommit: target.commit,
      latestRef: target.ref,
      checkedAt,
      error: null,
    };
  }

  /**
   * Checks every tracked server (or the supplied subset) with bounded
   * concurrency. A failure for one server never aborts the others.
   */
  async checkAll(serverIds?: string[]): Promise<UpdateCheckResult[]> {
    const sources = this.store.list();
    const selected =
      serverIds === undefined || serverIds.length === 0
        ? sources
        : sources.filter((source) => serverIds.includes(source.serverId));
    if (selected.length === 0) return [];

    const results: UpdateCheckResult[] = new Array(selected.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const source = selected[index];
        if (source === undefined) return;
        try {
          results[index] = await this.check(source.serverId);
        } catch (error) {
          const server = this.repository.getServer(source.serverId);
          results[index] = this.failedCheck(source, server?.name ?? source.serverId, error);
        }
      }
    };
    const workerCount = Math.min(CHECK_CONCURRENCY, selected.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async update(
    serverId: string,
    options: { ref?: string | null; restart?: boolean; test?: boolean } = {},
  ): Promise<ServerUpdateResult> {
    const source = this.store.get(serverId);
    if (source === null) {
      throw notFound(`Server '${serverId}' has no tracked update source`, { serverId });
    }
    const stored = this.repository.getServer(serverId);
    if (stored === null) throw notFound(`Server '${serverId}' was not found`, { serverId });
    // Preserve attached config profiles even when the repository mapper does not
    // surface `configProfileIds` yet (the column is authoritative in SQLite).
    const server: ServerRecord = {
      ...stored,
      configProfileIds: this.readConfigProfileIds(serverId),
    };

    const beforeVersion = resolveInstalledVersion(server) ?? source.installedVersion;
    const beforeCommit = source.installedCommit ?? resolveInstalledCommit(server.workDir);
    const wasRunning = this.supervisor.status(serverId) === 'running';
    const restart = options.restart ?? true;
    const test = options.test ?? true;
    // Tag-tracked servers: default to the checked latest tag so a plain
    // "Update" click actually moves forward; branch-tracked fall back to the
    // requested branch.
    const preferredRef = source.updateAvailable ? source.latestRef : null;
    const effectiveRef = options.ref ?? preferredRef ?? source.requestedRef;

    let token: string | null;
    try {
      token = this.resolveToken(source);
    } catch (error) {
      throw this.recordFailureAndScrub(serverId, error, []);
    }
    const secrets: Array<string | null | undefined> = [token, ...Object.values(server.env ?? {})];

    let staged: StagedUpdate;
    try {
      staged = await stagedUpdateRepository({
        config: this.config,
        repository: this.repository,
        vault: this.vault,
        server,
        ref: effectiveRef,
        env: server.env,
        token,
        logger: this.logger,
      });
    } catch (error) {
      // The staged directory has already been cleaned by the engine; the live
      // server and its working directory are untouched.
      throw this.recordFailureAndScrub(serverId, error, secrets);
    }

    if (typeof server.workDir !== 'string' || server.workDir.length === 0) {
      rmSync(staged.repoRoot, { recursive: true, force: true });
      throw invalidParams('Server has no working directory to update', { serverId });
    }
    const oldRoot = this.deriveRepoRoot(server.workDir, staged.subpath);
    const backupRoot = `${oldRoot}.old-${Date.now()}`;

    let backupCreated = false;
    let promoted = false;
    try {
      if (wasRunning) await this.supervisor.stop(serverId);

      if (existsSync(oldRoot)) {
        renameSync(oldRoot, backupRoot);
        backupCreated = true;
      }
      renameSync(staged.repoRoot, oldRoot);
      promoted = true;

      const newWorkDir = staged.subpath === null ? oldRoot : join(oldRoot, staged.subpath);
      const updated = this.mergeUpdatedRecord(server, staged, newWorkDir);
      this.repository.upsertServer(updated);

      const persisted = this.repository.getServer(serverId) ?? updated;
      let record: ServerRecord = { ...persisted, configProfileIds: [...(updated.configProfileIds ?? [])] };

      if (wasRunning || restart) {
        const started = await this.supervisor.start(serverId);
        record = {
          ...record,
          ...started,
          configProfileIds: [...(updated.configProfileIds ?? [])],
          headers: { ...(started.headers ?? updated.headers ?? {}) },
          envFile: started.envFile ?? updated.envFile ?? null,
        };
      }

      let testResult: InstallTestResult | null = null;
      if (test) testResult = await this.probeTools(serverId, secrets);

      if (backupCreated) rmSync(backupRoot, { recursive: true, force: true });

      const checkedAt = nowIso();
      this.store.patch(serverId, {
        installedCommit: staged.commit,
        installedVersion: staged.version,
        latestCommit: staged.commit,
        latestVersion: staged.version,
        latestRef: effectiveRef ?? staged.commit,
        updateAvailable: false,
        checkedAt,
        checkError: null,
      });

      const changed = beforeVersion !== staged.version || beforeCommit !== staged.commit;
      return {
        server: record,
        before: { version: beforeVersion, commit: beforeCommit },
        after: { version: staged.version, commit: staged.commit },
        test: testResult,
        changed,
      };
    } catch (error) {
      // Restore the previous install; the caller sees the scrubbed error.
      await this.rollback(serverId, server, oldRoot, backupRoot, backupCreated, promoted, wasRunning, secrets);
      throw this.recordFailureAndScrub(serverId, error, secrets);
    }
  }

  // -------------------------------------------------------------------------
  // Source recording / backfill
  // -------------------------------------------------------------------------

  recordSource(input: ServerSourceRecordInput): void {
    const server = this.repository.getServer(input.serverId);
    if (server === null) {
      throw invalidParams(`Unknown server '${input.serverId}'`, { serverId: input.serverId });
    }
    if (typeof input.repoUrl !== 'string' || input.repoUrl.trim().length === 0) {
      throw invalidParams('A non-empty repoUrl is required to track a server source', {
        serverId: input.serverId,
      });
    }
    const sourceKind = input.sourceKind ?? 'git';
    if (sourceKind !== 'catalog' && sourceKind !== 'git' && sourceKind !== 'local') {
      throw invalidParams(`Invalid source kind "${String(input.sourceKind)}"`, {
        serverId: input.serverId,
      });
    }

    const existing = this.store.get(input.serverId);
    const installedCommit =
      input.installedCommit ?? resolveInstalledCommit(server.workDir) ?? existing?.installedCommit ?? null;
    const installedVersion =
      input.installedVersion ?? resolveInstalledVersion(server) ?? existing?.installedVersion ?? null;

    this.store.upsert({
      serverId: input.serverId,
      sourceKind,
      catalogSourceId: input.catalogSourceId ?? existing?.catalogSourceId ?? null,
      catalogEntryId: input.catalogEntryId ?? existing?.catalogEntryId ?? null,
      repoUrl: input.repoUrl.trim(),
      requestedRef: input.requestedRef ?? existing?.requestedRef ?? null,
      installedCommit,
      installedVersion,
      latestCommit: existing?.latestCommit ?? null,
      latestVersion: existing?.latestVersion ?? null,
      latestRef: existing?.latestRef ?? null,
      updateAvailable: existing?.updateAvailable ?? false,
      checkedAt: existing?.checkedAt ?? null,
      checkError: existing?.checkError ?? null,
      changelogUrl: input.changelogUrl ?? existing?.changelogUrl ?? null,
    });

    this.logger.info('recorded server update source', {
      serverId: input.serverId,
      sourceKind,
      catalogSourceId: input.catalogSourceId ?? null,
      repoUrl: input.repoUrl,
      installedCommit,
      installedVersion,
    });
  }

  /**
   * Records sources for servers installed before v0.4.
   *
   * Matching order per untracked server:
   *  1. catalog markers written into `server.manifest` by the catalog installer
   *  2. a catalog entry with the same id (when the marker's source still exists)
   *  3. a unique catalog entry with the same server/entry name
   *  4. a unique catalog entry with the same repository URL
   *
   * Everything is best-effort: one bad server/source never aborts the sweep.
   */
  async backfillFromCatalog(): Promise<BackfillResult> {
    const servers = this.repository.listServers();
    const untracked = servers.filter((server) => this.store.get(server.id) === null);
    const result: BackfillResult = { recorded: 0, skipped: 0, errors: [] };
    if (untracked.length === 0) return result;

    const matches = await this.buildCatalogIndex(result.errors);

    for (const server of untracked) {
      try {
        const match = this.matchServerToCatalogEntry(server, matches);
        const manifestSourceId = stringField(server.manifest, 'x_catalog_source_id');
        const manifestEntryId = stringField(server.manifest, 'x_catalog_entry_id');

        if (match === null && manifestSourceId === null && manifestEntryId === null) {
          result.skipped += 1;
          continue;
        }
        const repoUrl =
          match?.entry.repoUrl ??
          (typeof server.sourceUrl === 'string' && server.sourceUrl.length > 0 ? server.sourceUrl : null);
        if (repoUrl === null || repoUrl.trim().length === 0) {
          result.skipped += 1;
          continue;
        }

        this.recordSource({
          serverId: server.id,
          sourceKind: 'catalog',
          catalogSourceId: match?.source.id ?? manifestSourceId,
          catalogEntryId: match?.entry.id ?? manifestEntryId,
          repoUrl,
          requestedRef: match?.entry.ref ?? null,
        });
        result.recorded += 1;
      } catch (error) {
        result.skipped += 1;
        result.errors.push(
          `${server.name}: ${error instanceof Error ? scrubSecrets(error.message, []) : String(error)}`,
        );
      }
    }

    this.logger.info('catalog backfill finished', {
      recorded: result.recorded,
      skipped: result.skipped,
      errors: result.errors.length,
    });
    return result;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private selectTarget(source: ServerSourceInfo, refs: RemoteRefs): TrackedTarget | null {
    const requested = source.requestedRef;
    if (requested !== null && isSemverTag(requested)) {
      const latestTag = pickLatestTag(refs.tags);
      if (latestTag !== null) {
        return { ref: latestTag.tag, commit: latestTag.commit, version: latestTag.tag };
      }
      const exact = refs.tags[requested];
      if (exact !== undefined) return { ref: requested, commit: exact, version: requested };
      return null;
    }

    const branch = requested ?? pickDefaultBranch(refs.heads);
    if (branch === null) return null;
    const commit = refs.heads[branch];
    if (commit === undefined) return null;
    return { ref: branch, commit, version: null };
  }

  private failedCheck(
    source: ServerSourceInfo,
    serverName: string,
    error: unknown,
  ): UpdateCheckResult {
    const message = this.scrubMessage(error, this.secretsForSource(source));
    const checkedAt = nowIso();
    this.store.patch(source.serverId, { checkedAt, checkError: message });
    return {
      serverId: source.serverId,
      serverName,
      status: 'error',
      updateAvailable: source.updateAvailable,
      fromVersion: source.installedVersion,
      toVersion: source.latestVersion,
      fromCommit: source.installedCommit,
      toCommit: source.latestCommit,
      latestRef: source.latestRef,
      checkedAt,
      error: message,
    };
  }

  /** Looks up the catalog entry's current pinned ref (best effort; failures ignored). */
  private async catalogEntryRef(source: ServerSourceInfo): Promise<string | null> {
    if (this.catalog === undefined) return null;
    if (source.catalogSourceId === null || source.catalogEntryId === null) return null;
    try {
      const entries = await this.catalog.listEntries(source.catalogSourceId);
      const entry = entries.find((candidate) => candidate.id === source.catalogEntryId);
      return entry?.ref ?? null;
    } catch (error) {
      this.logger.debug('catalog entry ref lookup failed during update check', {
        serverId: source.serverId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async buildCatalogIndex(errors: string[]): Promise<CatalogEntryMatch[]> {
    if (this.catalog === undefined) return [];
    const matches: CatalogEntryMatch[] = [];
    let sources: CatalogSource[];
    try {
      sources = this.catalog.listSources();
    } catch (error) {
      errors.push(`catalog sources: ${error instanceof Error ? error.message : String(error)}`);
      return matches;
    }
    for (const source of sources) {
      try {
        const entries = await this.catalog.listEntries(source.id);
        for (const entry of entries) matches.push({ source, entry });
      } catch (error) {
        errors.push(`catalog source ${source.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return matches;
  }

  private matchServerToCatalogEntry(
    server: ServerRecord,
    matches: CatalogEntryMatch[],
  ): CatalogEntryMatch | null {
    if (matches.length === 0) return null;

    const manifestEntryId = stringField(server.manifest, 'x_catalog_entry_id');
    if (manifestEntryId !== null) {
      const byId = matches.filter((match) => match.entry.id === manifestEntryId);
      if (byId.length === 1) return byId[0] as CatalogEntryMatch;
    }

    const nameMatches = matches.filter(
      (match) => match.entry.serverName === server.name || match.entry.name === server.name,
    );
    if (nameMatches.length === 1) return nameMatches[0] as CatalogEntryMatch;

    const serverRepo = normalizeRepoKey(server.sourceUrl);
    if (serverRepo !== null) {
      const repoMatches = matches.filter((match) => normalizeRepoKey(match.entry.repoUrl) === serverRepo);
      if (repoMatches.length === 1) return repoMatches[0] as CatalogEntryMatch;
    }

    return null;
  }

  private mergeUpdatedRecord(server: ServerRecord, staged: StagedUpdate, newWorkDir: string): ServerRecord {
    return {
      ...server,
      runtime: staged.runtime,
      command: staged.command,
      args: staged.args,
      manifest: staged.manifest,
      workDir: newWorkDir,
      status: 'stopped',
      pid: null,
      lastError: null,
      delegationSupported: staged.manifest.capabilities?.delegation_supported === true,
      // Explicitly preserve operator policy/credential configuration.
      env: { ...(server.env ?? {}) },
      headers: { ...(server.headers ?? {}) },
      envFile: server.envFile ?? null,
      approvalRequiredTools: [...(server.approvalRequiredTools ?? [])],
      highPrivilegeTools: [...server.highPrivilegeTools],
      configProfileIds: [...(server.configProfileIds ?? [])],
      sourceUrl: server.sourceUrl,
      updatedAt: nowIso(),
    };
  }

  /** Reads `servers.config_profile_ids` directly (defensive; repository may lag). */
  private readConfigProfileIds(serverId: string): string[] {
    try {
      const row = this.db
        .prepare('SELECT config_profile_ids FROM servers WHERE id = ?')
        .get(serverId) as { config_profile_ids?: string | null } | undefined;
      const parsed = parseJson<string[]>(row?.config_profile_ids ?? null, []);
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
    } catch {
      return [];
    }
  }

  private deriveRepoRoot(workDir: string, subpath: string | null): string {
    if (subpath === null) return workDir;
    const suffix = `/${subpath}`;
    return workDir.endsWith(suffix) ? workDir.slice(0, -suffix.length) : workDir;
  }

  private async rollback(
    serverId: string,
    server: ServerRecord,
    oldRoot: string,
    backupRoot: string,
    backupCreated: boolean,
    promoted: boolean,
    wasRunning: boolean,
    secrets: Array<string | null | undefined>,
  ): Promise<void> {
    try {
      try {
        await this.supervisor.stop(serverId);
      } catch {
        // Server may already be stopped/failed — rollback below is authoritative.
      }
      if (promoted && existsSync(oldRoot)) rmSync(oldRoot, { recursive: true, force: true });
      if (backupCreated && existsSync(backupRoot)) renameSync(backupRoot, oldRoot);
      this.repository.upsertServer(server);
      if (wasRunning) await this.supervisor.start(serverId);
      this.logger.warn('rolled back failed server update', { serverId });
    } catch (error) {
      this.logger.error('server update rollback failed', {
        serverId,
        error: this.scrubMessage(error, secrets),
      });
    }
  }

  private async probeTools(
    serverId: string,
    secrets: Array<string | null | undefined>,
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
      return {
        ok: false,
        toolCount: 0,
        tools: [],
        latencyMs: Number((performance.now() - started).toFixed(2)),
        error: this.scrubMessage(error, secrets),
      };
    }
  }

  private recordFailureAndScrub(
    serverId: string,
    error: unknown,
    secrets: Array<string | null | undefined>,
  ): GatewayError {
    const message = this.scrubMessage(error, secrets);
    this.store.patch(serverId, { checkedAt: nowIso(), checkError: message });
    if (error instanceof GatewayError) {
      const scrubbedMessage = scrubSecrets(error.message, secrets);
      let data = error.data;
      if (data !== undefined) {
        try {
          data = JSON.parse(scrubSecrets(JSON.stringify(data), secrets)) as GatewayError['data'];
        } catch {
          data = error.data === undefined ? undefined : { status: error.data.status, reason: error.data.reason };
        }
      }
      return new GatewayError(error.code, scrubbedMessage, {
        data,
        httpStatus: error.httpStatus,
        cause: error.cause,
      });
    }
    return new GatewayError(ErrorCodes.UPSTREAM_ERROR, message, {
      cause: error,
      data: { status: 'UPSTREAM_ERROR', details: { serverId } },
    });
  }

  private scrubMessage(error: unknown, secrets: Array<string | null | undefined>): string {
    const message = error instanceof Error ? error.message : String(error);
    return scrubSecrets(message, secrets);
  }

  private secretsForSource(source: ServerSourceInfo): Array<string | null | undefined> {
    return [this.tryResolveToken(source)];
  }

  private tryResolveToken(source: ServerSourceInfo): string | null {
    try {
      return this.resolveToken(source);
    } catch {
      return null;
    }
  }

  /**
   * Resolves a clone token: the catalog source's vault secret first, then the
   * ambient `GITHUB_TOKEN`/`GH_TOKEN`. Never logged or returned to a client.
   */
  private resolveToken(source: ServerSourceInfo): string | null {
    if (source.catalogSourceId !== null && this.catalog !== undefined) {
      const catalogSource = this.catalog
        .listSources()
        .find((candidate) => candidate.id === source.catalogSourceId);
      if (catalogSource !== undefined && catalogSource.tokenSecretName !== null) {
        if (!this.vault.isEnabled()) {
          throw new GatewayError(
            ErrorCodes.NOT_IMPLEMENTED,
            'Vault is not configured (set MCP_VAULT_SECRET); the catalog token cannot be resolved',
            { httpStatus: 503, data: { status: 'NOT_CONFIGURED', reason: 'VAULT_DISABLED' } },
          );
        }
        const value = this.vault.getSecret(catalogSource.tokenSecretName);
        if (value === null) {
          throw invalidParams(
            `Catalog token secret "${catalogSource.tokenSecretName}" is missing from the vault`,
            { serverId: source.serverId },
          );
        }
        return value;
      }
    }
    for (const name of AMBIENT_TOKEN_ENV_VARS) {
      const value = process.env[name]?.trim();
      if (value !== undefined && value.length > 0) return value;
    }
    return null;
  }
}

function stringField(record: Record<string, unknown> | null | undefined, key: string): string | null {
  if (record === null || record === undefined) return null;
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
