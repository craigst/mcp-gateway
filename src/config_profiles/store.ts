/**
 * SQLite persistence for reusable configuration profiles (v0.4).
 *
 * SQLite stores only metadata and *references* — never configuration values:
 *   env_json         JSON array of { key, source, ref } for environment entries
 *   headers_json     JSON array of { key, source, ref } for header entries
 *   secret_keys_json JSON array of profile-owned vault secret names (cleanup list)
 *   env_file         always NULL (env files are intentionally unsupported)
 *
 * Server attachment lives on `servers.config_profile_ids` (JSON array). The catalog
 * repository does not (yet) project that column, so this store reads/writes it
 * directly — the database column is the single source of truth.
 */
import type { DatabaseSync } from 'node:sqlite';

import { parseJson, toJson } from '../core/db.js';
import { invalidParams } from '../core/errors.js';
import { nowIso } from '../core/ids.js';
import type { ConfigProfile, ConfigProfileValue } from '../core/types.js';

interface ConfigProfileRow {
  id: string;
  name: string;
  description: string | null;
  env_json: string;
  secret_keys_json: string;
  headers_json: string;
  env_file: string | null;
  created_at: string;
  updated_at: string;
}

/** Profile plus its internal vault cleanup list (never exposed by the API). */
export interface StoredConfigProfile extends ConfigProfile {
  ownedSecretNames: string[];
}

export interface NewConfigProfileRecord {
  id: string;
  name: string;
  description: string | null;
  entries: ConfigProfileValue[];
  headers: ConfigProfileValue[];
  /** Vault secret names created for (and owned by) this profile. */
  ownedSecretNames: string[];
}

function parseValueEntries(raw: string): ConfigProfileValue[] {
  const parsed = parseJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  const entries: ConfigProfileValue[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const key = record.key;
    const source = record.source;
    if (typeof key !== 'string' || key === '') continue;
    if (source !== 'encrypted' && source !== 'vault-ref') continue;
    const ref = typeof record.ref === 'string' && record.ref !== '' ? record.ref : null;
    entries.push({ key, source, ref });
  }
  return entries;
}

function parseSecretNames(raw: string): string[] {
  const parsed = parseJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((value): value is string => typeof value === 'string' && value !== '');
}

function mapRow(row: ConfigProfileRow): StoredConfigProfile {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    entries: parseValueEntries(row.env_json),
    headers: parseValueEntries(row.headers_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ownedSecretNames: parseSecretNames(row.secret_keys_json),
  };
}

function toPublic(profile: StoredConfigProfile): ConfigProfile {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    entries: profile.entries,
    headers: profile.headers,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function encodeEntries(entries: ConfigProfileValue[]): string {
  return toJson(
    entries.map((entry) => ({
      key: entry.key,
      source: entry.source,
      ref: entry.source === 'vault-ref' ? entry.ref : null,
    })),
  );
}

export class SqliteConfigProfileStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(): ConfigProfile[] {
    const rows = this.db
      .prepare('SELECT * FROM config_profiles ORDER BY name COLLATE NOCASE ASC, id ASC')
      .all() as unknown as ConfigProfileRow[];
    return rows.map((row) => toPublic(mapRow(row)));
  }

  get(id: string): ConfigProfile | null {
    const stored = this.getStored(id);
    return stored ? toPublic(stored) : null;
  }

  /** Internal read that includes the profile-owned vault secret names. */
  getStored(id: string): StoredConfigProfile | null {
    const row = this.db
      .prepare('SELECT * FROM config_profiles WHERE id = ?')
      .get(id) as unknown as ConfigProfileRow | undefined;
    return row ? mapRow(row) : null;
  }

  /** Case-insensitive lookup used for uniqueness checks. */
  getByName(name: string): ConfigProfile | null {
    const row = this.db
      .prepare('SELECT * FROM config_profiles WHERE name = ? COLLATE NOCASE')
      .get(name) as unknown as ConfigProfileRow | undefined;
    return row ? toPublic(mapRow(row)) : null;
  }

  insert(record: NewConfigProfileRecord): StoredConfigProfile {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO config_profiles
           (id, name, description, env_json, secret_keys_json, headers_json, env_file,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.description,
        encodeEntries(record.entries),
        toJson(record.ownedSecretNames),
        encodeEntries(record.headers),
        timestamp,
        timestamp,
      );
    const stored = this.getStored(record.id);
    if (!stored) throw new Error(`Configuration profile '${record.id}' disappeared after insert`);
    return stored;
  }

  replace(record: NewConfigProfileRecord): StoredConfigProfile {
    const result = this.db
      .prepare(
        `UPDATE config_profiles
            SET name = ?, description = ?, env_json = ?, secret_keys_json = ?,
                headers_json = ?, env_file = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        record.name,
        record.description,
        encodeEntries(record.entries),
        toJson(record.ownedSecretNames),
        encodeEntries(record.headers),
        nowIso(),
        record.id,
      );
    if (Number(result.changes) === 0) {
      throw invalidParams(`Configuration profile '${record.id}' was not found`);
    }
    const stored = this.getStored(record.id);
    if (!stored) throw new Error(`Configuration profile '${record.id}' disappeared after update`);
    return stored;
  }

  remove(id: string): boolean {
    const result = this.db.prepare('DELETE FROM config_profiles WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  // -------------------------------------------------------------------------
  // Server attachments (servers.config_profile_ids)
  // -------------------------------------------------------------------------

  profileIdsForServer(serverId: string): string[] {
    const row = this.db
      .prepare('SELECT config_profile_ids FROM servers WHERE id = ?')
      .get(serverId) as unknown as { config_profile_ids?: string } | undefined;
    if (!row) return [];
    return this.parseProfileIds(row.config_profile_ids);
  }

  setProfileIdsForServer(serverId: string, profileIds: string[]): void {
    const ids = [...new Set(profileIds.filter((id) => typeof id === 'string' && id !== ''))];
    const result = this.db
      .prepare('UPDATE servers SET config_profile_ids = ?, updated_at = ? WHERE id = ?')
      .run(toJson(ids), nowIso(), serverId);
    if (Number(result.changes) === 0) {
      throw invalidParams(`Unknown server '${serverId}'`);
    }
  }

  attachedServerIds(profileId: string): string[] {
    const rows = this.db
      .prepare('SELECT id, config_profile_ids FROM servers')
      .all() as unknown as Array<{ id: string; config_profile_ids?: string }>;
    return rows
      .filter((row) => this.parseProfileIds(row.config_profile_ids).includes(profileId))
      .map((row) => row.id);
  }

  /** Remove a profile id from every server; returns how many servers changed. */
  detachProfileFromAllServers(profileId: string): number {
    const rows = this.db
      .prepare('SELECT id, config_profile_ids FROM servers')
      .all() as unknown as Array<{ id: string; config_profile_ids?: string }>;
    let changed = 0;
    for (const row of rows) {
      const ids = this.parseProfileIds(row.config_profile_ids);
      if (!ids.includes(profileId)) continue;
      this.setProfileIdsForServer(
        row.id,
        ids.filter((id) => id !== profileId),
      );
      changed += 1;
    }
    return changed;
  }

  private parseProfileIds(raw: string | undefined): string[] {
    const parsed = parseJson<unknown>(raw, []);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string' && value !== '');
  }
}
