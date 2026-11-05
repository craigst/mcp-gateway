import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser, type ParsedMail } from 'mailparser';
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../core/ids.js';
import { EmailStore, type EmailAccountWithSecrets } from './store.js';
import type {
  EmailAccount,
  EmailAccountInput,
  EmailAttachment,
  EmailConnectionStatus,
  EmailFolder,
  EmailMessage,
  EmailMessageSummary,
  SendEmailInput,
} from './types.js';

export interface EmailServiceDeps {
  db: DatabaseSync;
  /** Defaults to the gateway DB. */
  store?: EmailStore;
}

interface ImapFetchMessage {
  uid: number;
  seq: number;
  envelope?: {
    subject?: string;
    date?: Date;
    messageId?: string;
    from?: Array<{ name?: string; address?: string }>;
    to?: Array<{ name?: string; address?: string }>;
    cc?: Array<{ name?: string; address?: string }>;
  };
  flags?: Set<string>;
  internalDate?: Date;
  size?: number;
}

function addressList(list: Array<{ name?: string; address?: string }> | undefined): string {
  if (list === undefined) return '';
  return list.map((entry) => (entry.name ? `${entry.name} <${entry.address ?? ''}>` : entry.address ?? '')).filter(Boolean).join(', ');
}

function addressValue(
  value:
    | { value: Array<{ name?: string; address?: string }> }
    | Array<{ value: Array<{ name?: string; address?: string }> }>
    | undefined,
): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) return value.map((entry) => addressList(entry.value)).filter(Boolean).join(', ');
  return addressList(value.value);
}

function emptyPreview(subject: string): string {
  return subject.trim();
}

function mapSummary(message: ImapFetchMessage): EmailMessageSummary {
  const flags = message.flags === undefined ? [] : [...message.flags];
  const subject = message.envelope?.subject ?? '(no subject)';
  return {
    uid: message.uid,
    seq: message.seq,
    subject,
    from: addressList(message.envelope?.from),
    to: addressList(message.envelope?.to),
    date: (message.internalDate ?? message.envelope?.date ?? new Date()).toISOString(),
    flags,
    unread: !flags.includes('\\Seen'),
    flagged: flags.includes('\\Flagged'),
    size: message.size ?? 0,
    preview: emptyPreview(subject),
    messageId: message.envelope?.messageId ?? null,
  };
}

function attachmentList(parsed: ParsedMail): EmailAttachment[] {
  const result: EmailAttachment[] = [];
  const parts = parsed.attachments ?? [];
  parts.forEach((attachment, index) => {
    result.push({
      filename: attachment.filename ?? null,
      contentType: attachment.contentType ?? 'application/octet-stream',
      size: attachment.size ?? 0,
      contentId: attachment.contentId ?? null,
      part: String(index + 1),
    });
  });
  return result;
}

/**
 * Account-aware IMAP/SMTP service.
 *
 * Every operation takes an account id, name or email address. One service (and
 * one MCP server) therefore serves every mailbox; credentials never leave the
 * gateway database.
 */
export class EmailService {
  readonly store: EmailStore;

  constructor(private readonly deps: EmailServiceDeps) {
    this.store = deps.store ?? new EmailStore(deps.db);
  }

  listAccounts(): EmailAccount[] {
    return this.store.list();
  }

  getAccount(selector: string): EmailAccountWithSecrets | null {
    return this.store.findBySelector(selector);
  }

  private requireAccount(selector: string): EmailAccountWithSecrets {
    const account = this.store.findBySelector(selector) ?? this.store.defaultAccount();
    if (account === null) throw new Error('no email account is configured');
    if (!account.enabled) throw new Error(`email account "${account.name}" is disabled`);
    return account;
  }

  createAccount(input: EmailAccountInput): EmailAccount {
    return this.store.create(input);
  }

  updateAccount(id: string, input: Partial<EmailAccountInput>): EmailAccount {
    return this.store.update(id, input);
  }

  deleteAccount(id: string): boolean {
    return this.store.delete(id);
  }

  private client(account: EmailAccountWithSecrets): ImapFlow {
    return new ImapFlow({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapSecure,
      auth: { user: account.imapUser, pass: account.imapPassword },
      ...(account.imapSecure ? {} : { doSTARTTLS: account.imapStartTls }),
      tls: { rejectUnauthorized: false },
      logger: false,
      emitLogs: false,
    });
  }

  private async withClient<T>(account: EmailAccountWithSecrets, operation: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = this.client(account);
    try {
      await client.connect();
      return await operation(client);
    } finally {
      try {
        await client.logout();
      } catch {
        // A broken connection must not hide the real operation error.
      }
    }
  }

