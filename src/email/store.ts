import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../core/ids.js';
import type { EmailAccount, EmailAccountInput } from './types.js';

interface AccountRow {
  id: string;
  name: string;
  email: string;
  display_name: string;
  kind: string;
  enabled: number;
  is_default: number;
  imap_host: string;
  imap_port: number;
  imap_secure: number;
  imap_starttls: number;
  imap_user: string;
  imap_password: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  smtp_user: string;
  smtp_password: string;
  from_address: string;
  created_at: string;
  updated_at: string;
  last_test_at: string | null;
  last_test_ok: number | null;
  last_error: string | null;
}

function bool(value: number | null): boolean | null {
  return value === null ? null : value === 1;
}

function rowToAccount(row: AccountRow): EmailAccount {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    displayName: row.display_name,
    kind: row.kind as EmailAccount['kind'],
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    imapSecure: row.imap_secure === 1,
    imapStartTls: row.imap_starttls === 1,
    imapUser: row.imap_user,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpSecure: row.smtp_secure === 1,
    smtpUser: row.smtp_user,
    fromAddress: row.from_address,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTestAt: row.last_test_at,
    lastTestOk: bool(row.last_test_ok),
    lastError: row.last_error,
  };
}

export interface EmailAccountWithSecrets extends EmailAccount {
  imapPassword: string;
  smtpPassword: string;
}

function rowToAccountWithSecrets(row: AccountRow): EmailAccountWithSecrets {
  return {
    ...rowToAccount(row),
    imapPassword: row.imap_password,
    smtpPassword: row.smtp_password,
  };
}

/**
 * Account store. The gateway DB is shared with the standalone email MCP
 * server; the schema is created idempotently by whichever process starts first.
 */
