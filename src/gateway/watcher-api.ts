/**
 * Scoped HTTP surface for the social watcher processes.
 *
 *   GET  /mcp/v1/watcher/:source/settings  -> current settings
 *   POST /mcp/v1/watcher/:source/contacts  -> publish the synced contact catalog
 *
 * source is `whatsapp` or `instagram`. Only a key whose metadata role is
 * `watcher` (or whose name starts with `watcher-`) may call these. The watcher
 * keys have no MCP server grants; they read their own settings and publish
 * contacts for the console.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { ErrorCodes, GatewayError, accessDenied, invalidParams } from '../core/errors.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { AuthenticatedKey } from '../core/types.js';
import { readJsonBody } from './server.js';
import { parseWatcherSource, type WatcherService } from '../watchers/service.js';
import type { EmailService } from '../email/service.js';
import type { EmailTriageStore } from '../email/triage-store.js';
import type { EmailTriageSettings } from '../email/types.js';

/** How long the watcher waits when every mailbox is off, or none is due. */
const IDLE_WAIT_SECONDS = 60;
/** Messages handed over per mailbox per call. */
const EMAIL_BATCH_LIMIT = 20;

export interface WatcherApiDeps {
  service: WatcherService;
  /** Read-only access to the mailboxes the operator switched on. */
  email?: EmailService;
  triage?: EmailTriageStore;
  authenticate?: (req: IncomingMessage) => AuthenticatedKey;
  logger?: Logger;
}

export class WatcherApi {
  private readonly logger: Logger;

