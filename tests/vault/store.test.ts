import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/core/db.js';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import { SqliteVaultService } from '../../src/vault/store.js';

const VALID_SECRET = 'unit-test-vault-secret-0123456789';
const OTHER_SECRET = 'unit-test-vault-secret-0123456789-rotated';

interface Harness {
  db: DatabaseSync;
  vault: SqliteVaultService;
}

const openDbs: DatabaseSync[] = [];
const tempDirs: string[] = [];

function makeHarness(secret: string | null): Harness {
  const db = openDatabase(':memory:');
  openDbs.push(db);
  return { db, vault: new SqliteVaultService(db, secret) };
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-vault-test-'));
  tempDirs.push(dir);
  return dir;
}

function captureGatewayError(run: () => unknown): GatewayError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }
  throw new Error('expected a GatewayError');
}

afterEach(() => {
  while (openDbs.length > 0) {
    const db = openDbs.pop();
    try {
      db?.close();
    } catch {
      // already closed by the test
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('SqliteVaultService', () => {
  describe('isEnabled', () => {
    it('is disabled without a secret', () => {
      const { vault } = makeHarness(null);
      expect(vault.isEnabled()).toBe(false);
    });

    it('is disabled for secrets shorter than 16 characters', () => {
      const { vault } = makeHarness('too-short');
      expect(vault.isEnabled()).toBe(false);
    });

    it('is enabled for secrets of at least 16 characters', () => {
      const { vault } = makeHarness('sixteen-chars-ok');
      expect(vault.isEnabled()).toBe(true);
    });
  });

  describe('disabled vault', () => {
    it('rejects reads and writes with NOT_IMPLEMENTED', () => {
      const { vault } = makeHarness(null);

      const writeError = captureGatewayError(() => vault.setSecret('API_TOKEN', 'value'));
      expect(writeError.code).toBe(ErrorCodes.NOT_IMPLEMENTED);
      expect(writeError.message).toBe('Vault is not configured');

      const readError = captureGatewayError(() => vault.getSecret('API_TOKEN'));
      expect(readError.code).toBe(ErrorCodes.NOT_IMPLEMENTED);
      expect(readError.message).toBe('Vault is not configured');

      const resolveError = captureGatewayError(() => vault.resolveSecrets(['API_TOKEN']));
      expect(resolveError.code).toBe(ErrorCodes.NOT_IMPLEMENTED);
    });

    it('still lists metadata safely and deletes leftovers', () => {
      const { vault } = makeHarness(null);
      expect(vault.listSecrets()).toEqual([]);
      expect(vault.deleteSecret('ANYTHING')).toBe(false);
    });
  });

  describe('secret name validation', () => {
    it.each(['', '1INVALID', 'has space', 'has-hyphen', 'a.b', 'x'.repeat(65)])(
      'rejects %j',
      (name) => {
        const { vault } = makeHarness(VALID_SECRET);
        const error = captureGatewayError(() => vault.setSecret(name, 'value'));
        expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
      },
    );

    it.each(['A', '_LEADING_UNDERSCORE', 'GITHUB_PAT_TOKEN', `a${'b'.repeat(63)}`])(
      'accepts %j',
      (name) => {
        const { vault } = makeHarness(VALID_SECRET);
        expect(vault.setSecret(name, 'value').name).toBe(name);
        expect(vault.getSecret(name)).toBe('value');
      },
    );
  });

  describe('CRUD', () => {
    it('creates, reads, updates and deletes a secret', () => {
      const { vault } = makeHarness(VALID_SECRET);
      const created = vault.setSecret('GITHUB_PAT_TOKEN', 'ghp_initial');

      expect(created.name).toBe('GITHUB_PAT_TOKEN');
      expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt);
      expect(new Date(created.updatedAt).toISOString()).toBe(created.updatedAt);
      expect(vault.getSecret('GITHUB_PAT_TOKEN')).toBe('ghp_initial');
      expect(vault.getSecret('MISSING')).toBeNull();

      const updated = vault.setSecret('GITHUB_PAT_TOKEN', 'ghp_rotated');
      expect(updated.createdAt).toBe(created.createdAt);
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(created.updatedAt).getTime(),
      );
      expect(vault.getSecret('GITHUB_PAT_TOKEN')).toBe('ghp_rotated');

      expect(vault.listSecrets()).toHaveLength(1);
      expect(vault.deleteSecret('GITHUB_PAT_TOKEN')).toBe(true);
      expect(vault.deleteSecret('GITHUB_PAT_TOKEN')).toBe(false);
      expect(vault.getSecret('GITHUB_PAT_TOKEN')).toBeNull();
      expect(vault.listSecrets()).toEqual([]);
    });

    it('stores only an encrypted envelope at rest', () => {
      const { db, vault } = makeHarness(VALID_SECRET);
      const plaintext = 'ghp_plaintext_must_not_leak_at_rest';
      vault.setSecret('GITHUB_PAT_TOKEN', plaintext);

      const row = db
        .prepare('SELECT ciphertext, iv, auth_tag FROM vault_secrets WHERE name = ?')
        .get('GITHUB_PAT_TOKEN') as Record<string, string> | undefined;
      expect(row).toBeDefined();
      expect(row?.ciphertext).toBeTruthy();
      expect(row?.iv).toBeTruthy();
      expect(row?.auth_tag).toBeTruthy();
      expect(JSON.stringify(row)).not.toContain(plaintext);
    });

    it('lists metadata only, never ciphertext or values', () => {
      const { vault } = makeHarness(VALID_SECRET);
      vault.setSecret('API_TOKEN', 'super-secret-value');
      vault.setSecret('DB_URL', 'postgres://user:pass@localhost/db');

      const entries = vault.listSecrets();
      expect(entries.map((entry) => entry.name)).toEqual(['API_TOKEN', 'DB_URL']);
      for (const entry of entries) {
        expect(Object.keys(entry).sort()).toEqual(['createdAt', 'name', 'updatedAt']);
      }
      const serialized = JSON.stringify(entries);
      expect(serialized).not.toContain('super-secret-value');
      expect(serialized).not.toContain('postgres://user:pass');
    });
  });

  describe('resolveSecrets', () => {
    it('returns an empty object for empty input', () => {
      const { vault } = makeHarness(VALID_SECRET);
      expect(vault.resolveSecrets([])).toEqual({});
    });

    it('resolves every requested secret', () => {
      const { vault } = makeHarness(VALID_SECRET);
      vault.setSecret('API_TOKEN', 'token-value');
      vault.setSecret('DB_URL', 'db-value');
      expect(vault.resolveSecrets(['API_TOKEN', 'DB_URL'])).toEqual({
        API_TOKEN: 'token-value',
        DB_URL: 'db-value',
      });
    });

    it('rejects listing the missing names, never values', () => {
      const { vault } = makeHarness(VALID_SECRET);
      vault.setSecret('API_TOKEN', 'secret-value-that-must-not-leak');
      const error = captureGatewayError(() =>
        vault.resolveSecrets(['API_TOKEN', 'MISSING_ONE', 'MISSING_TWO']),
      );
      expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
      expect(error.message).toContain('MISSING_ONE');
      expect(error.message).toContain('MISSING_TWO');
      expect(error.message).not.toContain('secret-value-that-must-not-leak');
    });
  });

  describe('persistence and key rotation', () => {
    it('persists secrets across a database reopen with the same secret', () => {
      const dir = makeTempDir();
      const dbPath = join(dir, 'gateway.db');

      const firstDb = openDatabase(dbPath);
      const firstVault = new SqliteVaultService(firstDb, VALID_SECRET);
      firstVault.setSecret('PERSISTED_TOKEN', 'persisted-value');
      firstDb.close();

      const secondDb = openDatabase(dbPath);
      openDbs.push(secondDb);
      const secondVault = new SqliteVaultService(secondDb, VALID_SECRET);
      expect(secondVault.getSecret('PERSISTED_TOKEN')).toBe('persisted-value');
      expect(secondVault.listSecrets()).toHaveLength(1);
    });

    it('fails closed when reopened with the wrong secret', () => {
      const { db, vault } = makeHarness(VALID_SECRET);
      vault.setSecret('API_TOKEN', 'never-leak-me');

      const rotated = new SqliteVaultService(db, OTHER_SECRET);
      const error = captureGatewayError(() => rotated.getSecret('API_TOKEN'));
      expect(error.code).toBe(ErrorCodes.INTERNAL_ERROR);
      expect(error.message).toBe('Vault decryption failed: authentication tag mismatch');
      expect(error.message).not.toContain('never-leak-me');

      // Metadata-only access still works while the key is wrong.
      expect(rotated.listSecrets().map((entry) => entry.name)).toEqual(['API_TOKEN']);
    });
  });
});
