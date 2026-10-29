/**
 * Admin REST surface for v0.7 credential providers.
 *
 * Mounted by `AdminApi` for the `credentials` area. Master/session-only
 * (Bearer API key or Web UI session via the injected authenticator).
 *
 * Provider configuration, item listing and reveal all pass through
 * `CredentialProviderService`; revealed values are returned only to the caller
 * and NEVER logged. Every successful reveal records an audit entry
 * (`admin.credential.reveal`) carrying provider/item/field metadata only.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { GatewayConfig } from '../core/config.js';
import { ErrorCodes, GatewayError, accessDenied, invalidKey, invalidParams } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type { Logger } from '../core/logger.js';
import type { AuditService, CredentialProviderService, KeyService } from '../core/ports.js';
import type { AuthenticatedKey, CredentialProviderId } from '../core/types.js';
import { PROVIDER_IDS } from '../credentials/index.js';
import { readJsonBody } from '../gateway/server.js';
import type { AdminSubRouter } from './types.js';

const REVEAL_AUDIT_METHOD = 'admin.credential.reveal';

export interface CredentialsApiDeps {
  config: GatewayConfig;
  keys: KeyService;
  credentials: CredentialProviderService;
  audit: AuditService;
  /** Resolves Bearer API key or Web UI session cookie. */
  authenticate?: (req: IncomingMessage) => AuthenticatedKey;
  logger?: Logger;
}

export class CredentialsApi implements AdminSubRouter {
  private readonly logger: Logger;

  constructor(private readonly deps: CredentialsApiDeps) {
    this.logger = deps.logger ?? createLogger('admin.credentials');
  }

  /** Returns true when the URL matched a credential route (including errors). */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const segments = url.pathname.replace(/^\/mcp\/v1\/admin\/?/, '').split('/').filter(Boolean);
    if (segments[0] !== 'credentials') return false;
    const rest = segments.slice(1);
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      // GET /credentials/providers
      if (rest.length === 1 && rest[0] === 'providers' && method === 'GET') {
        this.requireMaster(req);
        const defaultProvider = await this.deps.credentials.defaultProvider();
        this.sendJson(res, 200, {
          providers: await this.deps.credentials.listProviders(),
          descriptors: this.deps.credentials.descriptors(),
          defaultProvider,
        });
        return true;
      }

      // PUT /credentials/providers/:id
      if (rest.length === 2 && rest[0] === 'providers' && method === 'PUT') {
        this.requireMaster(req);
        const providerId = requireProviderId(rest[1]);
        const body = await this.readObjectBody(req);
        const values = requireValues(body);
        const provider = await this.deps.credentials.configure(providerId, values);
        const descriptor = this.deps.credentials
          .descriptors()
          .find((candidate) => candidate.id === providerId);
        if (descriptor === undefined) throw invalidParams(`Unknown credential provider '${providerId}'`);
        this.logger.info('credential provider configured via API', { provider: providerId });
        this.sendJson(res, 200, { provider, descriptor });
        return true;
      }

      // DELETE /credentials/providers/:id
      if (rest.length === 2 && rest[0] === 'providers' && method === 'DELETE') {
        this.requireMaster(req);
        const providerId = requireProviderId(rest[1]);
        const provider = await this.deps.credentials.clear(providerId);
        this.logger.info('credential provider cleared via API', { provider: providerId });
        this.sendJson(res, 200, { provider });
        return true;
      }

      // POST /credentials/providers/:id/test
      if (rest.length === 3 && rest[0] === 'providers' && rest[2] === 'test' && method === 'POST') {
        this.requireMaster(req);
        const providerId = requireProviderId(rest[1]);
        const provider = await this.deps.credentials.test(providerId);
        this.sendJson(res, 200, { provider });
        return true;
      }

