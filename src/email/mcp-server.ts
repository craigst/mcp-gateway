#!/usr/bin/env node
/**
 * Single account-aware email MCP server.
 *
 * One process serves every mailbox. Callers choose an account by id, name or
 * email address; omitting it uses the default account. The gateway key controls
 * whether this server is reachable at all, so accounts are shared by API keys
 * rather than by running one server per mailbox.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio (the gateway's native
 * stdio transport). The database is the gateway DB, shared with the Email tab.
 */
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { EmailService } from './service.js';
import type { EmailMessage, EmailMessageSummary } from './types.js';

const DB_PATH = process.env.EMAIL_DB_PATH ?? '/data/gateway.db';
const db = new DatabaseSync(DB_PATH);
const service = new EmailService({ db });

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function accountProperty(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

function toolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'email_list_accounts',
      description: 'List every configured email account with its connection status. Passwords are never returned.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'email_test_account',
      description: 'Connect to an account over IMAP and report whether it is reachable.',
      inputSchema: { type: 'object', properties: { account: accountProperty('Account id, name or email. Omit for the default account.') } },
    },
    {
      name: 'email_list_folders',
      description: 'List the folders/mailboxes of an account.',
      inputSchema: { type: 'object', properties: { account: accountProperty('Account id, name or email.') } },
    },
    {
      name: 'email_list_messages',
      description: 'List recent messages in a folder, newest first. Use unread_only and search for common phone-mail filters.',
      inputSchema: {
        type: 'object',
        properties: {
          account: accountProperty('Account id, name or email.'),
          folder: { type: 'string', description: 'Mailbox path, default INBOX.' },
          limit: { type: 'number', description: 'Maximum messages, default 30, max 100.' },
          unread_only: { type: 'boolean', description: 'Only unread messages.' },
          search: { type: 'string', description: 'Filter by subject/from/to.' },
        },
      },
    },
    {
      name: 'email_search',
      description: 'Search recent messages by subject, sender or recipient.',
      inputSchema: {
        type: 'object',
        properties: {
          account: accountProperty('Account id, name or email.'),
          query: { type: 'string', description: 'Text to find.' },
          folder: { type: 'string', description: 'Mailbox path, default INBOX.' },
          limit: { type: 'number', description: 'Maximum messages, default 30.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'email_read_message',
      description: 'Read one message, including text, HTML and attachment metadata. Does not mark it read.',
      inputSchema: {
        type: 'object',
        properties: {
          account: accountProperty('Account id, name or email.'),
          uid: { type: 'number', description: 'IMAP UID from email_list_messages.' },
          folder: { type: 'string', description: 'Mailbox path, default INBOX.' },
        },
        required: ['uid'],
      },
    },
    {
      name: 'email_mark_read',
      description: 'Set or clear the read flag on one message.',
      inputSchema: {
        type: 'object',
        properties: {
          account: accountProperty('Account id, name or email.'),
          uid: { type: 'number' },
          folder: { type: 'string' },
          read: { type: 'boolean', description: 'Default true.' },
        },
        required: ['uid'],
      },
    },
    {
      name: 'email_move',
      description: 'Move a message to another mailbox.',
      inputSchema: {
        type: 'object',
        properties: {
          account: accountProperty('Account id, name or email.'),
          uid: { type: 'number' },
          folder: { type: 'string', description: 'Source folder, default INBOX.' },
          target: { type: 'string', description: 'Destination folder path.' },
        },
        required: ['uid', 'target'],
      },
    },
    {
      name: 'email_delete',
      description: 'Delete one message using IMAP deletion semantics (usually moves it to Trash).',
      inputSchema: {
        type: 'object',
        properties: {
          account: accountProperty('Account id, name or email.'),
          uid: { type: 'number' },
          folder: { type: 'string' },
        },
        required: ['uid'],
      },
    },
    {
      name: 'email_send',
      description: 'Send a new email from an account. This is a write operation; use only when the operator intends to send.',
      inputSchema: {
        type: 'object',
        properties: {
          account: accountProperty('Account id, name or email.'),
          to: { type: 'string' },
          cc: { type: 'string' },
          bcc: { type: 'string' },
          subject: { type: 'string' },
          text: { type: 'string' },
          html: { type: 'string' },
          in_reply_to: { type: 'string' },
          references: { type: 'array', items: { type: 'string' } },
        },
        required: ['to', 'subject'],
      },
    },
    {
      name: 'email_reply',
      description: 'Reply to a message. This is a write operation; use only when the operator intends to send.',
      inputSchema: {
        type: 'object',
        properties: {
          account: accountProperty('Account id, name or email.'),
          uid: { type: 'number' },
          folder: { type: 'string', description: 'Folder containing the source message, default INBOX.' },
          text: { type: 'string' },
          html: { type: 'string' },
          reply_all: { type: 'boolean' },
        },
        required: ['uid', 'text'],
      },
    },
  ];
}

function textContent(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function errorContent(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
}

function stringArg(args: Record<string, unknown>, name: string, fallback?: string): string | undefined {
  const value = args[name];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return fallback;
}

function numberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function accountArg(args: Record<string, unknown>): string {
  return stringArg(args, 'account', '') ?? '';
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'email_list_accounts':
      return service.listAccounts();
    case 'email_test_account':
      return service.testAccount(accountArg(args));
    case 'email_list_folders':
      return service.listFolders(accountArg(args));
    case 'email_list_messages':
      return service.listMessages(accountArg(args), {
        folder: stringArg(args, 'folder', 'INBOX'),
        limit: numberArg(args, 'limit') ?? 30,
        unreadOnly: args.unread_only === true,
        search: stringArg(args, 'search'),
      });
    case 'email_search':
      return service.listMessages(accountArg(args), {
        folder: stringArg(args, 'folder', 'INBOX'),
        limit: numberArg(args, 'limit') ?? 30,
        search: stringArg(args, 'query'),
      });
    case 'email_read_message': {
      const uid = numberArg(args, 'uid');
      if (uid === undefined) throw new Error('uid is required');
      return service.readMessage(accountArg(args), uid, stringArg(args, 'folder', 'INBOX'));
    }
    case 'email_mark_read': {
      const uid = numberArg(args, 'uid');
      if (uid === undefined) throw new Error('uid is required');
      await service.markRead(accountArg(args), uid, args.read !== false, stringArg(args, 'folder', 'INBOX'));
      return { ok: true };
    }
    case 'email_move': {
      const uid = numberArg(args, 'uid');
      const target = stringArg(args, 'target');
      if (uid === undefined || target === undefined) throw new Error('uid and target are required');
      await service.moveMessage(accountArg(args), uid, stringArg(args, 'folder', 'INBOX') as string, target);
      return { ok: true };
    }
    case 'email_delete': {
      const uid = numberArg(args, 'uid');
      if (uid === undefined) throw new Error('uid is required');
      await service.deleteMessage(accountArg(args), uid, stringArg(args, 'folder', 'INBOX'));
      return { ok: true };
    }
    case 'email_send': {
      const to = stringArg(args, 'to');
      const subject = stringArg(args, 'subject');
      if (to === undefined || subject === undefined) throw new Error('to and subject are required');
      return service.send(accountArg(args), {
        to,
        subject,
        cc: stringArg(args, 'cc'),
        bcc: stringArg(args, 'bcc'),
        text: stringArg(args, 'text'),
        html: stringArg(args, 'html'),
        inReplyTo: stringArg(args, 'in_reply_to') ?? null,
        references: Array.isArray(args.references) ? args.references.filter((value): value is string => typeof value === 'string') : undefined,
      });
    }
    case 'email_reply': {
      const uid = numberArg(args, 'uid');
      const text = stringArg(args, 'text');
      if (uid === undefined || text === undefined) throw new Error('uid and text are required');
      const source = await service.readMessage(accountArg(args), uid, stringArg(args, 'folder', 'INBOX'));
      const replyTo = source.replyTo || source.from;
      const subject = source.subject.toLowerCase().startsWith('re:') ? source.subject : `Re: ${source.subject}`;
      const references = [...source.references, ...(source.messageId === null ? [] : [source.messageId])];
      return service.send(accountArg(args), {
        to: replyTo,
        cc: args.reply_all === true ? source.to : undefined,
        subject,
        text,
        html: stringArg(args, 'html'),
        inReplyTo: source.messageId,
        references,
      });
    }
    default:
      throw new Error(`Unknown email tool: ${name}`);
  }
}

function reply(id: number | string | null | undefined, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result })}\n`);
}

function replyError(id: number | string | null | undefined, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })}\n`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  let request: RpcRequest;
  try {
    request = JSON.parse(trimmed) as RpcRequest;
  } catch {
    replyError(null, -32700, 'Parse error');
    return;
  }
  if (request.id === undefined) return; // notification
  if (request.method === 'initialize') {
    reply(request.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'email', version: '1.0.0' },
    });
    return;
  }
  if (request.method === 'ping') {
    reply(request.id, {});
    return;
  }
  if (request.method === 'tools/list') {
    reply(request.id, { tools: toolDefinitions() });
    return;
  }
  if (request.method === 'tools/call') {
    const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    const name = params?.name;
    if (typeof name !== 'string') {
      replyError(request.id, -32602, 'tools/call requires a name');
      return;
    }
    void callTool(name, params?.arguments ?? {})
      .then((result) => reply(request.id, textContent(result)))
      .catch((error: unknown) => reply(request.id, errorContent(error)));
    return;
  }
  replyError(request.id, -32601, `Method not found: ${request.method ?? ''}`);
});
