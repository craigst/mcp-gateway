/**
 * SQLite-backed AES-256-GCM secret vault.
 *
 * Schema (owned by `src/core/db.ts`):
 *   vault_secrets(name PK, ciphertext, iv, auth_tag, key_version, created_at, updated_at)
 *
 * Only the ciphertext envelope is persisted; plaintext exists in memory for the
 * duration of a call. Listing never touches (or returns) ciphertext or values.
 */
import type { DatabaseSync } from 'node:sqlite';

import { ErrorCodes, GatewayError } from '../core/errors.js';
import { invalidParams } from '../core/errors.js';
import { nowIso } from '../core/ids.js';
import { createLogger } from '../core/logger.js';
import type { Logger } from '../core/logger.js';
import type { VaultSecretMetadata, VaultService } from '../core/ports.js';
import { decrypt, encrypt } from './crypto.js';

/** Secret names become environment variable names, so stay strictly POSIX-ish. */
export const VAULT_SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const MIN_SECRET_LENGTH = 16;

interface SecretRow {
  name: string;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  created_at: string;
  updated_at: string;
}

export interface SqliteVaultServiceOptions {
  logger?: Logger;
}

function vaultDisabledError(): GatewayError {
  return new GatewayError(ErrorCodes.NOT_IMPLEMENTED, 'Vault is not configured');
}

function assertSecretName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !VAULT_SECRET_NAME_PATTERN.test(name)) {
    throw invalidParams(
      'Invalid vault secret name: must match /^[A-Za-z_][A-Za-z0-9_]{0,63}$/',
      { name: typeof name === 'string' ? name : null },
    );
  }
}

function toMetadata(row: SecretRow): VaultSecretMetadata {
  return { name: row.name, createdAt: row.created_at, updatedAt: row.updated_at };
}

/**
 * Vault service backed by the gateway SQLite database.
 *
 * `secret` is `config.vaultSecret`; when it is absent (or shorter than 16
 * characters) the vault is disabled and secret material cannot be read or
 * written. Metadata-only operations (list) remain safe while disabled.
 */
export class SqliteVaultService implements VaultService {
  private readonly db: DatabaseSync;
  private readonly secret: string | null;
  private readonly logger: Logger;

  constructor(db: DatabaseSync, secret: string | null, options: SqliteVaultServiceOptions = {}) {
    this.db = db;
    this.secret = secret;
    this.logger = options.logger ?? createLogger('vault', 'silent');
  }

  isEnabled(): boolean {
    return this.secret !== null && this.secret.length >= MIN_SECRET_LENGTH;
  }

  setSecret(name: string, value: string): VaultSecretMetadata {
    assertSecretName(name);
    if (typeof value !== 'string') {
      throw invalidParams('Vault secret value must be a string', { name });
    }
    if (!this.isEnabled()) throw vaultDisabledError();

    const now = nowIso();
    const payload = encrypt(value, this.secret as string);
    this.db
      .prepare(
        `INSERT INTO vault_secrets (name, ciphertext, iv, auth_tag, key_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           iv = excluded.iv,
           auth_tag = excluded.auth_tag,
           key_version = excluded.key_version,
           updated_at = excluded.updated_at`,
      )
      .run(name, payload.ciphertext, payload.iv, payload.authTag, now, now);

    const row = this.db
      .prepare('SELECT name, ciphertext, iv, auth_tag, created_at, updated_at FROM vault_secrets WHERE name = ?')
      .get(name) as unknown as SecretRow | undefined;
    const metadata = row ? toMetadata(row) : { name, createdAt: now, updatedAt: now };
    this.logger.debug('Vault secret written', { name });
    return metadata;
  }

  getSecret(name: string): string | null {
    if (!this.isEnabled()) throw vaultDisabledError();

    const row = this.db
      .prepare('SELECT name, ciphertext, iv, auth_tag, created_at, updated_at FROM vault_secrets WHERE name = ?')
      .get(name) as unknown as SecretRow | undefined;
    if (row === undefined) return null;

    // `decrypt` fails closed with an opaque GatewayError on tamper/wrong key.
    return decrypt(
      { ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag },
      this.secret as string,
    );
  }

  listSecrets(): VaultSecretMetadata[] {
    const rows = this.db
      .prepare('SELECT name, ciphertext, iv, auth_tag, created_at, updated_at FROM vault_secrets ORDER BY name')
      .all() as unknown as SecretRow[];
    return rows.map(toMetadata);
  }

  deleteSecret(name: string): boolean {
    const result = this.db.prepare('DELETE FROM vault_secrets WHERE name = ?').run(name);
    const deleted = Number(result.changes) > 0;
    if (deleted) this.logger.debug('Vault secret deleted', { name });
    return deleted;
  }

  resolveSecrets(names: string[]): Record<string, string> {
    if (names.length === 0) return {};
    const resolved: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of names) {
      const value = this.getSecret(name);
      if (value === null) missing.push(name);
      else resolved[name] = value;
    }
    if (missing.length > 0) {
      // Only names are reported — never values or ciphertext.
      throw invalidParams(`Missing vault secret(s): ${missing.join(', ')}`, { missing });
    }
    return resolved;
  }
}
