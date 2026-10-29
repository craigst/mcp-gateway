/**
 * Admin REST surface for v0.9 computer use.
 *
 * Mounted by `AdminApi` for the `computer-use` area, so every path is relative
 * to `/mcp/v1/admin/computer-use`. Routes are master-only (Bearer API key or
 * Web UI session cookie via the injected authenticator) and reuse the standard
 * `{ error: { code, message, data } }` envelope.
 *
 * The operator token is write-only here: it is accepted by POST /settings and
 * stored in the encrypted vault, never returned by any read endpoint.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { GatewayConfig } from '../core/config.js';
import { ErrorCodes, GatewayError, accessDenied, invalidKey, invalidParams } from '../core/errors.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { ComputerUseService, KeyService } from '../core/ports.js';
import type { AuthenticatedKey, ComputerUseAvailabilityInput, ComputerUseSettingsInput } from '../core/types.js';
import { readJsonBody } from '../gateway/server.js';
import type { AdminSubRouter } from './types.js';

const AREA = 'computer-use';
const DEFAULT_FRAME_WIDTH = 480;

export interface ComputerUseApiDeps {
  config: GatewayConfig;
  keys: KeyService;
  computerUse: ComputerUseService;
  /** Resolves Bearer API key or Web UI session cookie. */
  authenticate?: (req: IncomingMessage) => AuthenticatedKey;
  logger?: Logger;
}

export class ComputerUseApi implements AdminSubRouter {
  private readonly logger: Logger;

