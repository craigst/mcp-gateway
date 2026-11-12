/**
 * Per-account email triage settings and poll cursors.
 *
 * A mailbox is read by a watcher only when its row here says `enabled = 1`.
 * Absence of a row is therefore "off", which is what makes triage safe by
 * default: installing this table reads nobody's mail.
 *
 * The cursor (`last_uid` + `uid_validity`) lives here rather than in the
 * watcher so that a watcher restart, a redeploy or a second watcher process
 * cannot make the same message be judged twice. UIDVALIDITY is recorded with
 * the cursor because a mailbox that renumbers its UIDs must be re-read from
 * the start rather than silently skipped.
 */
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../core/ids.js';
import type {
  EmailAccount,
  EmailTriageAccount,
  EmailTriageInput,
  EmailTriageMode,
  EmailTriageSettings,
} from './types.js';

const MIN_POLL_SECONDS = 60;
const MAX_POLL_SECONDS = 86_400;
const MAX_FOLDER = 200;
const MAX_SENDERS = 200;
/** An allowlist entry is an address or a whole domain, e.g. `@gov.uk`. */
const MAX_SENDER_LENGTH = 320;

interface TriageRow {
  account_id: string;
  enabled: number;
  mode: string;
  poll_seconds: number;
  junk_folder: string | null;
  sorted_folder: string | null;
  always_important: string | null;
  never_junk: string | null;
  last_uid: number;
  uid_validity: string | null;
  last_run_at: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

export const DEFAULT_TRIAGE_MODE: EmailTriageMode = 'important';
export const DEFAULT_POLL_SECONDS = 300;

function defaults(accountId: string): EmailTriageSettings {
  return {
    accountId,
    enabled: false,
    mode: DEFAULT_TRIAGE_MODE,
    pollSeconds: DEFAULT_POLL_SECONDS,
    junkFolder: null,
    sortedFolder: null,
    alwaysImportant: [],
    neverJunk: [],
    lastUid: 0,
    uidValidity: null,
    lastRunAt: null,
    updatedAt: null,
    updatedBy: null,
  };
}

function parseList(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

function rowToSettings(row: TriageRow): EmailTriageSettings {
  const mode: EmailTriageMode = row.mode === 'full' ? 'full' : 'important';
  return {
    accountId: row.account_id,
    enabled: row.enabled === 1,
    mode,
    pollSeconds: row.poll_seconds,
    junkFolder: row.junk_folder,
    sortedFolder: row.sorted_folder ?? null,
    alwaysImportant: parseList(row.always_important),
    neverJunk: parseList(row.never_junk),
    lastUid: row.last_uid,
    uidValidity: row.uid_validity,
    lastRunAt: row.last_run_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/** A sender entry: a bare address, `@domain`, or `display <addr>`; lower-cased. */
export function normalizeSender(raw: string): string {
  const value = raw.trim().toLowerCase();
  const angled = /<([^>]+)>/u.exec(value);
  return (angled?.[1] ?? value).trim();
}

function cleanSenders(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of addresses`);
  if (value.length > MAX_SENDERS) throw new Error(`${field} holds at most ${MAX_SENDERS} addresses`);
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error(`${field} must hold strings`);
    const sender = normalizeSender(entry);
    if (sender === '' || sender.length > MAX_SENDER_LENGTH) {
      throw new Error(`${field} holds an empty or over-long address`);
    }
    seen.add(sender);
  }
  return [...seen];
}

/**
 * An allowlist entry is an address or `@domain`; the sender is compared on its
 * bare address so `Mum <mum@example.com>` matches `mum@example.com`.
 */
export function senderMatches(sender: string, entries: readonly string[]): boolean {
  const bare = normalizeSender(sender);
  for (const entry of entries) {
    const cleanEntry = entry.trim().toLowerCase();
    if (cleanEntry === '') continue;
    if (cleanEntry.startsWith('@')) {
      if (bare.endsWith(cleanEntry)) return true;
    } else if (bare === normalizeSender(cleanEntry)) {
      return true;
    }
  }
  return false;
}

export class EmailTriageStore {
  constructor(private readonly db: DatabaseSync) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS email_triage (
        account_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        mode TEXT NOT NULL DEFAULT 'important',
        poll_seconds INTEGER NOT NULL DEFAULT 300,
        junk_folder TEXT,
        sorted_folder TEXT,
        always_important TEXT,
        never_junk TEXT,
        last_uid INTEGER NOT NULL DEFAULT 0,
        uid_validity TEXT,
        last_run_at TEXT,
        updated_at TEXT,
        updated_by TEXT
      );
    `);
    // A database created before 0.15.4 has no sorted_folder: add it rather than
    // requiring a rebuild, which would drop the operator's switches.
    const columns = this.db.prepare('PRAGMA table_info(email_triage)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === 'sorted_folder')) {
      this.db.exec('ALTER TABLE email_triage ADD COLUMN sorted_folder TEXT');
    }
  }

  /** The stored settings, or the all-off defaults when the mailbox has no row. */
  get(accountId: string): EmailTriageSettings {
    const row = this.db.prepare('SELECT * FROM email_triage WHERE account_id = ?').get(accountId) as
      | TriageRow
      | undefined;
    return row === undefined ? defaults(accountId) : rowToSettings(row);
  }

  list(): Map<string, EmailTriageSettings> {
    const rows = this.db.prepare('SELECT * FROM email_triage').all() as unknown as TriageRow[];
    return new Map(rows.map((row) => [row.account_id, rowToSettings(row)]));
  }

  /** Every mailbox the watcher may read: row present, enabled, and the account itself enabled. */
  enabledAccounts(accounts: readonly EmailAccount[]): EmailTriageAccount[] {
    const stored = this.list();
    return accounts
      .map((account) => {
        const triage = stored.get(account.id) ?? defaults(account.id);
        return { ...triage, name: account.name, email: account.email, isDefault: account.isDefault, accountEnabled: account.enabled };
      })
      .filter((account) => account.enabled && account.accountEnabled);
  }

  /** Create or update one mailbox's settings; only supplied fields change. */
  save(accountId: string, input: EmailTriageInput, actor: string | null): EmailTriageSettings {
    const current = this.get(accountId);
    const next: EmailTriageSettings = { ...current };

    if (input.enabled !== undefined) next.enabled = input.enabled;
    if (input.mode !== undefined) {
      if (input.mode !== 'important' && input.mode !== 'full') throw new Error('mode must be important or full');
      next.mode = input.mode;
    }
    if (input.pollSeconds !== undefined) {
      if (!Number.isFinite(input.pollSeconds)) throw new Error('pollSeconds must be a number');
      next.pollSeconds = Math.round(Math.min(Math.max(input.pollSeconds, MIN_POLL_SECONDS), MAX_POLL_SECONDS));
    }
    for (const field of ['junkFolder', 'sortedFolder'] as const) {
      const value = input[field];
      if (value === undefined) continue;
      if (value === null) {
        next[field] = null;
        continue;
      }
      const folder = value.trim();
      if (folder.length > MAX_FOLDER) throw new Error(`${field} holds at most ${MAX_FOLDER} characters`);
      next[field] = folder === '' ? null : folder;
    }
    if (input.alwaysImportant !== undefined) next.alwaysImportant = cleanSenders(input.alwaysImportant, 'alwaysImportant');
    if (input.neverJunk !== undefined) next.neverJunk = cleanSenders(input.neverJunk, 'neverJunk');

    const updatedAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO email_triage
           (account_id, enabled, mode, poll_seconds, junk_folder, sorted_folder, always_important,
            never_junk, last_uid, uid_validity, last_run_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           enabled = excluded.enabled,
           mode = excluded.mode,
           poll_seconds = excluded.poll_seconds,
           junk_folder = excluded.junk_folder,
           sorted_folder = excluded.sorted_folder,
           always_important = excluded.always_important,
           never_junk = excluded.never_junk,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(
        accountId,
        next.enabled ? 1 : 0,
        next.mode,
        next.pollSeconds,
        next.junkFolder,
        next.sortedFolder,
        JSON.stringify(next.alwaysImportant),
        JSON.stringify(next.neverJunk),
        current.lastUid,
        current.uidValidity,
        current.lastRunAt,
        updatedAt,
        actor,
      );
    return this.get(accountId);
  }

  /**
   * Record how far the watcher has read. A different UIDVALIDITY means the
   * mailbox was renumbered, so the cursor restarts at `lastUid` as given.
   */
  setCursor(accountId: string, uidValidity: string, lastUid: number, runAt: string): void {
    this.db
      .prepare(
        `UPDATE email_triage SET last_uid = ?, uid_validity = ?, last_run_at = ? WHERE account_id = ?`,
      )
      .run(Math.max(0, Math.trunc(lastUid)), uidValidity, runAt, accountId);
  }

  remove(accountId: string): void {
    this.db.prepare('DELETE FROM email_triage WHERE account_id = ?').run(accountId);
  }
}