      // POST /credentials/default
      if (rest.length === 1 && rest[0] === 'default' && method === 'POST') {
        this.requireMaster(req);
        const body = await this.readObjectBody(req);
        const providerId = requireProviderId(body.providerId);
        await this.deps.credentials.setDefault(providerId);
        this.sendJson(res, 200, { defaultProvider: providerId });
        return true;
      }

      // GET /credentials/items?provider&search&limit
      if (rest.length === 1 && rest[0] === 'items' && method === 'GET') {
        this.requireMaster(req);
        const providerParam = url.searchParams.get('provider');
        const providerId =
          providerParam === null || providerParam.trim() === ''
            ? await this.deps.credentials.defaultProvider()
            : requireProviderId(providerParam);
        const search = url.searchParams.get('search') ?? undefined;
        const limit = optionalInt(url, 'limit');
        const items = await this.deps.credentials.listItems(providerId, {
          ...(search === undefined ? {} : { search }),
          ...(limit === null ? {} : { limit }),
        });
        this.sendJson(res, 200, { items });
        return true;
      }

      // POST /credentials/reveal
      if (rest.length === 1 && rest[0] === 'reveal' && method === 'POST') {
        const principal = this.requireMaster(req);
        const body = await this.readObjectBody(req);
        const providerId = requireProviderId(body.provider);
        const itemId = body.itemId;
        if (typeof itemId !== 'string' || itemId.trim().length === 0) {
          throw invalidParams('"itemId" is required');
        }
        let field: string | null = null;
        if (body.field !== undefined && body.field !== null) {
          if (typeof body.field !== 'string') throw invalidParams('"field" must be a string');
          field = body.field.trim() === '' ? null : body.field.trim();
        }
        const started = performance.now();
        const revealed = await this.deps.credentials.reveal(providerId, itemId.trim(), field);
        this.deps.audit.record({
          requestId: null,
          keyId: principal.id,
          method: REVEAL_AUDIT_METHOD,
          serverId: null,
          toolId: null,
          status: 'ok',
          latencyMs: Math.max(0, performance.now() - started),
          payload: {
            provider: revealed.provider,
            itemId: revealed.itemId,
            field: revealed.field,
          },
        });
        this.logger.info('credential revealed via API', {
          provider: revealed.provider,
          itemId: revealed.itemId,
          principalId: principal.id,
        });
        this.sendJson(res, 200, { reveal: revealed });
        return true;
      }

      return false;
    } catch (error) {
      const gatewayError =
        error instanceof GatewayError
          ? error
          : new GatewayError(ErrorCodes.INTERNAL_ERROR, String(error), { httpStatus: 500 });
      this.logger.debug('credential request failed', {
        path: url.pathname,
        code: gatewayError.code,
        message: gatewayError.message,
      });
      this.sendJson(res, gatewayError.httpStatus, { error: gatewayError.toJSONRpcError() });
      return true;
    }
  }

  // -------------------------------------------------------------------------
  // Auth / helpers
  // -------------------------------------------------------------------------

  private requireMaster(req: IncomingMessage): AuthenticatedKey {
    const injected = this.deps.authenticate;
    if (injected) {
      const key = injected(req);
      if (key.keyType !== 'master') {
        throw accessDenied('Access Denied: master privileges are required for credential management.', {
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
      throw accessDenied('Access Denied: a master key is required for credential management.', {
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
// Body helpers
// ---------------------------------------------------------------------------

function requireProviderId(value: unknown): CredentialProviderId {
  if (typeof value !== 'string' || !(PROVIDER_IDS as readonly string[]).includes(value)) {
    throw invalidParams(`"provider" must be one of ${PROVIDER_IDS.join(', ')}`);
  }
  return value as CredentialProviderId;
}

function requireValues(body: Record<string, unknown>): Record<string, string> {
  const values = body.values;
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw invalidParams('"values" must be an object of string values');
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (typeof value !== 'string') throw invalidParams(`"values.${key}" must be a string`);
    result[key] = value;
  }
  return result;
}

function optionalInt(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw invalidParams(`"${name}" must be an integer`);
  return parsed;
}
