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
import type { JevClient, JevTriage } from '../email/jev.js';
import type { AuditService } from '../core/ports.js';

/** How long the watcher waits when every mailbox is off, or none is due. */
const IDLE_WAIT_SECONDS = 60;
/** Messages handed over per mailbox per call. */
const EMAIL_BATCH_LIMIT = 20;
/** Messages judged per call; the watcher sends at most this many. */
const JUDGE_BATCH_LIMIT = 20;
/** Jev calls in flight at once: fast enough for a batch of 20, gentle on the model. */
const JUDGE_CONCURRENCY = 4;
const JUDGE_ID_MAX = 200;

export interface WatcherApiDeps {
  service: WatcherService;
  /** Read-only access to the mailboxes the operator switched on. */
  email?: EmailService;
  triage?: EmailTriageStore;
  /** The decision model; absent means triage cannot judge, and mail waits untouched. */
  jev?: JevClient;
  /** Decisions are written here so one trail holds the judgement and the action. */
  audit?: AuditService;
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
      // Rule decisions (newsletter, repeat, allowlist) never reach the model, so
      // the watcher reports them with the ack and they land in the same trail.
      const rawDecisions = (body as { decisions?: unknown }).decisions;
      let audited = 0;
      if (Array.isArray(rawDecisions)) {
        for (const entry of rawDecisions.slice(0, EMAIL_BATCH_LIMIT)) {
          if (entry === null || typeof entry !== 'object') continue;
          const record = entry as Record<string, unknown>;
          if (typeof record.messageId !== 'string' || record.messageId === '') continue;
          if (typeof record.rule !== 'string' || record.rule === '') continue;
          this.deps.audit?.record({
            requestId: null,
            keyId: principal.id,
            method: 'email.triage',
            status: 'ok',
            latencyMs: 0,
            payload: {
              accountId,
              messageId: record.messageId,
              from: typeof record.from === 'string' ? record.from : null,
              subject: typeof record.subject === 'string' ? record.subject : null,
              triage: typeof record.triage === 'string' ? record.triage : null,
              rule: record.rule,
              source: 'rule',
            },
          });
          audited += 1;
        }
      }
      this.sendJson(res, 200, { ok: true, accountId, lastUid: body.lastUid, audited });
      return;
    }
    if (action === 'judge' && method === 'POST') {
      const jev = this.deps.jev;
      if (jev === undefined || !jev.configured) {
        // No key is not a guess: the batch waits and the mail is left alone.
        this.sendJson(res, 503, {
          error: {
            code: ErrorCodes.INTERNAL_ERROR,
            message: 'The decision model is not configured on this gateway (JEV_API_KEY).',
            data: { status: 'UNAVAILABLE', reason: 'disabled' },
          },
        });
        return;
      }
      const body = (await readJsonBody(req, 262_144)) as {
        accountId?: unknown;
        messages?: unknown;
        dismissedFrom?: unknown;
      };
      const accountId = typeof body.accountId === 'string' ? body.accountId : null;
      const raw = body.messages;
      if (!Array.isArray(raw) || raw.length === 0) throw invalidParams('messages must be a non-empty array');
      if (raw.length > JUDGE_BATCH_LIMIT) throw invalidParams(`messages holds at most ${JUDGE_BATCH_LIMIT} entries`);
      const inputs = raw.map((entry, index) => {
        if (entry === null || typeof entry !== 'object') throw invalidParams(`messages[${index}] must be an object`);
        const record = entry as Record<string, unknown>;
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        if (id === '' || id.length > JUDGE_ID_MAX) throw invalidParams(`messages[${index}].id must be a 1–${JUDGE_ID_MAX} character string`);
        for (const field of ['from', 'subject', 'preview'] as const) {
          if (typeof record[field] !== 'string') throw invalidParams(`messages[${index}].${field} must be a string`);
        }
        return {
          id,
          email: { from: record.from as string, subject: record.subject as string, preview: record.preview as string },
        };
      });
      const dismissedFrom = Array.isArray(body.dismissedFrom)
        ? body.dismissedFrom.filter((from): from is string => typeof from === 'string')
        : [];

      // Judge in small chunks: a batch of 20 is four rounds of four.
      const results: Array<{ id: string; verdict?: { triage: JevTriage; pTop: number; scamP: number }; reason?: string }> = [];
      for (let start = 0; start < inputs.length; start += JUDGE_CONCURRENCY) {
        const chunk = inputs.slice(start, start + JUDGE_CONCURRENCY);
        const judged = await Promise.all(
          chunk.map(async (entry) => ({ entry, result: await jev.judge(entry.email, { dismissedFrom }) })),
        );
        for (const { entry, result } of judged) {
          if (result.ok) {
            results.push({ id: entry.id, verdict: result.verdict });
            this.deps.audit?.record({
              requestId: null,
              keyId: principal.id,
              method: 'email.triage',
              status: 'ok',
              latencyMs: result.latencyMs,
              payload: {
                accountId,
                messageId: entry.id,
                from: entry.email.from,
                subject: entry.email.subject,
                triage: result.verdict.triage,
                pTop: result.verdict.pTop,
                scamP: result.verdict.scamP,
                model: 'jev-latest',
              },
            });
            continue;
          }
          // Too large is too large every time: remember it as a skip instead of
          // asking again for ever. Anything else fails the batch, so nothing is
          // half-judged and the watcher leaves the mail in place.
          if (result.reason === 'too_large') {
            results.push({ id: entry.id, verdict: { triage: 'skip', pTop: 0, scamP: 0 }, reason: 'too_large' });
            continue;
          }
          results.push({ id: entry.id, reason: result.reason });
        }
      }

      const failed = results.filter((entry) => entry.reason !== undefined && entry.reason !== 'too_large');
      if (failed.length > 0) {
        this.logger.warn('email judging failed', { failed: failed.length, of: inputs.length, reason: failed[0]?.reason });
        this.sendJson(res, 503, {
          error: {
            code: ErrorCodes.INTERNAL_ERROR,
            message: 'The decision model did not answer for every message; the batch waits.',
            data: { status: 'UNAVAILABLE', reason: failed[0]?.reason, failed },
          },
        });
        return;
      }
      this.sendJson(res, 200, {
        verdicts: results.map((entry) => ({
          id: entry.id,
          triage: entry.verdict?.triage,
          pTop: entry.verdict?.pTop,
          scamP: entry.verdict?.scamP,
          ...(entry.reason === 'too_large' ? { rule: 'too_large' } : {}),
        })),
        judged: inputs.length,
      });
      return;
    }
    this.sendJson(res, action === 'new' && method !== 'GET' ? 405 : 404, {
      error: {
        code: ErrorCodes.METHOD_NOT_FOUND,
        message: 'Unknown email watcher endpoint.',
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