export class EmailStore {
  constructor(private readonly db: DatabaseSync) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS email_accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'imap',
        enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        imap_host TEXT NOT NULL,
        imap_port INTEGER NOT NULL DEFAULT 143,
        imap_secure INTEGER NOT NULL DEFAULT 0,
        imap_starttls INTEGER NOT NULL DEFAULT 1,
        imap_user TEXT NOT NULL,
        imap_password TEXT NOT NULL DEFAULT '',
        smtp_host TEXT NOT NULL,
        smtp_port INTEGER NOT NULL DEFAULT 25,
        smtp_secure INTEGER NOT NULL DEFAULT 0,
        smtp_user TEXT NOT NULL,
        smtp_password TEXT NOT NULL DEFAULT '',
        from_address TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_test_at TEXT,
        last_test_ok INTEGER,
        last_error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS email_accounts_email_idx ON email_accounts(email);
    `);
  }

  list(): EmailAccount[] {
    const rows = this.db.prepare('SELECT * FROM email_accounts ORDER BY is_default DESC, created_at ASC').all() as unknown as AccountRow[];
    return rows.map(rowToAccount);
  }

  get(id: string): EmailAccount | null {
    const row = this.db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(id) as AccountRow | undefined;
    return row === undefined ? null : rowToAccount(row);
  }

  getWithSecrets(id: string): EmailAccountWithSecrets | null {
    const row = this.db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(id) as AccountRow | undefined;
    return row === undefined ? null : rowToAccountWithSecrets(row);
  }

  findBySelector(selector: string): EmailAccountWithSecrets | null {
    const row = this.db.prepare(
      `SELECT * FROM email_accounts
        WHERE id = ? OR name = ? COLLATE NOCASE OR email = ? COLLATE NOCASE OR from_address = ? COLLATE NOCASE
        ORDER BY is_default DESC LIMIT 1`,
    ).get(selector, selector, selector, selector) as AccountRow | undefined;
    return row === undefined ? null : rowToAccountWithSecrets(row);
  }

  defaultAccount(): EmailAccountWithSecrets | null {
    const row = this.db.prepare(
      'SELECT * FROM email_accounts WHERE is_default = 1 AND enabled = 1 ORDER BY created_at LIMIT 1',
    ).get() as AccountRow | undefined;
    if (row !== undefined) return rowToAccountWithSecrets(row);
    const first = this.db.prepare('SELECT * FROM email_accounts WHERE enabled = 1 ORDER BY created_at LIMIT 1').get() as AccountRow | undefined;
    return first === undefined ? null : rowToAccountWithSecrets(first);
  }

  create(input: EmailAccountInput): EmailAccount {
    const now = nowIso();
    const id = newId('email');
    const email = (input.email ?? input.fromAddress ?? input.imapUser ?? '').trim();
    if (!email) throw new Error('email is required');
    const fromAddress = (input.fromAddress ?? email).trim();
    const imapPort = input.imapPort ?? (input.imapSecure ? 993 : 143);
    const smtpPort = input.smtpPort ?? (input.smtpSecure ? 465 : 25);
    const isDefault = input.isDefault === true ? 1 : 0;
    if (isDefault === 1) this.db.prepare('UPDATE email_accounts SET is_default = 0').run();
    this.db.prepare(
      `INSERT INTO email_accounts
        (id, name, email, display_name, kind, enabled, is_default,
         imap_host, imap_port, imap_secure, imap_starttls, imap_user, imap_password,
         smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password, from_address,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name.trim(),
      email,
      input.displayName ?? input.name,
      input.kind ?? 'imap',
      input.enabled === false ? 0 : 1,
      isDefault,
      input.imapHost.trim(),
      imapPort,
      input.imapSecure === true ? 1 : 0,
      input.imapStartTls === false ? 0 : 1,
      (input.imapUser ?? email).trim(),
      input.imapPassword ?? '',
      input.smtpHost.trim(),
      smtpPort,
      input.smtpSecure === true ? 1 : 0,
      (input.smtpUser ?? input.imapUser ?? email).trim(),
      input.smtpPassword ?? input.imapPassword ?? '',
      fromAddress,
      now,
      now,
    );
    return this.get(id) as EmailAccount;
  }

  update(id: string, input: Partial<EmailAccountInput>): EmailAccount {
    const current = this.getWithSecrets(id);
    if (current === null) throw new Error('email account not found');
    const now = nowIso();
    const email = (input.email ?? current.email).trim();
    const imapPassword = input.imapPassword === undefined ? current.imapPassword : input.imapPassword;
    const smtpPassword = input.smtpPassword === undefined ? current.smtpPassword : input.smtpPassword;
    if (input.isDefault === true) this.db.prepare('UPDATE email_accounts SET is_default = 0').run();
    this.db.prepare(
      `UPDATE email_accounts SET
        name = ?, email = ?, display_name = ?, kind = ?, enabled = ?, is_default = ?,
        imap_host = ?, imap_port = ?, imap_secure = ?, imap_starttls = ?, imap_user = ?, imap_password = ?,
        smtp_host = ?, smtp_port = ?, smtp_secure = ?, smtp_user = ?, smtp_password = ?, from_address = ?,
        updated_at = ?, last_error = NULL
       WHERE id = ?`,
    ).run(
      (input.name ?? current.name).trim(),
      email,
      input.displayName ?? current.displayName,
      input.kind ?? current.kind,
      input.enabled === undefined ? (current.enabled ? 1 : 0) : input.enabled ? 1 : 0,
      input.isDefault === undefined ? (current.isDefault ? 1 : 0) : input.isDefault ? 1 : 0,
      input.imapHost ?? current.imapHost,
      input.imapPort ?? current.imapPort,
      input.imapSecure === undefined ? (current.imapSecure ? 1 : 0) : input.imapSecure ? 1 : 0,
      input.imapStartTls === undefined ? (current.imapStartTls ? 1 : 0) : input.imapStartTls ? 1 : 0,
      input.imapUser ?? current.imapUser,
      imapPassword,
      input.smtpHost ?? current.smtpHost,
      input.smtpPort ?? current.smtpPort,
      input.smtpSecure === undefined ? (current.smtpSecure ? 1 : 0) : input.smtpSecure ? 1 : 0,
      input.smtpUser ?? current.smtpUser,
      smtpPassword,
      input.fromAddress ?? current.fromAddress,
      now,
      id,
    );
    return this.get(id) as EmailAccount;
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM email_accounts WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  markTest(id: string, ok: boolean, error: string | null): void {
    this.db.prepare('UPDATE email_accounts SET last_test_at = ?, last_test_ok = ?, last_error = ? WHERE id = ?').run(
      nowIso(),
      ok ? 1 : 0,
      error,
      id,
    );
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM email_accounts').get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }
}
