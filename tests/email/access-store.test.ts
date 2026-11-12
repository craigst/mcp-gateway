/**
 * v0.15 email access control — per-account decision store.
 *
 * The store is the SQLite half of "which mailbox may this API key use":
 *   no row                 -> inherited allow
 *   row with allowed = 0   -> denied
 *   row with allowed = 1   -> explicit allow (kept so the console can show it)
 *
 * Access is decided inside the email MCP server from the `key_id` in the
 * JSON-RPC `_meta`, so internal calls (no key id) and master keys bypass it.
 */
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/core/db.js';
import { createLogger } from '../../src/core/logger.js';
import {
  EmailAccountAccessStore,
  checkEmailToolAccess,
  isEmailAccountAllowed,
  lookupKeyType,
} from '../../src/email/access-store.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';

const silent = createLogger('test', 'silent');

let db: DatabaseSync;
let store: EmailAccountAccessStore;

beforeEach(() => {
  db = openDatabase(':memory:');
  store = new EmailAccountAccessStore(db);
});

afterEach(() => {
  db.close();
});

describe('EmailAccountAccessStore', () => {
  it('allows an account by default when no decision row exists', () => {
    // No row at all is the inherited default: the key may use the mailbox.
    expect(store.decisionsFor('key_agent').size).toBe(0);
    expect(store.isAllowed('key_agent', 'email_work')).toBe(true);
    expect(store.isAllowed(null, 'email_work')).toBe(true);
    expect(isEmailAccountAllowed(db, 'key_agent', 'email_work')).toBe(true);
    // Reading decisions also never invents rows.
    expect(store.listRows()).toEqual([]);
  });

  it('denies an account once an explicit false decision is stored', () => {
    store.set('key_agent', 'email_work', false);

    expect(store.isAllowed('key_agent', 'email_work')).toBe(false);
    expect(isEmailAccountAllowed(db, 'key_agent', 'email_work')).toBe(false);
    expect(store.decisionsFor('key_agent').get('email_work')).toBe(false);
    // Other accounts and other keys still inherit the default allow.
    expect(store.isAllowed('key_agent', 'email_personal')).toBe(true);
    expect(store.isAllowed('key_other', 'email_work')).toBe(true);

    const rows = store.listRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ keyId: 'key_agent', accountId: 'email_work', allowed: false });
    expect(typeof rows[0]?.updatedAt).toBe('string');
  });

  it('allows an account again after the decision is cleared', () => {
    store.set('key_agent', 'email_work', false);
    expect(store.isAllowed('key_agent', 'email_work')).toBe(false);

    store.clear('key_agent', 'email_work');

    expect(store.isAllowed('key_agent', 'email_work')).toBe(true);
    expect(isEmailAccountAllowed(db, 'key_agent', 'email_work')).toBe(true);
    expect(store.decisionsFor('key_agent').size).toBe(0);
  });

  it('keeps explicit allow decisions so the console can show them', () => {
    store.set('key_agent', 'email_work', true);
    store.set('key_agent', 'email_personal', true);
    store.set('key_other', 'email_work', false);

    const decisions = store.decisionsFor('key_agent');
    expect(decisions.size).toBe(2);
    expect(decisions.get('email_work')).toBe(true);
    expect(decisions.get('email_personal')).toBe(true);
    expect(store.isAllowed('key_agent', 'email_work')).toBe(true);
    expect(store.decisionsFor('key_other').get('email_work')).toBe(false);
  });

  it('clears every decision for one key without touching other keys', () => {
    store.set('key_agent', 'email_work', false);
    store.set('key_agent', 'email_personal', false);
    store.set('key_other', 'email_work', false);

    store.clearKey('key_agent');

    expect(store.decisionsFor('key_agent').size).toBe(0);
    expect(store.isAllowed('key_agent', 'email_work')).toBe(true);
    expect(store.decisionsFor('key_other').get('email_work')).toBe(false);
  });
});

describe('lookupKeyType', () => {
  it('resolves the persisted key type and returns null for unknown ids', () => {
    const keys = new SqliteKeyService(db, { logger: silent });
    const agent = keys.issue({ name: 'agent', keyType: 'agent' });
    const master = keys.issue({ name: 'master', keyType: 'master' });

    expect(lookupKeyType(db, agent.key.id)).toBe('agent');
    expect(lookupKeyType(db, master.key.id)).toBe('master');
    expect(lookupKeyType(db, 'key_missing')).toBeNull();
  });
});

describe('checkEmailToolAccess', () => {
  const WORK_NAME = 'Work Mailbox';

  it('bypasses the decision for internal calls (no key) and master keys', () => {
    expect(checkEmailToolAccess(store, null, null, 'email_work', WORK_NAME)).toEqual({
      allowed: true,
      detail: null,
    });
    // A key id whose type cannot be resolved is treated as internal too.
    expect(checkEmailToolAccess(store, 'key_missing', null, 'email_work', WORK_NAME)).toEqual({
      allowed: true,
      detail: null,
    });
    expect(checkEmailToolAccess(store, 'key_master', 'master', 'email_work', WORK_NAME)).toEqual({
      allowed: true,
      detail: null,
    });

    // A stored denial must not affect either bypass path.
    store.set('key_master', 'email_work', false);
    expect(checkEmailToolAccess(store, 'key_master', 'master', 'email_work', WORK_NAME).allowed).toBe(true);
    expect(checkEmailToolAccess(store, null, null, 'email_work', WORK_NAME).allowed).toBe(true);
  });

  it('allows a normal key for an account it has no decision about', () => {
    expect(checkEmailToolAccess(store, 'key_agent', 'agent', 'email_work', WORK_NAME)).toEqual({
      allowed: true,
      detail: null,
    });
  });

  it('denies a normal key on an explicitly disabled mailbox and names the mailbox', () => {
    store.set('key_agent', 'email_work', false);

    const decision = checkEmailToolAccess(store, 'key_agent', 'agent', 'email_work', WORK_NAME);

    expect(decision.allowed).toBe(false);
    expect(decision.detail).toContain('Access denied');
    // The detail is shown to the caller, so it must identify the mailbox by name.
    expect(decision.detail).toContain(`"${WORK_NAME}"`);
    // A different key or a different account is unaffected.
    expect(checkEmailToolAccess(store, 'key_other', 'agent', 'email_work', WORK_NAME).allowed).toBe(true);
    expect(checkEmailToolAccess(store, 'key_agent', 'agent', 'email_personal', 'Personal Mailbox').allowed).toBe(true);
  });
});
