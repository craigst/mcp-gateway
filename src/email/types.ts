/**
 * Email accounts and message shapes for the Gateway email client.
 *
 * The email subsystem is deliberately account-first: one MCP server exposes
 * every mailbox, and callers pick an account by id/name/address. Credentials
 * stay in the gateway database and are never returned to the browser.
 */

export type EmailAccountKind = 'imap' | 'proton' | 'gmail';

export interface EmailAccount {
  id: string;
  name: string;
  email: string;
  displayName: string;
  kind: EmailAccountKind;
  enabled: boolean;
  isDefault: boolean;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapStartTls: boolean;
  imapUser: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  fromAddress: string;
  createdAt: string;
  updatedAt: string;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastError: string | null;
}

export interface EmailAccountInput {
  name: string;
  email?: string;
  displayName?: string;
  kind?: EmailAccountKind;
  enabled?: boolean;
  isDefault?: boolean;
  imapHost: string;
  imapPort?: number;
  imapSecure?: boolean;
  imapStartTls?: boolean;
  imapUser?: string;
  imapPassword?: string;
  smtpHost: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPassword?: string;
  fromAddress?: string;
}

export interface EmailFolder {
  path: string;
  name: string;
  specialUse: string | null;
  delimiter: string | null;
  subscribed: boolean;
}

export interface EmailMessageSummary {
  uid: number;
  seq: number;
  subject: string;
  from: string;
  to: string;
  date: string;
  flags: string[];
  unread: boolean;
  flagged: boolean;
  size: number;
  preview: string;
  messageId: string | null;
}

export interface EmailAttachment {
  filename: string | null;
  contentType: string;
  size: number;
  contentId: string | null;
  part: string;
}

export interface EmailMessage extends EmailMessageSummary {
  cc: string;
  bcc: string;
  replyTo: string;
  text: string;
  html: string;
  attachments: EmailAttachment[];
  inReplyTo: string | null;
  references: string[];
}

export interface SendEmailInput {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string | null;
  references?: string[];
}

export interface EmailConnectionStatus {
  accountId: string;
  ok: boolean;
  folders: number;
  latencyMs: number;
  checkedAt: string;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Access control (who can use the shared email MCP server and which mailbox)
// ---------------------------------------------------------------------------

/** One mailbox as shown in the access view. */
export interface EmailAccessAccount {
  id: string;
  name: string;
  email: string;
  isDefault: boolean;
  enabled: boolean;
}

/**
 * A caller that may (or may not) use the email server.
 *
 * `kind` is `bot` for an OpenMausBot agent resolved through the `omb` MCP
 * server, or `key` for a plain gateway API key. A bot is bound to the gateway
 * key it uses (`omb-<slug>`); `keyId === null` means the bot has no gateway
 * key and therefore cannot reach email at all.
 */
export interface EmailAccessSubject {
  /** Stable row id: `bot:<omb id>` or `key:<key id>`. */
  id: string;
  kind: 'bot' | 'key';
  /** Bot name, or API key name. */
  name: string;
  /** Bot job title; null for plain keys. */
  title: string | null;
  /** Bot slug, e.g. `cleo`; null for plain keys. */
  slug: string | null;
  /** OpenMausBot bot id; null for plain keys. */
  botId: string | null;
  keyId: string | null;
  keyName: string | null;
  keyType: string | null;
  keyPrefix: string | null;
  /** A server grant for the email server exists (it may be paused). */
  emailGranted: boolean;
  /** The whole email grant is paused. */
  emailPaused: boolean;
  /** Effective access: granted, not paused and the key is not revoked. */
  emailEnabled: boolean;
  /** Email tools granted by the whitelist (all tools when null). */
  grantedToolCount: number;
  /** Tools advertised by the email server. */
  totalToolCount: number;
  lastUsedAt: string | null;
  revoked: boolean;
  /** Master keys always have access and cannot be toggled. */
  locked: boolean;
  /** accountId -> allowed. An absent account inherits the default (allowed). */
  accounts: Record<string, boolean>;
}

export interface EmailAccessServer {
  id: string;
  name: string;
  status: string;
  toolCount: number;
  highPrivilegeTools: string[];
}

export interface EmailAccessOverview {
  server: EmailAccessServer | null;
  accounts: EmailAccessAccount[];
  bots: EmailAccessSubject[];
  keys: EmailAccessSubject[];
  generatedAt: string;
}

export interface EmailAccessUpdateInput {
  /** Master switch for the whole email server grant (pause/unpause/add/remove). */
  enabled?: boolean;
  /** Explicit per-account decisions. `false` removes that mailbox from the key. */
  accounts?: Record<string, boolean>;
}

export interface EmailAccessUpdateResult {
  key: {
    id: string;
    name: string;
    emailGranted: boolean;
    emailPaused: boolean;
    emailEnabled: boolean;
    accounts: Record<string, boolean>;
  };
}

// ---------------------------------------------------------------------------
// Triage (which mailboxes are watched, and how far they may act)
// ---------------------------------------------------------------------------

/**
 * `important` shows a card and drafts; `full` may also file no-action mail
 * into a folder. Nothing in triage may send, and nothing may delete.
 */
export type EmailTriageMode = 'important' | 'full';

/** Per-account triage state. A mailbox with `enabled: false` is never read. */
export interface EmailTriageSettings {
  accountId: string;
  enabled: boolean;
  mode: EmailTriageMode;
  /** How often the watcher looks at this mailbox. */
  pollSeconds: number;
  /** Where no-action mail is filed under `full`; null uses the provider's Junk. */
  junkFolder: string | null;
  /** Senders that are always important; never filed, never skipped by a rule. */
  alwaysImportant: string[];
  /** Senders that are never filed, whatever the verdict. */
  neverJunk: string[];
  /** Highest INBOX uid already handed to the watcher. */
  lastUid: number;
  /** The mailbox's UIDVALIDITY when `lastUid` was recorded; a change resets the cursor. */
  uidValidity: string | null;
  lastRunAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface EmailTriageInput {
  enabled?: boolean;
  mode?: EmailTriageMode;
  pollSeconds?: number;
  junkFolder?: string | null;
  alwaysImportant?: string[];
  neverJunk?: string[];
}

export interface EmailTriageAccount extends EmailTriageSettings {
  name: string;
  email: string;
  isDefault: boolean;
  /** The account row's own enabled flag, separate from triage. */
  accountEnabled: boolean;
}

export interface EmailTriageOverview {
  accounts: EmailTriageAccount[];
  generatedAt: string;
}

/**
 * One new message as the watcher sees it: headers plus a short preview, never
 * the whole body. `id` is stable across polls and is the dedupe key.
 */
export interface EmailNewMessage {
  id: string;
  accountId: string;
  accountEmail: string;
  uid: number;
  from: string;
  subject: string;
  preview: string;
  date: string;
  unread: boolean;
  /** The sender offers a list unsubscribe header: a strong newsletter signal. */
  listUnsubscribe: boolean;
  /** Auto-Submitted / Precedence: bulk / no-reply sender: a bulk signal. */
  automated: boolean;
}

export interface EmailNewMessages {
  accountId: string;
  accountEmail: string;
  uidValidity: string;
  uidNext: number;
  messages: EmailNewMessage[];
}
