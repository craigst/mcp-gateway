/**
 * Admin REST surface for the gateway email client.
 *
 * Auth is the same as the console: a master API key or the Web UI session.
 * Account passwords are never returned. The MCP server uses the same service
 * and store, so one account and one server serve every API key.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ErrorCodes, GatewayError, accessDenied, invalidKey, invalidParams } from '../core/errors.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { GatewayConfig } from '../core/config.js';
import type { KeyService } from '../core/ports.js';
import type { AuthenticatedKey } from '../core/types.js';
import { readJsonBody } from '../gateway/server.js';
import type { EmailService } from './service.js';
import type { EmailAccountInput, SendEmailInput } from './types.js';
import type { AdminSubRouter } from '../admin/types.js';

const AREA = 'email';

export interface EmailApiDeps {
  config: GatewayConfig;
  keys: KeyService;
  email: EmailService;
  authenticate?: (req: IncomingMessage) => AuthenticatedKey;
  logger?: Logger;
}

function requireMasterKey(key: AuthenticatedKey): AuthenticatedKey {
  if (key.keyType !== 'master') {
    throw accessDenied('Access Denied: master privileges are required to manage email.', {
      reason: 'SCOPE_RESTRICTION',
    });
  }
  return key;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidParams('body must be an object');
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string, required = false): string | undefined {
  const value = body[name];
  if (value === undefined || value === null) {
    if (required) throw invalidParams(`"${name}" is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw invalidParams(`"${name}" must be a string`);
  const trimmed = value.trim();
  if (required && trimmed === '') throw invalidParams(`"${name}" is required`);
  return trimmed;
}

function optionalString(body: Record<string, unknown>, name: string): string | undefined {
  return stringField(body, name);
}

function boolField(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalidParams(`"${name}" must be a boolean`);
  return value;
}

function numberField(body: Record<string, unknown>, name: string): number | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidParams(`"${name}" must be a number`);
  return value;
}

function accountInput(body: Record<string, unknown>, partial = false): Partial<EmailAccountInput> {
  const input: Partial<EmailAccountInput> = {};
  const name = stringField(body, 'name', !partial);
  if (name !== undefined) input.name = name;
  for (const key of ['email', 'displayName', 'kind', 'imapHost', 'imapUser', 'imapPassword', 'smtpHost', 'smtpUser', 'smtpPassword', 'fromAddress'] as const) {
    const value = optionalString(body, key);
    if (value !== undefined) input[key] = value as never;
  }
  for (const key of ['enabled', 'isDefault', 'imapSecure', 'imapStartTls', 'smtpSecure'] as const) {
    const value = boolField(body, key);
    if (value !== undefined) input[key] = value as never;
  }
  for (const key of ['imapPort', 'smtpPort'] as const) {
    const value = numberField(body, key);
    if (value !== undefined) input[key] = value as never;
  }
  return input;
}

function sendInput(body: Record<string, unknown>): SendEmailInput {
  const to = stringField(body, 'to', true) as string;
  const subject = stringField(body, 'subject', true) as string;
  const input: SendEmailInput = { to, subject };
  for (const key of ['cc', 'bcc', 'text', 'html'] as const) {
    const value = optionalString(body, key);
    if (value !== undefined) input[key] = value;
  }
  const inReplyTo = body.inReplyTo;
  if (inReplyTo === null) input.inReplyTo = null;
  else if (typeof inReplyTo === 'string') input.inReplyTo = inReplyTo;
  if (Array.isArray(body.references) && body.references.every((value) => typeof value === 'string')) {
    input.references = body.references as string[];
  }
  return input;
}

export class EmailApi implements AdminSubRouter {
  private readonly logger: Logger;

  constructor(private readonly deps: EmailApiDeps) {
    this.logger = deps.logger ?? createLogger('admin.email');
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const segments = url.pathname.replace(/^\/mcp\/v1\/admin\/?/, '').split('/').filter(Boolean);
    if (segments[0] !== AREA) return false;
    const rest = segments.slice(1);
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      this.requireMaster(req);
      if (rest.length === 0 && method === 'GET') {
        const accounts = this.deps.email.listAccounts();
        this.sendJson(res, 200, { accounts, count: accounts.length });
        return true;
      }
      if (rest.length === 0 && method === 'POST') {
        const body = asRecord(await readJsonBody(req, this.deps.config.requestBodyLimitBytes));
        const input = accountInput(body) as EmailAccountInput;
        const account = this.deps.email.createAccount(input);
        this.sendJson(res, 201, { account });
        return true;
      }
      const accountId = rest.length === 0 ? null : decodeURIComponent(rest[0] as string);

      if (accountId === null) throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Unknown email endpoint', { httpStatus: 404 });

      if (rest.length === 1 && method === 'PATCH') {
        const body = asRecord(await readJsonBody(req, this.deps.config.requestBodyLimitBytes));
        const patch = accountInput(body, true);
        // A blank password in the settings dialog means "keep the existing one".
        if (patch.imapPassword === '') delete patch.imapPassword;
        if (patch.smtpPassword === '') delete patch.smtpPassword;
        const account = this.deps.email.updateAccount(accountId, patch);
        this.sendJson(res, 200, { account });
        return true;
      }
      if (rest.length === 1 && method === 'DELETE') {
        const deleted = this.deps.email.deleteAccount(accountId);
        if (!deleted) throw new GatewayError(ErrorCodes.TOOL_NOT_FOUND, 'Email account not found', { httpStatus: 404 });
        this.sendJson(res, 200, { deleted: true });
        return true;
      }
      if (rest.length === 2 && rest[1] === 'test' && method === 'POST') {
        this.sendJson(res, 200, await this.deps.email.testAccount(accountId));
        return true;
      }
      if (rest.length === 2 && rest[1] === 'folders' && method === 'GET') {
        this.sendJson(res, 200, { folders: await this.deps.email.listFolders(accountId) });
        return true;
      }
      if (rest.length === 2 && rest[1] === 'messages' && method === 'GET') {
        const limitValue = Number(url.searchParams.get('limit') ?? '30');
        const messages = await this.deps.email.listMessages(accountId, {
          folder: url.searchParams.get('folder') ?? 'INBOX',
          limit: Number.isFinite(limitValue) ? limitValue : 30,
          unreadOnly: url.searchParams.get('unread') === '1',
          search: url.searchParams.get('search') ?? undefined,
        });
        this.sendJson(res, 200, { messages });
        return true;
      }
      if (rest.length === 3 && rest[1] === 'messages' && method === 'GET') {
        const uid = Number(rest[2]);
        if (!Number.isSafeInteger(uid) || uid <= 0) throw invalidParams('message uid must be a positive integer');
        const message = await this.deps.email.readMessage(accountId, uid, url.searchParams.get('folder') ?? 'INBOX');
        this.sendJson(res, 200, { message });
        return true;
      }
      if (rest.length === 4 && rest[1] === 'messages' && rest[3] === 'read' && method === 'POST') {
        const uid = Number(rest[2]);
        if (!Number.isSafeInteger(uid) || uid <= 0) throw invalidParams('message uid must be a positive integer');
        const body = asRecord(await readJsonBody(req, this.deps.config.requestBodyLimitBytes));
        const read = boolField(body, 'read');
        await this.deps.email.markRead(accountId, uid, read !== false, typeof body.folder === 'string' ? body.folder : 'INBOX');
        this.sendJson(res, 200, { ok: true });
        return true;
      }
      if (rest.length === 4 && rest[1] === 'messages' && rest[3] === 'move' && method === 'POST') {
        const uid = Number(rest[2]);
        if (!Number.isSafeInteger(uid) || uid <= 0) throw invalidParams('message uid must be a positive integer');
        const body = asRecord(await readJsonBody(req, this.deps.config.requestBodyLimitBytes));
        const target = stringField(body, 'target', true) as string;
        await this.deps.email.moveMessage(accountId, uid, typeof body.folder === 'string' ? body.folder : 'INBOX', target);
        this.sendJson(res, 200, { ok: true });
        return true;
      }
      if (rest.length === 4 && rest[1] === 'messages' && rest[3] === 'delete' && method === 'POST') {
        const uid = Number(rest[2]);
        if (!Number.isSafeInteger(uid) || uid <= 0) throw invalidParams('message uid must be a positive integer');
        const body = asRecord(await readJsonBody(req, this.deps.config.requestBodyLimitBytes));
        await this.deps.email.deleteMessage(accountId, uid, typeof body.folder === 'string' ? body.folder : 'INBOX');
        this.sendJson(res, 200, { ok: true });
        return true;
      }
      if (rest.length === 2 && rest[1] === 'send' && method === 'POST') {
        const body = asRecord(await readJsonBody(req, this.deps.config.requestBodyLimitBytes));
        this.sendJson(res, 200, await this.deps.email.send(accountId, sendInput(body)));
        return true;
      }
      throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Unknown email endpoint', { httpStatus: 404 });
    } catch (error) {
      const gatewayError =
        error instanceof GatewayError
          ? error
          : new GatewayError(ErrorCodes.UPSTREAM_ERROR, error instanceof Error ? error.message : String(error), {
              httpStatus: 502,
              data: { status: 'EMAIL_UPSTREAM_ERROR' },
            });
      this.logger.debug('email request failed', {
        path: url.pathname,
        code: gatewayError.code,
        message: gatewayError.message,
      });
      this.sendJson(res, gatewayError.httpStatus, { error: gatewayError.toJSONRpcError() });
      return true;
    }
  }

  private requireMaster(req: IncomingMessage): AuthenticatedKey {
    if (this.deps.authenticate) return requireMasterKey(this.deps.authenticate(req));
    const header = req.headers.authorization;
    let plaintext: string | null = null;
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) plaintext = header.slice(7).trim();
    const apiKey = req.headers['x-mcp-api-key'];
    if (!plaintext && typeof apiKey === 'string') plaintext = apiKey.trim();
    if (!plaintext) throw invalidKey('MISSING_KEY');
    return requireMasterKey(this.deps.keys.authenticate(plaintext));
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }
}
