/**
 * SQLite-backed persistence for plugin-catalog sources (`catalog_sources` table,
 * schema v2 in `src/core/db.ts`).
 *
 * Only the NAME of the vault secret holding a clone token is ever stored here;
 * the token itself lives encrypted in `vault_secrets`.
 */
import type { DatabaseSync } from 'node:sqlite';

import { nowIso } from '../core/ids.js';
import { invalidParams } from '../core/errors.js';
import type { CatalogSource, CatalogSourceKind } from '../core/types.js';

export interface CatalogSourceStore {
  list(): CatalogSource[];
  get(id: string): CatalogSource | null;
  insert(source: CatalogSource): void;
  update(source: CatalogSource): void;
  delete(id: string): boolean;
}

interface CatalogSourceRow {
  id: string;
  label: string;
  kind: string;
  repo_url: string;
  ref: string | null;
  subpath: string | null;
  token_secret_name: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: CatalogSourceRow): CatalogSource {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind as CatalogSourceKind,
    repoUrl: row.repo_url,
    ref: row.ref ?? null,
    subpath: row.subpath ?? null,
    tokenSecretName: row.token_secret_name ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteCatalogSourceRepository implements CatalogSourceStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(): CatalogSource[] {
    const rows = this.db
      .prepare('SELECT * FROM catalog_sources ORDER BY created_at ASC, id ASC')
      .all() as unknown as CatalogSourceRow[];
    return rows.map(mapRow);
  }

  get(id: string): CatalogSource | null {
    const row = this.db
      .prepare('SELECT * FROM catalog_sources WHERE id = ?')
      .get(id) as unknown as CatalogSourceRow | undefined;
    return row ? mapRow(row) : null;
  }

  insert(source: CatalogSource): void {
    const now = source.createdAt || nowIso();
    try {
      this.db
        .prepare(
          `INSERT INTO catalog_sources
             (id, label, kind, repo_url, ref, subpath, token_secret_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          source.id,
          source.label,
          source.kind,
          source.repoUrl,
          source.ref ?? null,
          source.subpath ?? null,
          source.tokenSecretName ?? null,
          now,
          source.updatedAt || now,
        );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE constraint failed')) {
        // Ids come from `newId('cat')`; a collision is a programming error.
        throw invalidParams('A catalog source with that id already exists.', { id: source.id });
      }
      throw error;
    }
  }

  update(source: CatalogSource): void {
    this.db
      .prepare(
        `UPDATE catalog_sources
            SET label = ?, kind = ?, repo_url = ?, ref = ?, subpath = ?,
                token_secret_name = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        source.label,
        source.kind,
        source.repoUrl,
        source.ref ?? null,
        source.subpath ?? null,
        source.tokenSecretName ?? null,
        source.updatedAt || nowIso(),
        source.id,
      );
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM catalog_sources WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }
}
