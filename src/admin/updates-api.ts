/**
 * Admin REST surface for v0.4 server update tracking.
 *
 * Mounted by `AdminApi` for the `updates` area, so every path is relative to
 * `/mcp/v1/admin/updates`. Routes are master-only (Bearer API key or Web UI
 * session cookie via the injected authenticator) and reuse the standard
 * `{ error: { code, message, data } }` envelope.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { GatewayConfig } from '../core/config.js';
import { ErrorCodes, GatewayError, accessDenied, invalidKey, invalidParams } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type { Logger } from '../core/logger.js';
import type { KeyService, ServerUpdateService } from '../core/ports.js';
import type { AuthenticatedKey, UpdateCheckResult } from '../core/types.js';
import { readJsonBody } from '../gateway/server.js';
import type { BackfillResult } from '../updates/service.js';
import type { AdminSubRouter } from './types.js';

type UpdatesWithBackfill = ServerUpdateService & {
  /** Optional args are implemented by DefaultServerUpdateService (port stays 0-arg). */
  checkAll(serverIds?: string[]): Promise<UpdateCheckResult[]>;
  backfillFromCatalog?: () => Promise<BackfillResult>;
};

export interface UpdatesApiDeps {
  config: GatewayConfig;
  keys: KeyService;
  updates: ServerUpdateService;
  /** Resolves Bearer API key or Web UI session cookie. */
  authenticate?: (req: IncomingMessage) => AuthenticatedKey;
  logger?: Logger;
}

export class UpdatesApi implements AdminSubRouter {
  private readonly logger: Logger;

  constructor(private readonly deps: UpdatesApiDeps) {
    this.logger = deps.logger ?? createLogger('admin.updates');
  }

  /** Returns true when the URL matched an updates route (including errors). */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const segments = url.pathname.replace(/^\/mcp\/v1\/admin\/?/, '').split('/').filter(Boolean);
    if (segments[0] !== 'updates') return false;
    const rest = segments.slice(1);
    const method = req.method ?? 'GET';

    try {
      // GET /admin/updates → every tracked server source.
      if (rest.length === 0 && method === 'GET') {
        this.requireMaster(req);
        this.sendJson(res, 200, { sources: this.deps.updates.listSources() });
        return true;
      }

      // POST /admin/updates/check { serverIds?: string[] }
      if (rest.length === 1 && rest[0] === 'check' && method === 'POST') {
        this.requireMaster(req);
        const body = await this.readOptionalObjectBody(req);
        const serverIds = optionalStringArray(body, 'serverIds');
        const results = await (this.deps.updates as UpdatesWithBackfill).checkAll(serverIds);
        this.sendJson(res, 200, { results });
        return true;
      }

      // POST /admin/updates/backfill
      if (rest.length === 1 && rest[0] === 'backfill' && method === 'POST') {
        this.requireMaster(req);
        const updates = this.deps.updates as UpdatesWithBackfill;
        if (typeof updates.backfillFromCatalog !== 'function') {
          throw new GatewayError(ErrorCodes.NOT_IMPLEMENTED, 'Update source backfill is not supported', {
            httpStatus: 501,
            data: { status: 'NOT_IMPLEMENTED' },
          });
        }
        const result = await updates.backfillFromCatalog();
        this.sendJson(res, 200, result);
        return true;
      }

      // POST /admin/updates/servers/:id/check
      if (rest.length === 3 && rest[0] === 'servers' && rest[2] === 'check' && method === 'POST') {
        this.requireMaster(req);
        const update = await this.deps.updates.check(rest[1] as string);
        this.sendJson(res, 200, { update });
        return true;
      }

      // POST /admin/updates/servers/:id/update { ref?, restart?, test? }
      if (rest.length === 3 && rest[0] === 'servers' && rest[2] === 'update' && method === 'POST') {
        this.requireMaster(req);
        const body = await this.readOptionalObjectBody(req);
        const result = await this.deps.updates.update(rest[1] as string, {
          ref: optionalStringOrNull(body, 'ref'),
          restart: optionalBoolean(body, 'restart'),
          test: optionalBoolean(body, 'test'),
        });
        this.sendJson(res, 200, { result });
        return true;
      }

      return false;
    } catch (error) {
      const gatewayError =
        error instanceof GatewayError
          ? error
          : new GatewayError(ErrorCodes.INTERNAL_ERROR, String(error), { httpStatus: 500 });
      this.logger.debug('updates request failed', {
        path: url.pathname,
        code: gatewayError.code,
        message: gatewayError.message,
      });
      this.sendJson(res, gatewayError.httpStatus, { error: gatewayError.toJSONRpcError() });
      return true;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private requireMaster(req: IncomingMessage): AuthenticatedKey {
    const injected = this.deps.authenticate;
    if (injected) {
      const key = injected(req);
      if (key.keyType !== 'master') {
        throw accessDenied('Access Denied: master privileges are required for this admin resource.', {
          reason: 'SCOPE_RESTRICTION',
        });
      }
      return key;
    }
    const header = req.headers.authorization;
    let plaintext: string | null = null;
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
      plaintext = header.slice(7).trim();
    }
    const apiKey = req.headers['x-mcp-api-key'];
    if (!plaintext && typeof apiKey === 'string') plaintext = apiKey.trim();
    if (!plaintext) throw invalidKey('MISSING_KEY');
    const key = this.deps.keys.authenticate(plaintext);
    if (key.keyType !== 'master') {
      throw accessDenied('Access Denied: a master key is required for update management.', {
        reason: 'SCOPE_RESTRICTION',
      });
    }
    return key;
  }

  /** Body is optional for check/update; an empty request body means "{}". */
  private async readOptionalObjectBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const length = req.headers['content-length'];
    const hasBody =
      (typeof length === 'string' && Number.parseInt(length, 10) > 0) ||
      req.headers['transfer-encoding'] !== undefined;
    if (!hasBody) return {};

    const body = await readJsonBody(req, this.deps.config.requestBodyLimitBytes);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw invalidParams('JSON object body required');
    }
    return body as Record<string, unknown>;
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

// ---------------------------------------------------------------------------
// Body field helpers
// ---------------------------------------------------------------------------

function optionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw invalidParams(`"${field}" must be an array of non-empty strings`);
  }
  return value.map((item) => (item as string).trim());
}

function optionalStringOrNull(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidParams(`"${field}" must be a string or null`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw invalidParams(`"${field}" must be a boolean`);
  return value;
}
