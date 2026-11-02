/**
 * Admin REST surface for the social watcher settings.
 *
 *   GET  /mcp/v1/admin/watchers/:source  -> overview (settings + synced contacts)
 *   POST /mcp/v1/admin/watchers/:source  -> save settings, return overview
 *
 * source is `whatsapp` or `instagram`. Master key or Web UI session only. The
 * watcher processes use the separate scoped /mcp/v1/watcher endpoints.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { ErrorCodes, GatewayError, accessDenied } from '../core/errors.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { AuthenticatedKey, WatcherSettingsInput } from '../core/types.js';
import { readJsonBody } from '../gateway/server.js';
import { parseWatcherSource, type WatcherService } from '../watchers/service.js';
import type { AdminSubRouter } from './types.js';

const AREA = 'watchers';

export interface WatchersApiDeps {
  service: WatcherService;
  authenticate?: (req: IncomingMessage) => AuthenticatedKey;
  logger?: Logger;
}

export class WatchersApi implements AdminSubRouter {
  private readonly logger: Logger;

  constructor(private readonly deps: WatchersApiDeps) {
    this.logger = deps.logger ?? createLogger('admin.watchers');
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const segments = url.pathname.replace(/^\/mcp\/v1\/admin\/?/, '').split('/').filter(Boolean);
    if (segments[0] !== AREA) return false;
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      const principal = this.requireMaster(req);
      if (segments.length !== 2) {
        throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Unknown watcher endpoint', {
          httpStatus: 404,
        });
      }
      const source = parseWatcherSource(segments[1]);
      if (method === 'GET') {
        this.sendJson(res, 200, this.deps.service.getOverview(source));
        return true;
      }
      if (method === 'POST') {
        const body = (await readJsonBody(req, 1_048_576)) as WatcherSettingsInput;
        this.sendJson(res, 200, this.deps.service.update(source, body, principal.name));
        return true;
      }
      this.sendJson(res, 405, {
        error: {
          code: ErrorCodes.METHOD_NOT_FOUND,
          message: 'Method Not Allowed. Expected GET or POST.',
          data: { status: 'METHOD_NOT_ALLOWED' },
        },
      });
      return true;
    } catch (error) {
      const gatewayError =
        error instanceof GatewayError
          ? error
          : new GatewayError(ErrorCodes.INTERNAL_ERROR, String(error), { httpStatus: 500 });
      this.logger.debug('watcher admin request failed', {
        path: url.pathname,
        code: gatewayError.code,
        message: gatewayError.message,
      });
      this.sendJson(res, gatewayError.httpStatus, { error: gatewayError.toJSONRpcError() });
      return true;
    }
  }

  private requireMaster(req: IncomingMessage): AuthenticatedKey {
    if (!this.deps.authenticate) {
      throw accessDenied('Authentication is not configured.', { reason: 'SCOPE_RESTRICTION' });
    }
    const principal = this.deps.authenticate(req);
    if (principal.keyType !== 'master') {
      throw accessDenied('Access Denied: master privileges are required for watcher settings.', {
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
