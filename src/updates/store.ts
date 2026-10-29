/**
 * SQLite persistence for per-server upstream source tracking (`server_sources`).
 *
 * One row per server that was installed from a git repository. Check results
 * (latest commit/version, update flag, timestamps, error) are stored here so the
 * UI can render update state without hitting the network on every page load.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { boolToInt, intToBool } from '../core/db.js';
import { invalidParams } from '../core/errors.js';
import { nowIso } from '../core/ids.js';
import type { ServerRecord, ServerSourceInfo } from '../core/types.js';
import { resolveGitHead } from '../git_engine/clone.js';

export interface ServerSourceStore {
  list(): ServerSourceInfo[];
  get(serverId: string): ServerSourceInfo | null;
  upsert(source: ServerSourceInfo): void;
  /** Updates selected columns; returns the merged row (null when absent). */
  patch(serverId: string, changes: Partial<ServerSourceInfo>): ServerSourceInfo | null;
  delete(serverId: string): boolean;
}

interface ServerSourceRow {
  server_id: string;
  source_kind: string;
  catalog_source_id: string | null;
  catalog_entry_id: string | null;
  repo_url: string;
  requested_ref: string | null;
  installed_commit: string | null;
  installed_version: string | null;
  latest_commit: string | null;
  latest_version: string | null;
  latest_ref: string | null;
  update_available: number;
  checked_at: string | null;
  check_error: string | null;
  changelog_url: string | null;
}

const SOURCE_KINDS = ['catalog', 'git', 'local'] as const;

export function isServerSourceKind(value: unknown): value is ServerSourceInfo['sourceKind'] {
  return typeof value === 'string' && (SOURCE_KINDS as readonly string[]).includes(value);
}

function mapRow(row: ServerSourceRow): ServerSourceInfo {
  return {
    serverId: row.server_id,
    sourceKind: (isServerSourceKind(row.source_kind) ? row.source_kind : 'git') as ServerSourceInfo['sourceKind'],
    catalogSourceId: row.catalog_source_id ?? null,
    catalogEntryId: row.catalog_entry_id ?? null,
    repoUrl: row.repo_url,
    requestedRef: row.requested_ref ?? null,
    installedCommit: row.installed_commit ?? null,
    installedVersion: row.installed_version ?? null,
    latestCommit: row.latest_commit ?? null,
    latestVersion: row.latest_version ?? null,
    latestRef: row.latest_ref ?? null,
    updateAvailable: intToBool(row.update_available),
    checkedAt: row.checked_at ?? null,
    checkError: row.check_error ?? null,
    changelogUrl: row.changelog_url ?? null,
  };
}

export class SqliteServerSourceStore implements ServerSourceStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(): ServerSourceInfo[] {
    const rows = this.db
      .prepare('SELECT * FROM server_sources ORDER BY server_id ASC')
      .all() as unknown as ServerSourceRow[];
    return rows.map(mapRow);
  }

  get(serverId: string): ServerSourceInfo | null {
    const row = this.db
      .prepare('SELECT * FROM server_sources WHERE server_id = ?')
      .get(serverId) as unknown as ServerSourceRow | undefined;
    return row ? mapRow(row) : null;
  }

  upsert(source: ServerSourceInfo): void {
    if (!isServerSourceKind(source.sourceKind)) {
      throw invalidParams(`Invalid source kind "${String(source.sourceKind)}"`);
    }
    if (typeof source.serverId !== 'string' || source.serverId.length === 0) {
      throw invalidParams('server_sources requires a serverId');
    }
    if (typeof source.repoUrl !== 'string' || source.repoUrl.trim().length === 0) {
      throw invalidParams('server_sources requires a non-empty repoUrl');
    }
    this.db
      .prepare(
        `INSERT INTO server_sources
           (server_id, source_kind, catalog_source_id, catalog_entry_id, repo_url,
            requested_ref, installed_commit, installed_version, latest_commit, latest_version,
            latest_ref, update_available, checked_at, check_error, changelog_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(server_id) DO UPDATE SET
           source_kind = excluded.source_kind,
           catalog_source_id = excluded.catalog_source_id,
           catalog_entry_id = excluded.catalog_entry_id,
           repo_url = excluded.repo_url,
           requested_ref = excluded.requested_ref,
           installed_commit = excluded.installed_commit,
           installed_version = excluded.installed_version,
           latest_commit = excluded.latest_commit,
           latest_version = excluded.latest_version,
           latest_ref = excluded.latest_ref,
           update_available = excluded.update_available,
           checked_at = excluded.checked_at,
           check_error = excluded.check_error,
           changelog_url = excluded.changelog_url`,
      )
      .run(
        source.serverId,
        source.sourceKind,
        source.catalogSourceId ?? null,
        source.catalogEntryId ?? null,
        source.repoUrl.trim(),
        source.requestedRef ?? null,
        source.installedCommit ?? null,
        source.installedVersion ?? null,
        source.latestCommit ?? null,
        source.latestVersion ?? null,
        source.latestRef ?? null,
        boolToInt(source.updateAvailable === true),
        source.checkedAt ?? null,
        source.checkError ?? null,
        source.changelogUrl ?? null,
      );
  }

  patch(serverId: string, changes: Partial<ServerSourceInfo>): ServerSourceInfo | null {
    const existing = this.get(serverId);
    if (existing === null) return null;
    const merged: ServerSourceInfo = { ...existing, ...changes, serverId };
    this.upsert(merged);
    return merged;
  }

  delete(serverId: string): boolean {
    const result = this.db.prepare('DELETE FROM server_sources WHERE server_id = ?').run(serverId);
    return Number(result.changes) > 0;
  }
}

/**
 * Resolves the checked-out commit of an installed server (`git rev-parse HEAD`).
 * Returns null for non-git/manual installs so tracking degrades gracefully.
 */
export function resolveInstalledCommit(workDir: string | null | undefined): string | null {
  return resolveGitHead(workDir ?? null);
}

/**
 * Reads the installed version: the validated manifest first, then a
 * `package.json` in the working directory (for manifest-less installs).
 */
export function resolveInstalledVersion(server: Pick<ServerRecord, 'manifest' | 'workDir'>): string | null {
  const manifestVersion = server.manifest?.version;
  if (typeof manifestVersion === 'string' && manifestVersion.trim().length > 0) {
    return manifestVersion.trim();
  }
  if (typeof server.workDir === 'string' && server.workDir.length > 0) {
    try {
      const parsed = JSON.parse(readFileSync(join(server.workDir, 'package.json'), 'utf8')) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const version = (parsed as Record<string, unknown>).version;
        if (typeof version === 'string' && version.trim().length > 0) return version.trim();
      }
    } catch {
      // No readable package.json — version stays unknown.
    }
  }
  return null;
}

/** Timestamp helper shared by callers persisting check results. */
export function checkedAtNow(): string {
  return nowIso();
}
