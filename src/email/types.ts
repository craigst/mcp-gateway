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
