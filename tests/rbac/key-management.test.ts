import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/core/db.js';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import { createLogger } from '../../src/core/logger.js';
import type { CreateKeyInput, ServerGrant } from '../../src/core/types.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';

let db: DatabaseSync;
let keys: SqliteKeyService;

const silent = createLogger('test', 'silent');

beforeEach(() => {
  db = openDatabase(':memory:');
  keys = new SqliteKeyService(db, { logger: silent });
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

function issue(overrides: Partial<CreateKeyInput> = {}) {
  return keys.issue({ name: 'agent', keyType: 'agent', ...overrides });
}

describe('SqliteKeyService.update', () => {
  it('renames a key, trims the name and returns the record', () => {
    const issued = issue();
    const updated = keys.update(issued.key.id, { name: '  renamed-agent  ' });

    expect(updated.name).toBe('renamed-agent');
    expect(updated.id).toBe(issued.key.id);
    expect(keys.get(issued.key.id)?.name).toBe('renamed-agent');
    // The plaintext key keeps authenticating after a rename.
    expect(keys.authenticate(issued.plaintext).id).toBe(issued.key.id);
  });

  it('validates rename input', () => {
    const issued = issue();
    expect(gatewayError(() => keys.update(issued.key.id, { name: '' })).code).toBe(
      ErrorCodes.INVALID_PARAMS,
    );
    expect(gatewayError(() => keys.update(issued.key.id, { name: '   ' })).code).toBe(
      ErrorCodes.INVALID_PARAMS,
    );
    expect(gatewayError(() => keys.update(issued.key.id, { name: 'x'.repeat(121) })).code).toBe(
      ErrorCodes.INVALID_PARAMS,
    );
    expect(gatewayError(() => keys.update(issued.key.id, { name: 42 as never })).code).toBe(
      ErrorCodes.INVALID_PARAMS,
    );
    expect(keys.get(issued.key.id)?.name).toBe('agent');
  });

  it('throws for unknown key ids', () => {
    const error = gatewayError(() => keys.update('key_missing', { name: 'x' }));
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(error.message).toContain('was not found');
  });

  it('replaces grants, including pause flags, and preserves them on read', () => {
    const issued = issue();
    const grants: ServerGrant[] = [
      {
        serverId: 'srv_a',
        tools: ['read_query', 'write_query'],
        highPrivilegeTools: ['danger_delete'],
        paused: true,
        pausedTools: ['write_query'],
      },
      { serverId: 'srv_b', tools: null },
    ];
    const updated = keys.update(issued.key.id, { serverGrants: grants });

    expect(updated.serverGrants).toEqual([
      {
        serverId: 'srv_a',
        tools: ['read_query', 'write_query'],
        highPrivilegeTools: ['danger_delete'],
        guardrails: [],
        paused: true,
        pausedTools: ['write_query'],
      },
      { serverId: 'srv_b', tools: null, highPrivilegeTools: null, guardrails: [], pausedTools: null },
    ]);
    expect(keys.get(issued.key.id)?.serverGrants).toEqual(updated.serverGrants);
  });

  it('validates grant pause fields and duplicates', () => {
    const issued = issue();
    const badGrants: unknown[] = [
      [{ serverId: 'srv_a' }, { serverId: 'srv_a' }],
      [{ serverId: 'srv_a', paused: 'yes' }],
      [{ serverId: 'srv_a', pausedTools: 'tool' }],
      [{ serverId: 'srv_a', pausedTools: ['tool', 'tool'] }],
      [{ serverId: 'srv_a', tools: ['t', 't'] }],
      [{ serverId: 'srv_a', tools: [''] }],
      [{ serverId: '' }],
      'not-an-array',
    ];
    for (const serverGrants of badGrants) {
      const error = gatewayError(() =>
        keys.update(issued.key.id, { serverGrants: serverGrants as ServerGrant[] }),
      );
      expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
    }
    // The failed updates must not change the stored grants.
    expect(keys.get(issued.key.id)?.serverGrants).toEqual([]);
  });

  it('sets and clears expiry', () => {
    const issued = issue();
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(keys.update(issued.key.id, { expiresAt: future }).expiresAt).toBe(future);
    expect(keys.update(issued.key.id, { expiresAt: null }).expiresAt).toBeNull();
    expect(
      gatewayError(() => keys.update(issued.key.id, { expiresAt: 'not-a-date' })).code,
    ).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it('leaves untouched fields unchanged on a partial update', () => {
    const issued = issue({
      serverGrants: [{ serverId: 'srv_a', tools: ['read_query'] }],
      escalationAllowed: true,
    });
    const before = keys.get(issued.key.id);
    const updated = keys.update(issued.key.id, { name: 'partial' });

    expect(updated.name).toBe('partial');
    expect(updated.serverGrants).toEqual(before?.serverGrants);
    expect(updated.expiresAt).toBe(before?.expiresAt);
    expect(updated.pausedAt).toBeNull();
    expect(updated.escalationAllowed).toBe(true);
    expect(updated.keyHash).toBe(before?.keyHash);
  });
});

describe('SqliteKeyService.pause / resume', () => {
  it('pauses and resumes a key, returning pausedAt in every record', () => {
    const issued = issue();
    expect(issued.key.pausedAt).toBeNull();
    expect(keys.get(issued.key.id)?.pausedAt).toBeNull();

    const paused = keys.pause(issued.key.id);
    expect(paused.pausedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(paused.pausedAt ?? ''))).toBe(false);
    expect(keys.get(issued.key.id)?.pausedAt).toBe(paused.pausedAt);
    expect(keys.list()[0]?.pausedAt).toBe(paused.pausedAt);

    const resumed = keys.resume(issued.key.id);
    expect(resumed.pausedAt).toBeNull();
    expect(keys.get(issued.key.id)?.pausedAt).toBeNull();
  });

  it('keeps the original pause timestamp on repeated pause calls', () => {
    const issued = issue();
    const first = keys.pause(issued.key.id);
    const second = keys.pause(issued.key.id);
    expect(second.pausedAt).toBe(first.pausedAt);
  });

  it('resume is idempotent and safe for a non-paused key', () => {
    const issued = issue();
    expect(keys.resume(issued.key.id).pausedAt).toBeNull();
    expect(keys.resume(issued.key.id).pausedAt).toBeNull();
  });

  it('supports pausing via update({paused})', () => {
    const issued = issue();
    const paused = keys.update(issued.key.id, { paused: true });
    expect(paused.pausedAt).not.toBeNull();
    const still = keys.update(issued.key.id, { paused: true });
    expect(still.pausedAt).toBe(paused.pausedAt);
    expect(keys.update(issued.key.id, { paused: false }).pausedAt).toBeNull();
    expect(gatewayError(() => keys.update(issued.key.id, { paused: 'yes' as never })).code).toBe(
      ErrorCodes.INVALID_PARAMS,
    );
  });

  it('throws for unknown key ids', () => {
    expect(gatewayError(() => keys.pause('key_missing')).code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(gatewayError(() => keys.resume('key_missing')).code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it('keeps authentication working at the key-service layer (request path enforces pauses)', () => {
    const issued = issue();
    keys.pause(issued.key.id);
    // KeyService.authenticate intentionally stays usable so admins can inspect keys;
    // the ingress (authenticateRequest) rejects paused keys.
    expect(keys.authenticate(issued.plaintext).pausedAt).not.toBeNull();
  });
});