  constructor(private readonly deps: ComputerUseApiDeps) {
    this.logger = deps.logger ?? createLogger('admin.computer-use');
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const segments = url.pathname.replace(/^\/mcp\/v1\/admin\/?/, '').split('/').filter(Boolean);
    if (segments[0] !== AREA) return false;
    const rest = segments.slice(1);
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      // GET /admin/computer-use -> overview
      if (rest.length === 0 && method === 'GET') {
        this.requireMaster(req);
        this.sendJson(res, 200, await this.deps.computerUse.overview());
        return true;
      }

      // POST /admin/computer-use/sync
      if (rest.length === 1 && rest[0] === 'sync' && method === 'POST') {
        this.requireMaster(req);
        this.sendJson(res, 200, await this.deps.computerUse.sync());
        return true;
      }

      // POST /admin/computer-use/settings {ComputerUseSettingsInput}
      if (rest.length === 1 && rest[0] === 'settings' && method === 'POST') {
        this.requireMaster(req);
        const body = await this.readObjectBody(req);
        this.sendJson(res, 200, await this.deps.computerUse.updateSettings(parseSettings(body)));
        return true;
      }

      // POST /admin/computer-use/availability {ComputerUseAvailabilityInput}
      if (rest.length === 1 && rest[0] === 'availability' && method === 'POST') {
        const principal = this.requireMaster(req);
        const body = await this.readObjectBody(req);
        const input = parseAvailability(body);
        this.sendJson(res, 200, await this.deps.computerUse.setAvailability(input, principal.name));
        return true;
      }

      // GET /admin/computer-use/computers
      if (rest.length === 1 && rest[0] === 'computers' && method === 'GET') {
        this.requireMaster(req);
        this.sendJson(res, 200, await this.deps.computerUse.listComputers());
        return true;
      }

      // GET /admin/computer-use/activity?limit=50
      if (rest.length === 1 && rest[0] === 'activity' && method === 'GET') {
        this.requireMaster(req);
        const limit = numberParam(url, 'limit', 50);
        this.sendJson(res, 200, { activity: await this.deps.computerUse.activity(limit) });
        return true;
      }

      // GET /admin/computer-use/computers/:id/frame?maxWidth=480
      if (rest.length === 3 && rest[0] === 'computers' && rest[2] === 'frame' && method === 'GET') {
        this.requireMaster(req);
        const computerId = decodeURIComponent(rest[1] as string);
        const frame = await this.deps.computerUse.frame(computerId, numberParam(url, 'maxWidth', DEFAULT_FRAME_WIDTH));
        res.writeHead(200, {
          'content-type': frame.contentType,
          'cache-control': 'private, no-store',
          'content-length': frame.data.length,
          ...(frame.frameTime === null ? {} : { 'x-frame-time': frame.frameTime }),
        });
        res.end(frame.data);
        return true;
      }

      // POST /admin/computer-use/computers/:id/start|stop
      if (rest.length === 3 && rest[0] === 'computers' && (rest[2] === 'start' || rest[2] === 'stop') && method === 'POST') {
        this.requireMaster(req);
        const computerId = decodeURIComponent(rest[1] as string);
        const computer =
          rest[2] === 'start'
            ? await this.deps.computerUse.startComputer(computerId)
            : await this.deps.computerUse.stopComputer(computerId);
        this.sendJson(res, 200, { computer });
        return true;
      }

      throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Unknown computer-use endpoint', {
        httpStatus: 404,
      });
    } catch (error) {
      const gatewayError =
        error instanceof GatewayError
          ? error
          : new GatewayError(ErrorCodes.INTERNAL_ERROR, String(error), { httpStatus: 500 });
      this.logger.debug('computer-use request failed', {
        path: url.pathname,
        code: gatewayError.code,
        message: gatewayError.message,
      });
      if (res.headersSent) {
        res.end();
        return true;
      }
      this.sendJson(res, gatewayError.httpStatus, { error: gatewayError.toJSONRpcError() });
      return true;
    }
  }

  private requireMaster(req: IncomingMessage): AuthenticatedKey {
    const injected = this.deps.authenticate;
    if (injected) {
      const key = injected(req);
      if (key.keyType !== 'master') {
        throw accessDenied('Access Denied: master privileges are required for computer-use management.', {
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
      throw accessDenied('Access Denied: a master key is required for computer-use management.', {
        reason: 'SCOPE_RESTRICTION',
      });
    }
    return key;
  }

  private async readObjectBody(req: IncomingMessage): Promise<Record<string, unknown>> {
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
// Body parsing
// ---------------------------------------------------------------------------

function parseSettings(body: Record<string, unknown>): ComputerUseSettingsInput {
  const input: ComputerUseSettingsInput = {};
  if ('brokerUrl' in body) input.brokerUrl = optionalStringOrNull(body, 'brokerUrl');
  if ('publicBrokerUrl' in body) input.publicBrokerUrl = optionalStringOrNull(body, 'publicBrokerUrl');
  if ('caFile' in body) input.caFile = optionalStringOrNull(body, 'caFile');
  if ('token' in body) {
    const token = body.token;
    if (token !== null && typeof token !== 'string') throw invalidParams("'token' must be a string or null");
    input.token = token === null ? null : token;
  }
  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') throw invalidParams("'enabled' must be a boolean");
    input.enabled = body.enabled;
  }
  return input;
}

function parseAvailability(body: Record<string, unknown>): ComputerUseAvailabilityInput {
  if (typeof body.available !== 'boolean') throw invalidParams("'available' must be a boolean");
  const available = body.available;
  const reason = body.reason === undefined ? null : optionalStringOrNull(body, 'reason');
  const until = body.until === undefined ? null : optionalStringOrNull(body, 'until');
  if (body.scope === 'global') {
    return { scope: 'global', available, reason, until };
  }
  if (body.scope === 'computer') {
    const computerId = typeof body.computerId === 'string' ? body.computerId.trim() : '';
    if (computerId === '') throw invalidParams("'computerId' is required for computer scope");
    return { scope: 'computer', computerId, available, reason, until };
  }
  throw invalidParams("'scope' must be 'global' or 'computer'");
}

function optionalStringOrNull(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidParams(`"${field}" must be a string or null`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function numberParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
