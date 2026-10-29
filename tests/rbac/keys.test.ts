import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/core/db.js';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import { KEY_PREFIX_BY_TYPE, KEY_TYPES, type CreateKeyInput } from '../../src/core/types.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';

let db: DatabaseSync;
let keys: SqliteKeyService;

beforeEach(() => {
  db = openDatabase(':memory:');
  keys = new SqliteKeyService(db);
});

afterEach(() => {
  db.close();
});

function gatewayError(fn: () => unknown): GatewayError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }
  throw new Error('Expected the function to throw a GatewayError.');
}

function randomPlaintext(keyType: keyof typeof KEY_PREFIX_BY_TYPE): string {
  return `${KEY_PREFIX_BY_TYPE[keyType]}${randomBytes(32).toString('base64url')}`;
}

describe('SqliteKeyService.issue', () => {
  it('generates correct plaintext formats and prefixes for every key type', () => {
    const seen = new Set<string>();
    for (const keyType of KEY_TYPES) {
      const issued = keys.issue({ name: `${keyType}-key`, keyType });
      const prefix = KEY_PREFIX_BY_TYPE[keyType];

      expect(issued.plaintext.startsWith(prefix)).toBe(true);
      // 32 random bytes base64url-encoded = 43 characters.
      expect(issued.plaintext.length).toBe(prefix.length + 43);
      expect(issued.key.keyPrefix).toBe(issued.plaintext.slice(0, 12));
      expect(issued.key.keyType).toBe(keyType);
      expect(issued.key.id).toMatch(/^key_[0-9a-f]+$/);
      expect(issued.key.name).toBe(`${keyType}-key`);
      seen.add(issued.plaintext);
    }
    expect(seen.size).toBe(KEY_TYPES.length);
  });

  it('stores only a SHA-256 hash of the plaintext and returns plaintext exactly once', () => {
    const issued = keys.issue({ name: 'agent', keyType: 'agent' });
    const stored = keys.get(issued.key.id);

    expect(stored).not.toBeNull();
    expect(stored?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.keyHash).toBe(createHash('sha256').update(issued.plaintext).digest('hex'));
    expect(stored?.keyHash).not.toBe(issued.plaintext);
    // The record itself never carries the plaintext...
    expect('plaintext' in (stored as unknown as Record<string, unknown>)).toBe(false);
    expect('plaintext' in (issued.key as unknown as Record<string, unknown>)).toBe(false);
    // ...and neither does the listing.
    expect(JSON.stringify(keys.list())).not.toContain(issued.plaintext);
  });

  it('round-trips grants, flags, metadata and expiry', () => {
    const issued = keys.issue({
      name: 'scoped-agent',
      keyType: 'agent',
      serverGrants: [
        {
          serverId: 'srv_pg',
          tools: ['read_query'],
          highPrivilegeTools: ['drop_table'],
          guardrails: [
            {
              kind: 'regex_applied_to_arguments',
              pattern: '\\bDROP\\b',
              message: 'no destructive SQL',
            },
          ],
        },
      ],
      delegationAllowed: true,
      escalationAllowed: true,
      expiresInSeconds: 3600,
      metadata: { owner: 'alice', team: 'data' },
    });

    const stored = keys.get(issued.key.id);
    expect(stored?.serverGrants).toEqual([
      {
        serverId: 'srv_pg',
        tools: ['read_query'],
        highPrivilegeTools: ['drop_table'],
        guardrails: [
          {
            tool: null,
            kind: 'regex_applied_to_arguments',
            pattern: '\\bDROP\\b',
            message: 'no destructive SQL',
          },
        ],
        pausedTools: null,
      },
    ]);
    expect(stored?.delegationAllowed).toBe(true);
    expect(stored?.escalationAllowed).toBe(true);
    expect(stored?.metadata).toEqual({ owner: 'alice', team: 'data' });
    expect(stored?.expiresAt).not.toBeNull();
    expect(Date.parse(stored?.expiresAt ?? '')).toBeGreaterThan(Date.now());
    expect(stored?.revokedAt).toBeNull();
    expect(stored?.lastUsedAt).toBeNull();
  });

  it('treats zero and negative lifetimes as immediately expired', () => {
    const zero = keys.issue({ name: 'zero', keyType: 'agent', expiresInSeconds: 0 });
    expect(Date.parse(zero.key.expiresAt ?? '')).toBeLessThanOrEqual(Date.now());
    const err = gatewayError(() => keys.authenticate(zero.plaintext));
    expect(err.code).toBe(ErrorCodes.KEY_INVALID);
    expect(err.data?.reason).toBe('KEY_EXPIRED');

    const negative = keys.issue({ name: 'negative', keyType: 'agent', expiresInSeconds: -60 });
    expect(Date.parse(negative.key.expiresAt ?? '')).toBeLessThan(Date.now());
    expect(gatewayError(() => keys.authenticate(negative.plaintext)).data?.reason).toBe(
      'KEY_EXPIRED',
    );
  });

  it('honours an explicit expiresAt timestamp', () => {
    const issued = keys.issue({
      name: 'explicit',
      keyType: 'agent',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    expect(issued.key.expiresAt).toBe('2020-01-01T00:00:00.000Z');
    expect(gatewayError(() => keys.authenticate(issued.plaintext)).data?.reason).toBe(
      'KEY_EXPIRED',
    );
  });

  it('validates name, key type, grants and guardrails', () => {
    expect(gatewayError(() => keys.issue({ name: '   ', keyType: 'agent' })).code).toBe(
      ErrorCodes.INVALID_PARAMS,
    );
    expect(
      gatewayError(() => keys.issue({ name: 'x', keyType: 'nope' as never })).code,
    ).toBe(ErrorCodes.INVALID_PARAMS);
    expect(
      gatewayError(() =>
        keys.issue({
          name: 'x',
          keyType: 'agent',
          serverGrants: [{ serverId: '' }],
        }),
      ).code,
    ).toBe(ErrorCodes.INVALID_PARAMS);
    expect(
      gatewayError(() =>
        keys.issue({
          name: 'x',
          keyType: 'agent',
          serverGrants: [
            {
              serverId: 'srv',
              guardrails: [{ kind: 'regex_applied_to_arguments', pattern: '(' }],
            },
          ],
        }),
      ).code,
    ).toBe(ErrorCodes.INVALID_PARAMS);
    expect(
      gatewayError(() =>
        keys.issue({
          name: 'x',
          keyType: 'agent',
          serverGrants: [{ serverId: 'srv', guardrails: [{ kind: 'bogus' as never }] }],
        }),
      ).code,
    ).toBe(ErrorCodes.INVALID_PARAMS);
    expect(
      gatewayError(() =>
        keys.issue({ name: 'x', keyType: 'agent', expiresAt: 'not-a-date' }),
      ).code,
    ).toBe(ErrorCodes.INVALID_PARAMS);
  });
});

describe('SqliteKeyService.authenticate', () => {
  it('authenticates a valid key, records last_used_at and omits the hash', () => {
    const issued = keys.issue({ name: 'agent', keyType: 'agent' });
    const authenticated = keys.authenticate(issued.plaintext);

    expect(authenticated.id).toBe(issued.key.id);
    expect(authenticated.plaintext).toBe(issued.plaintext);
    expect('keyHash' in (authenticated as unknown as Record<string, unknown>)).toBe(false);
    expect(authenticated.lastUsedAt).not.toBeNull();
    expect(keys.get(issued.key.id)?.lastUsedAt).toBe(authenticated.lastUsedAt);
  });

  it('rejects unknown, empty and malformed keys with INVALID_API_KEY', () => {
    for (const candidate of ['mcp_ag_unknown', '', 'not-a-key']) {
      const err = gatewayError(() => keys.authenticate(candidate));
      expect(err.code).toBe(ErrorCodes.KEY_INVALID);
      expect(err.data?.status).toBe('UNAUTHORIZED');
      expect(err.data?.reason).toBe('INVALID_API_KEY');
    }
  });

  it('rejects revoked keys with KEY_REVOKED', () => {
    const issued = keys.issue({ name: 'agent', keyType: 'agent' });
    const revoked = keys.revoke(issued.key.id);
    expect(revoked.revokedAt).not.toBeNull();
    expect(keys.get(issued.key.id)?.revokedAt).toBe(revoked.revokedAt);

    const err = gatewayError(() => keys.authenticate(issued.plaintext));
    expect(err.code).toBe(ErrorCodes.KEY_INVALID);
    expect(err.data?.reason).toBe('KEY_REVOKED');
  });

  it('keeps revocation idempotent', () => {
    const issued = keys.issue({ name: 'agent', keyType: 'agent' });
    const first = keys.revoke(issued.key.id);
    const second = keys.revoke(issued.key.id);
    expect(second.revokedAt).toBe(first.revokedAt);
  });

  it('rejects missing keys on revoke with INVALID_PARAMS', () => {
    expect(gatewayError(() => keys.revoke('key_missing')).code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it('uses the configured pepper when hashing', () => {
    const peppered = new SqliteKeyService(db, { pepper: 'secret-pepper' });
    const issued = peppered.issue({ name: 'peppered', keyType: 'agent' });
    expect(keys.get(issued.key.id)?.keyHash).toBe(
      createHash('sha256').update(`secret-pepper${issued.plaintext}`).digest('hex'),
    );
    // A service with a different pepper cannot authenticate the key.
    expect(gatewayError(() => keys.authenticate(issued.plaintext)).data?.reason).toBe(
      'INVALID_API_KEY',
    );
    expect(peppered.authenticate(issued.plaintext).id).toBe(issued.key.id);
  });
});

describe('SqliteKeyService.importKey', () => {
  it('imports a bootstrap master key with matching prefix and returns the record', () => {
    const plaintext = randomPlaintext('master');
    const record = keys.importKey(plaintext, { name: 'bootstrap', keyType: 'master' });

    expect(record.keyType).toBe('master');
    expect(record.keyPrefix).toBe(plaintext.slice(0, 12));
    expect(record.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.authenticate(plaintext).id).toBe(record.id);
    expect(keys.list()).toHaveLength(1);
  });

  it('rejects a prefix that does not match the key type', () => {
    const err = gatewayError(() =>
      keys.importKey(randomPlaintext('agent'), { name: 'bad', keyType: 'master' }),
    );
    expect(err.code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it('rejects duplicate hashes on import', () => {
    const plaintext = randomPlaintext('master');
    keys.importKey(plaintext, { name: 'bootstrap', keyType: 'master' });
    const err = gatewayError(() =>
      keys.importKey(plaintext, { name: 'again', keyType: 'master' }),
    );
    expect(err.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(keys.list()).toHaveLength(1);
  });
});

describe('SqliteKeyService.list / get / purgeExpired', () => {
  it('lists keys without exposing plaintext and keeps hashes stable', () => {
    const a = keys.issue({ name: 'a', keyType: 'agent' });
    const b = keys.issue({ name: 'b', keyType: 'dev' });
    const listed = keys.list();

    expect(listed.map((record) => record.id).sort()).toEqual([a.key.id, b.key.id].sort());
    expect(JSON.stringify(listed)).not.toContain(a.plaintext);
    expect(JSON.stringify(listed)).not.toContain(b.plaintext);
    for (const record of listed) expect(record.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.get('key_unknown')).toBeNull();
  });

  it('purges only expired keys and returns the count', () => {
    const live = keys.issue({ name: 'live', keyType: 'agent' });
    const forever = keys.issue({ name: 'forever', keyType: 'agent' });
    const expired = keys.issue({ name: 'expired', keyType: 'agent', expiresInSeconds: -1 });

    expect(keys.purgeExpired()).toBe(1);
    expect(keys.get(expired.key.id)).toBeNull();
    expect(keys.get(live.key.id)).not.toBeNull();
    expect(keys.get(forever.key.id)).not.toBeNull();
    expect(keys.purgeExpired()).toBe(0);
  });

  it('accepts an explicit clock for purgeExpired', () => {
    const issued = keys.issue({ name: 'soon', keyType: 'agent', expiresInSeconds: 3600 });
    expect(keys.purgeExpired(new Date(Date.now() + 2 * 3600 * 1000))).toBe(1);
    expect(keys.get(issued.key.id)).toBeNull();
  });
});

describe('SqliteKeyService input contract', () => {
  it('accepts a CreateKeyInput and returns IssuedKey matching the ports contract', () => {
    const input: CreateKeyInput = {
      name: 'contract',
      keyType: 'dev',
      serverGrants: [{ serverId: 'srv_x', tools: [] }],
    };
    const issued = keys.issue(input);
    expect(issued.key.serverGrants).toEqual([
      { serverId: 'srv_x', tools: [], highPrivilegeTools: null, guardrails: [], pausedTools: null },
    ]);
    expect(typeof issued.plaintext).toBe('string');
    expect(Date.parse(issued.key.createdAt)).not.toBeNaN();
  });
});
