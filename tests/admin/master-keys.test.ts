import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MasterKeyControl } from '../../src/admin/master-keys.js';
import { openDatabase } from '../../src/core/db.js';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import { createLogger } from '../../src/core/logger.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';

describe('MasterKeyControl', () => {
  let db: DatabaseSync;
  let keys: SqliteKeyService;
  let control: MasterKeyControl;

  beforeEach(() => {
    db = openDatabase(':memory:');
    keys = new SqliteKeyService(db, { pepper: 'test-pepper', logger: createLogger('test', 'silent') });
    control = new MasterKeyControl({ keys, logger: createLogger('test', 'silent') });
  });

  afterEach(() => {
    db.close();
  });

  function authError(plaintext: string): GatewayError {
    try {
      keys.authenticate(plaintext);
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      return error as GatewayError;
    }
    throw new Error('Expected authentication to fail.');
  }

  it('issues a new master key whose plaintext authenticates', () => {
    const result = control.regenerate();

    expect(result.plaintext).toMatch(/^mcp_master_/);
    expect(result.revokedCount).toBe(0);
    expect(result.key.keyType).toBe('master');
    expect(result.key.name).toBe('web-ui-master');
    expect(result.key.revokedAt).toBeNull();
    expect(result.key.serverGrants).toEqual([]);
    expect(result.key.delegationAllowed).toBe(true);
    expect(result.key.escalationAllowed).toBe(true);

    const authenticated = keys.authenticate(result.plaintext);
    expect(authenticated.id).toBe(result.key.id);
    expect(authenticated.keyType).toBe('master');
    expect(authenticated.keyPrefix).toBe(result.key.keyPrefix);
  });

  it('revokes the previous master key by default', () => {
    const first = control.regenerate();
    const second = control.regenerate();

    expect(second.revokedCount).toBe(1);
    expect(second.key.id).not.toBe(first.key.id);

    const error = authError(first.plaintext);
    expect(error.code).toBe(ErrorCodes.KEY_INVALID);
    expect(error.data?.reason).toBe('KEY_REVOKED');
    expect(keys.get(first.key.id)?.revokedAt).not.toBeNull();

    expect(keys.authenticate(second.plaintext).id).toBe(second.key.id);
    expect(keys.get(second.key.id)?.revokedAt).toBeNull();
  });

  it('keeps previous master keys when revokePrevious is false', () => {
    const first = control.regenerate();
    const second = control.regenerate({ revokePrevious: false });

    expect(second.revokedCount).toBe(0);
    expect(keys.authenticate(first.plaintext).id).toBe(first.key.id);
    expect(keys.authenticate(second.plaintext).id).toBe(second.key.id);
    expect(keys.get(first.key.id)?.revokedAt).toBeNull();

    // A later default rotation then revokes both older master keys.
    const third = control.regenerate();
    expect(third.revokedCount).toBe(2);
    expect(() => keys.authenticate(first.plaintext)).toThrowError(GatewayError);
    expect(() => keys.authenticate(second.plaintext)).toThrowError(GatewayError);
    expect(keys.authenticate(third.plaintext).id).toBe(third.key.id);
  });

  it('does not revoke non-master keys', () => {
    const agent = keys.issue({
      name: 'ci-agent',
      keyType: 'agent',
      serverGrants: [],
      delegationAllowed: false,
      escalationAllowed: true,
    });

    const rotated = control.regenerate();

    expect(rotated.revokedCount).toBe(0);
    expect(keys.get(agent.key.id)?.revokedAt).toBeNull();
    const authenticated = keys.authenticate(agent.plaintext);
    expect(authenticated.id).toBe(agent.key.id);
    expect(authenticated.keyType).toBe('agent');
  });

  it('never persists the plaintext', () => {
    const result = control.regenerate();
    const records = keys.list();

    expect(records.length).toBe(1);
    for (const record of records) {
      expect(record).not.toHaveProperty('plaintext');
      expect(record).not.toHaveProperty('key');
    }
    expect(JSON.stringify(records)).not.toContain(result.plaintext);
    // The hash — not the plaintext — is what is stored.
    expect(records[0]?.keyHash).not.toBe(result.plaintext);
    expect(records[0]?.keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses a custom name (trimmed) when provided', () => {
    const result = control.regenerate({ name: '  ops-rotation  ' });

    expect(result.key.name).toBe('ops-rotation');
    expect(keys.authenticate(result.plaintext).name).toBe('ops-rotation');
    expect(keys.list().map((record) => record.name)).toEqual(['ops-rotation']);
  });

  it('rejects an empty or non-string name without issuing a key', () => {
    for (const name of ['', '   ', 42 as unknown as string, null as unknown as string]) {
      expect(() => control.regenerate({ name })).toThrowError(GatewayError);
      try {
        control.regenerate({ name });
      } catch (error) {
        expect((error as GatewayError).code).toBe(ErrorCodes.INVALID_PARAMS);
      }
    }
    expect(keys.list()).toEqual([]);
  });
});