  constructor(private readonly deps: WatcherApiDeps) {
    this.logger = deps.logger ?? createLogger('gateway.watcher');
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/mcp/v1/watcher/')) return false;
    const suffix = url.pathname.slice('/mcp/v1/watcher/'.length).split('/').filter(Boolean);
    if (suffix.length !== 2) return false;
    const [rawSource, action] = suffix;
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      const principal = this.requireWatcher(req);
      // Email is not a social source: its settings are per mailbox, not one
      // selected-contacts list, so it has its own two actions.
      if (rawSource === 'email') {
        await this.handleEmail(req, res, action, method, principal);
        return true;
      }
      const source = parseWatcherSource(rawSource);
      if (action === 'settings' && method === 'GET') {
        this.sendJson(res, 200, { settings: this.deps.service.getSettings(source) });
        return true;
      }
      if (action === 'contacts' && method === 'POST') {
        const body = (await readJsonBody(req, 1_048_576)) as { contacts?: unknown };
        const result = this.deps.service.syncContacts(source, body?.contacts ?? []);
        this.sendJson(res, 200, { ok: true, ...result });
        return true;
      }
      if (action === 'settings' || action === 'contacts') {
        this.sendJson(res, 405, {
          error: {
            code: ErrorCodes.METHOD_NOT_FOUND,
            message: action === 'settings' ? 'Use GET.' : 'Use POST.',
            data: { status: 'METHOD_NOT_ALLOWED' },
          },
        });
        return true;
      }
      this.logger.debug('unknown watcher endpoint', { path: url.pathname, key: principal.name });
      this.sendJson(res, 404, {
        error: {
          code: ErrorCodes.METHOD_NOT_FOUND,
          message: 'Unknown watcher endpoint.',
          data: { status: 'NOT_FOUND' },
        },
      });
      return true;
    } catch (error) {
      const gatewayError =
        error instanceof GatewayError
          ? error
          : new GatewayError(ErrorCodes.INTERNAL_ERROR, String(error), { httpStatus: 500 });
      this.logger.debug('watcher request failed', {
        path: url.pathname,
        code: gatewayError.code,
        message: gatewayError.message,
      });
      this.sendJson(res, gatewayError.httpStatus, { error: gatewayError.toJSONRpcError() });
      return true;
    }
  }

  /**
   * The email triage surface: what the watcher may read, and what it has read.
   *
   * GET  /mcp/v1/watcher/email/new   -> due mailboxes with their new headers
   * POST /mcp/v1/watcher/email/ack   -> advance one mailbox's cursor
   *
   * Due-ness is decided here from `last_run_at` + `poll_seconds`, so the
   * watcher is a dumb loop: ask, do the work, ack, sleep `waitSeconds`. A
   * mailbox is never read unless its row says enabled, and the cursor only
   * moves on an explicit ack — a crash re-delivers instead of skipping.
   */
  private async handleEmail(
    req: IncomingMessage,
    res: ServerResponse,
    action: string | undefined,
    method: string,
    principal: AuthenticatedKey,
  ): Promise<void> {
    const email = this.deps.email;
    const triage = this.deps.triage;
    if (email === undefined || triage === undefined) {
      throw new GatewayError(ErrorCodes.INTERNAL_ERROR, 'Email triage is not configured on this gateway.', {
        httpStatus: 501,
      });
    }
    if (action === 'new' && method === 'GET') {
      const now = Date.now();
      const accounts: Array<{
        settings: EmailTriageSettings;
        uidValidity: string;
        uidNext: number;
        messages: unknown[];
      }> = [];
      let waitSeconds = IDLE_WAIT_SECONDS;
      for (const settings of triage.enabledAccounts(email.listAccounts())) {
        const lastRun = settings.lastRunAt === null ? Number.NaN : Date.parse(settings.lastRunAt);
        const elapsed = Number.isFinite(lastRun) ? now - lastRun : Number.POSITIVE_INFINITY;
        if (elapsed < settings.pollSeconds * 1000) {
          waitSeconds = Math.min(waitSeconds, Math.max(1, Math.ceil((settings.pollSeconds * 1000 - elapsed) / 1000)));
          continue;
        }
        try {
          const batch = await email.listNewMessages(settings.accountId, {
            afterUid: settings.lastUid,
            uidValidity: settings.uidValidity,
            limit: EMAIL_BATCH_LIMIT,
          });
          accounts.push({ settings, uidValidity: batch.uidValidity, uidNext: batch.uidNext, messages: batch.messages });
          this.logger.debug('email batch handed out', {
            accountId: settings.accountId,
            count: batch.messages.length,
            key: principal.name,
          });
        } catch (error) {
          // One unreachable mailbox must not stop the others, and must not advance its cursor.
          this.logger.warn('email batch failed', {
            accountId: settings.accountId,
            error: error instanceof Error ? error.message : String(error),
          });
          waitSeconds = Math.min(waitSeconds, IDLE_WAIT_SECONDS);
        }
      }
      this.sendJson(res, 200, { accounts, waitSeconds, generatedAt: new Date(now).toISOString() });
      return;
    }
    if (action === 'ack' && method === 'POST') {
      const body = (await readJsonBody(req, 65_536)) as { accountId?: unknown; uidValidity?: unknown; lastUid?: unknown };
      const accountId = typeof body.accountId === 'string' ? body.accountId : '';
      if (accountId === '') throw invalidParams('accountId is required');
      if (typeof body.uidValidity !== 'string' || body.uidValidity === '') throw invalidParams('uidValidity is required');
      if (typeof body.lastUid !== 'number' || !Number.isSafeInteger(body.lastUid) || body.lastUid < 0) {
        throw invalidParams('lastUid must be a non-negative integer');
      }
      if (!triage.get(accountId).enabled) {
        throw accessDenied('Access Denied: triage is not enabled for that mailbox.', { reason: 'SCOPE_RESTRICTION' });
      }
      triage.setCursor(accountId, body.uidValidity, body.lastUid, new Date().toISOString());
      this.sendJson(res, 200, { ok: true, accountId, lastUid: body.lastUid });
      return;
    }
    this.sendJson(res, action === 'new' || action === 'ack' ? 405 : 404, {
      error: {
        code: ErrorCodes.METHOD_NOT_FOUND,
        message: action === 'new' ? 'Use GET.' : action === 'ack' ? 'Use POST.' : 'Unknown email watcher endpoint.',
        data: { status: 'NOT_FOUND' },
      },
    });
  }

  private requireWatcher(req: IncomingMessage): AuthenticatedKey {
    if (!this.deps.authenticate) throw accessDenied('Authentication is not configured.');
    const principal = this.deps.authenticate(req);
    const role = principal.metadata?.role;
    if (role !== 'watcher' && !principal.name.startsWith('watcher-')) {
      throw accessDenied('Access Denied: a watcher-scoped key is required.', {
        reason: 'SCOPE_RESTRICTION',
      });
    }
    return principal;
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  }
}