  async testAccount(selector: string): Promise<EmailConnectionStatus> {
    const account = this.requireAccount(selector);
    const started = Date.now();
    try {
      const folders = await this.withClient(account, async (client) => {
        const list = await client.list();
        return list.length;
      });
      this.store.markTest(account.id, true, null);
      const checkedAt = nowIso();
      return { accountId: account.id, ok: true, folders, latencyMs: Date.now() - started, checkedAt, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.markTest(account.id, false, message);
      return { accountId: account.id, ok: false, folders: 0, latencyMs: Date.now() - started, checkedAt: nowIso(), error: message };
    }
  }

  async listFolders(selector: string): Promise<EmailFolder[]> {
    const account = this.requireAccount(selector);
    return this.withClient(account, async (client) => {
      const list = await client.list();
      return list.map((folder) => ({
        path: folder.path,
        name: folder.name,
        specialUse: folder.specialUse ?? null,
        delimiter: folder.delimiter ?? null,
        subscribed: folder.subscribed === true,
      }));
    });
  }

  async listMessages(
    selector: string,
    options: { folder?: string; limit?: number; unreadOnly?: boolean; search?: string } = {},
  ): Promise<EmailMessageSummary[]> {
    const account = this.requireAccount(selector);
    const folder = options.folder?.trim() || 'INBOX';
    const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
    return this.withClient(account, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const exists = typeof client.mailbox === 'object' && client.mailbox !== null ? Number(client.mailbox.exists) : 0;
        if (exists === 0) return [];
        const start = Math.max(1, exists - limit + 1);
        const rows: EmailMessageSummary[] = [];
        for await (const raw of client.fetch(`${start}:*`, {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          size: true,
        })) {
          const message = raw as unknown as ImapFetchMessage;
          rows.push(mapSummary(message));
        }
        let filtered = options.unreadOnly === true ? rows.filter((message) => message.unread) : rows;
        const needle = options.search?.trim().toLowerCase();
        if (needle) {
          filtered = filtered.filter(
            (message) =>
              message.subject.toLowerCase().includes(needle) ||
              message.from.toLowerCase().includes(needle) ||
              message.to.toLowerCase().includes(needle),
          );
        }
        return filtered.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, limit);
      } finally {
        lock.release();
      }
    });
  }

  async readMessage(selector: string, uid: number, folder = 'INBOX'): Promise<EmailMessage> {
    const account = this.requireAccount(selector);
    return this.withClient(account, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const raw = await client.fetchOne(uid, {
          uid: true,
          source: true,
          envelope: true,
          flags: true,
          internalDate: true,
          size: true,
        }, { uid: true });
        if (raw === false) throw new Error(`message ${uid} was not found in ${folder}`);
        const message = raw as unknown as ImapFetchMessage & { source?: Buffer };
        const parsed = message.source === undefined ? null : await simpleParser(message.source);
        const summary = mapSummary(message);
        return {
          ...summary,
          cc: addressValue(parsed?.cc),
          bcc: addressValue(parsed?.bcc),
          replyTo: addressValue(parsed?.replyTo),
          text: parsed?.text ?? '',
          html: typeof parsed?.html === 'string' ? parsed.html : '',
          attachments: parsed === null ? [] : attachmentList(parsed),
          inReplyTo: parsed?.inReplyTo ?? null,
          references: parsed?.references === undefined ? [] : Array.isArray(parsed.references) ? parsed.references : [parsed.references],
        };
      } finally {
        lock.release();
      }
    });
  }

  async markRead(selector: string, uid: number, read: boolean, folder = 'INBOX'): Promise<void> {
    const account = this.requireAccount(selector);
    await this.withClient(account, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        if (read) await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        else await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
      } finally {
        lock.release();
      }
    });
  }

  async moveMessage(selector: string, uid: number, folder: string, target: string): Promise<void> {
    const account = this.requireAccount(selector);
    await this.withClient(account, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        await client.messageMove(uid, target, { uid: true });
      } finally {
        lock.release();
      }
    });
  }

  async deleteMessage(selector: string, uid: number, folder = 'INBOX'): Promise<void> {
    const account = this.requireAccount(selector);
    await this.withClient(account, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        await client.messageDelete(uid, { uid: true });
      } finally {
        lock.release();
      }
    });
  }

  async send(selector: string, input: SendEmailInput): Promise<{ messageId: string; accepted: string[]; rejected: string[] }> {
    const account = this.requireAccount(selector);
    const transport = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort,
      secure: account.smtpSecure,
      auth: { user: account.smtpUser, pass: account.smtpPassword },
      tls: { rejectUnauthorized: false },
    });
    const info = await transport.sendMail({
      from: account.displayName ? `${account.displayName} <${account.fromAddress}>` : account.fromAddress,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: input.html,
      inReplyTo: input.inReplyTo ?? undefined,
      references: input.references,
    });
    return {
      messageId: String(info.messageId ?? ''),
      accepted: Array.isArray(info.accepted) ? info.accepted.map(String) : [],
      rejected: Array.isArray(info.rejected) ? info.rejected.map(String) : [],
    };
  }
}
