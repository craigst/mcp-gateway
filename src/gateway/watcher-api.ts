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

import { ErrorCodes, GatewayError, accessDenied } from '../core/errors.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { AuthenticatedKey } from '../core/types.js';
import { readJsonBody } from './server.js';
import { parseWatcherSource, type WatcherService } from '../watchers/service.js';

export interface WatcherApiDeps {
  service: WatcherService;
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
