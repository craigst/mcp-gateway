/**
 * Per-account email access decisions.
 *
 * The email MCP server is one server with one `email` grant per key, and every
 * tool takes an optional `account` selector. Account-level access therefore
 * lives beside the gateway RBAC data, in the shared gateway database:
 *
 *   no row                 -> inherited: the key may use the mailbox
 *   row with allowed = 0   -> the key may NOT use that mailbox
 *   row with allowed = 1   -> explicitly allowed (kept so the UI can show it)
 *
 * Access is enforced inside the email MCP server, using the `key_id` the
 * gateway puts in the JSON-RPC `_meta` of every tools/call. A missing key id
 * means an internal call (no tenant), and a master key is always allowed.
 */
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../core/ids.js';

interface AccessRow {
  key_id: string;
  account_id: string;
  allowed: number;
  updated_at: string;
}

export interface EmailAccountAccessRow {
  keyId: string;
  accountId: string;
  allowed: boolean;
  updatedAt: string;
}

/** Look up the gateway key type without requiring the full KeyService. */
export function lookupKeyType(db: DatabaseSync, keyId: string): string | null {
  const row = db.prepare('SELECT key_type FROM api_keys WHERE id = ?').get(keyId) as
    | { key_type?: string }
    | undefined;
  return typeof row?.key_type === 'string' ? row.key_type : null;
}

/** True when this key/account pair is permitted (unknown pairs inherit allow). */
export function isEmailAccountAllowed(db: DatabaseSync, keyId: string, accountId: string): boolean {
  const row = db
    .prepare('SELECT allowed FROM email_account_access WHERE key_id = ? AND account_id = ?')
    .get(keyId, accountId) as { allowed?: number } | undefined;
  return row === undefined ? true : row.allowed === 1;
}

export class EmailAccountAccessStore {
  constructor(private readonly db: DatabaseSync) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS email_account_access (
        key_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        allowed INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (key_id, account_id)
      );
      CREATE INDEX IF NOT EXISTS email_account_access_key_idx
        ON email_account_access(key_id);
    `);
  }

  /** Explicit decisions for one key, keyed by account id. */
  decisionsFor(keyId: string): Map<string, boolean> {
    const rows = this.db
      .prepare('SELECT * FROM email_account_access WHERE key_id = ?')
      .all(keyId) as unknown as AccessRow[];
    return new Map(rows.map((row) => [row.account_id, row.allowed === 1]));
  }

  isAllowed(keyId: string | null, accountId: string): boolean {
    if (keyId === null) return true;
    return isEmailAccountAllowed(this.db, keyId, accountId);
  }

  set(keyId: string, accountId: string, allowed: boolean): void {
    this.db
      .prepare(
        `INSERT INTO email_account_access (key_id, account_id, allowed, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key_id, account_id) DO UPDATE SET allowed = excluded.allowed, updated_at = excluded.updated_at`,
      )
      .run(keyId, accountId, allowed ? 1 : 0, nowIso());
  }

  /** Remove an explicit decision so the account inherits the default (allowed). */
  clear(keyId: string, accountId: string): void {
    this.db
      .prepare('DELETE FROM email_account_access WHERE key_id = ? AND account_id = ?')
      .run(keyId, accountId);
  }

  clearKey(keyId: string): void {
    this.db.prepare('DELETE FROM email_account_access WHERE key_id = ?').run(keyId);
  }

  listRows(): EmailAccountAccessRow[] {
    const rows = this.db
      .prepare('SELECT * FROM email_account_access ORDER BY key_id, account_id')
      .all() as unknown as AccessRow[];
    return rows.map((row) => ({
      keyId: row.key_id,
      accountId: row.account_id,
      allowed: row.allowed === 1,
      updatedAt: row.updated_at,
    }));
  }
}

export interface EmailToolAccessDecision {
  allowed: boolean;
  detail: string | null;
}

/**
 * Authorise one email MCP tool call for an account.
 *
 * `keyId` is the gateway key from `_meta`; `keyType` is resolved from the same
 * database. Missing identity (internal caller) and master keys bypass the
 * per-account layer; every other key is checked.
 */
export function checkEmailToolAccess(
  store: EmailAccountAccessStore,
  keyId: string | null,
  keyType: string | null,
  accountId: string,
  accountName: string,
): EmailToolAccessDecision {
  if (keyId === null || keyType === null || keyType === 'master') {
    return { allowed: true, detail: null };
  }
  if (store.isAllowed(keyId, accountId)) return { allowed: true, detail: null };
  return {
    allowed: false,
    detail: `Access denied: this API key is not permitted to use the "${accountName}" mailbox.`,
  };
}
