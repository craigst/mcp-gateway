/**
 * Email triage settings — the switch that decides which mailboxes are read.
 *
 * The contract worth protecting here is "off by default": a mailbox with no
 * row, or a disabled account, must never appear in `enabledAccounts`, because
 * that list is the only thing the watcher is allowed to read from.
 */
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/core/db.js';
import { EmailTriageStore } from '../../src/email/triage-store.js';
import type { EmailAccount } from '../../src/email/types.js';

function account(id: string, email: string, enabled = true): EmailAccount {
  return {
    id,
    name: id,
    email,
    displayName: '',
    kind: 'imap',
    enabled,
    isDefault: false,
    imapHost: '127.0.0.1',
    imapPort: 143,
    imapSecure: false,
    imapStartTls: true,
    imapUser: email,
    smtpHost: '127.0.0.1',
    smtpPort: 25,
    smtpSecure: false,
    smtpUser: email,
    fromAddress: email,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastTestAt: null,
    lastTestOk: null,
    lastError: null,
  };
}

describe('EmailTriageStore', () => {
  let db: DatabaseSync;
  let store: EmailTriageStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new EmailTriageStore(db);
  });

  it('reports every mailbox as off when it has no row', () => {
    const settings = store.get('email_gmail');
    expect(settings.enabled).toBe(false);
    expect(settings.mode).toBe('important');
    expect(settings.lastUid).toBe(0);
    expect(settings.uidValidity).toBeNull();
    expect(settings.alwaysImportant).toEqual([]);
  });

  it('never hands the watcher a mailbox that is not explicitly enabled', () => {
    const accounts = [account('a', 'a@example.com'), account('b', 'b@example.com')];
    expect(store.enabledAccounts(accounts)).toEqual([]);

    store.save('a', { enabled: true }, 'key_test');
    expect(store.enabledAccounts(accounts).map((entry) => entry.accountId)).toEqual(['a']);
  });

  it('leaves a disabled account out even when triage is on', () => {
    const accounts = [account('a', 'a@example.com', false)];
    store.save('a', { enabled: true }, 'key_test');
    expect(store.enabledAccounts(accounts)).toEqual([]);
  });

  it('changes only the fields it is given', () => {
    store.save('a', { enabled: true, mode: 'full', alwaysImportant: ['Mum <Mum@Example.com>'] }, 'key_test');
    store.save('a', { pollSeconds: 900 }, 'key_test');
    const settings = store.get('a');
    expect(settings.enabled).toBe(true);
    expect(settings.mode).toBe('full');
    expect(settings.pollSeconds).toBe(900);
    // A display-name form is normalised to the bare address so the watcher can compare it.
    expect(settings.alwaysImportant).toEqual(['mum@example.com']);
  });

  it('clamps the poll interval to something a mailbox can take', () => {
    expect(store.save('a', { pollSeconds: 1 }, null).pollSeconds).toBe(60);
    expect(store.save('a', { pollSeconds: 999_999 }, null).pollSeconds).toBe(86_400);
  });

  it('drops duplicate allowlist entries and keeps domains', () => {
    const settings = store.save('a', { neverJunk: ['@gov.uk', '@gov.uk', 'a@b.example'] }, null);
    expect(settings.neverJunk).toEqual(['@gov.uk', 'a@b.example']);
  });

  it('rejects a malformed allowlist rather than storing half of it', () => {
    expect(() => store.save('a', { alwaysImportant: ['ok@example.com', 42] as never }, null)).toThrow(/strings/u);
    expect(store.get('a').alwaysImportant).toEqual([]);
  });

  it('moves the cursor without touching the switches', () => {
    store.save('a', { enabled: true }, 'key_test');
    store.setCursor('a', '12345', 87, '2026-11-12T10:00:00.000Z');
    const settings = store.get('a');
    expect(settings.lastUid).toBe(87);
    expect(settings.uidValidity).toBe('12345');
    expect(settings.lastRunAt).toBe('2026-11-12T10:00:00.000Z');
    expect(settings.enabled).toBe(true);
  });

  it('forgets a deleted mailbox so a future account id cannot inherit it', () => {
    store.save('a', { enabled: true }, 'key_test');
    store.remove('a');
    expect(store.get('a').enabled).toBe(false);
  });

  it('round-trips a full setting through the database', () => {
    store.save(
      'a',
      {
        enabled: true,
        mode: 'full',
        pollSeconds: 300,
        junkFolder: 'Junk',
        alwaysImportant: ['mum@example.com'],
        neverJunk: ['@gov.uk'],
      },
      'key_actor',
    );
    const again = new EmailTriageStore(db).get('a');
    expect(again).toMatchObject({
      enabled: true,
      mode: 'full',
      junkFolder: 'Junk',
      alwaysImportant: ['mum@example.com'],
      neverJunk: ['@gov.uk'],
      updatedBy: 'key_actor',
    });
  });
});
