/**
 * Admin REST surface for the v0.5 server inspector.
 *
 * `AdminApi` delegates `/mcp/v1/admin/servers/:id/inspector|activity|reveal` to
 * this sub-router. All routes are master-only (Bearer API key or Web UI session
 * cookie via the injected authenticator); the reveal route is additionally
 * audited by `ServerInspectorService` (`method: 'admin.reveal'`).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { GatewayConfig } from '../core/config.js';
import { ErrorCodes, GatewayError, accessDenied, invalidKey, invalidParams } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type { Logger } from '../core/logger.js';
import type { KeyService } from '../core/ports.js';
import type { AuditStatus, AuthenticatedKey } from '../core/types.js';
import { readJsonBody } from '../gateway/server.js';
import type {
  InspectorActivityFilter,
  InspectorRevealRequest,
  ServerInspectorService,
} from '../inspector/service.js';
import type { AdminSubRouter } from './types.js';

const INSPECTOR_ACTIONS = ['inspector', 'activity', 'reveal'] as const;
const AUDIT_STATUSES: readonly AuditStatus[] = ['ok', 'error', 'denied'];

type InspectorAction = (typeof INSPECTOR_ACTIONS)[number];

export interface InspectorApiDeps {
  config: GatewayConfig;
  keys: KeyService;
  inspector: ServerInspectorService;
  /** Resolves Bearer API key or Web UI session cookie. */
  authenticate?: (req: IncomingMessage) => AuthenticatedKey;
  logger?: Logger;
}

export class InspectorApi implements AdminSubRouter {
  private readonly logger: Logger;

  constructor(private readonly deps: InspectorApiDeps) {
    this.logger = deps.logger ?? createLogger('admin.inspector');
  }

  /** Returns true when the URL matched an inspector route (including errors). */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const segments = url.pathname.replace(/^\/mcp\/v1\/admin\/?/, '').split('/').filter(Boolean);
    if (segments.length !== 3 || segments[0] !== 'servers') return false;
    const serverId = segments[1] as string;
    const action = segments[2] as string;
    if (!(INSPECTOR_ACTIONS as readonly string[]).includes(action)) return false;
    const typedAction = action as InspectorAction;
    const method = (req.method ?? 'GET').toUpperCase();
    const expectedMethod = typedAction === 'reveal' ? 'POST' : 'GET';
    if (method !== expectedMethod) return false;

    try {
      const principal = this.requireMaster(req);

      if (typedAction === 'inspector') {
        this.sendJson(res, 200, this.deps.inspector.overview(serverId));
        return true;
      }

      if (typedAction === 'activity') {
        const filter = this.parseActivityFilter(url);
        this.sendJson(res, 200, this.deps.inspector.activity(serverId, filter));
        return true;
      }

      const request = await this.parseRevealRequest(req);
      const revealed = this.deps.inspector.reveal(serverId, request, principal);
      this.logger.info('secret revealed through inspector API', {
        serverId,
        principalId: principal.id,
        kind: request.kind,
      });
      this.sendJson(res, 200, revealed);
      return true;
    } catch (error) {
      const gatewayError =
        error instanceof GatewayError
          ? error
          : new GatewayError(ErrorCodes.INTERNAL_ERROR, String(error), { httpStatus: 500 });
      this.logger.debug('inspector request failed', {
        path: url.pathname,
        code: gatewayError.code,
        message: gatewayError.message,
      });
      this.sendJson(res, gatewayError.httpStatus, { error: gatewayError.toJSONRpcError() });
      return true;
    }
  }

  // -------------------------------------------------------------------------
  // Request parsing
  // -------------------------------------------------------------------------

  private parseActivityFilter(url: URL): InspectorActivityFilter {
    const filter: InspectorActivityFilter = {};

    const status = url.searchParams.get('status');
    if (status !== null && status !== '') {
      if (!AUDIT_STATUSES.includes(status as AuditStatus)) {
        throw invalidParams(`"status" must be one of ${AUDIT_STATUSES.join(', ')}`);
      }
      filter.status = status as AuditStatus;
    }

    const toolId = url.searchParams.get('toolId');
    if (toolId !== null && toolId !== '') filter.toolId = toolId;

    const keyId = url.searchParams.get('keyId');
    if (keyId !== null && keyId !== '') filter.keyId = keyId;

    const limit = intParam(url, 'limit');
    if (limit !== null) filter.limit = limit;
    const offset = intParam(url, 'offset');
    if (offset !== null) filter.offset = offset;

    return filter;
  }

  private async parseRevealRequest(req: IncomingMessage): Promise<InspectorRevealRequest> {
    const body = await readJsonBody(req, this.deps.config.requestBodyLimitBytes);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw invalidParams('JSON object body required');
    }
    const record = body as Record<string, unknown>;

    const kind = record.kind;
    if (kind !== 'env' && kind !== 'header' && kind !== 'profile') {
      throw invalidParams('"kind" must be one of env, header, profile');
    }
    const key = record.key;
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw invalidParams('"key" is required');
    }
    let profileId: string | null = null;
    if (record.profileId !== undefined && record.profileId !== null) {
      if (typeof record.profileId !== 'string') {
        throw invalidParams('"profileId" must be a string');
      }
      profileId = record.profileId.trim() === '' ? null : record.profileId.trim();
    }
    if (kind === 'profile' && profileId === null) {
      throw invalidParams('"profileId" is required for kind "profile"');
    }

    return { kind, key: key.trim(), profileId };
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  private requireMaster(req: IncomingMessage): AuthenticatedKey {
    const injected = this.deps.authenticate;
    if (injected) {
      const key = injected(req);
      if (key.keyType !== 'master') {
        throw accessDenied(
          'Access Denied: master privileges are required for the server inspector.',
          { reason: 'SCOPE_RESTRICTION' },
        );
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
      throw accessDenied('Access Denied: a master key is required for the server inspector.', {
        reason: 'SCOPE_RESTRICTION',
      });
    }
    return key;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }
}

function intParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw invalidParams(`"${name}" must be an integer`);
  return parsed;
}
