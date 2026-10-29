/**
 * Admin REST surface for the v0.2 plugin catalog (`docs/API-V2.md` §1).
 *
 * Mounted by `AdminApi` for the `catalog` area, so every path here is relative
 * to `/mcp/v1/admin/catalog`. Routes are master-key only and reuse the gateway's
 * `{ error: { code, message, data } }` envelope.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { GatewayConfig } from '../core/config.js';
import { ErrorCodes, GatewayError, accessDenied, invalidKey, invalidParams } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type { Logger } from '../core/logger.js';
import type { KeyService, PluginCatalogService } from '../core/ports.js';
import type {
  AuthenticatedKey,
  CatalogEntry,
  CatalogSource,
  CatalogSourceKind,
} from '../core/types.js';
import { readJsonBody } from '../gateway/server.js';
import type { AdminSubRouter } from './types.js';

const CATALOG_SOURCE_KINDS: readonly CatalogSourceKind[] = ['dsh-umbrella', 'github-repo', 'catalog-json'];

type PluginCatalogWithRefresh = PluginCatalogService & {
  listEntries(sourceId: string, options?: { refresh?: boolean }): Promise<CatalogEntry[]>;
};

export interface CatalogApiDeps {
  config: GatewayConfig;
  keys: KeyService;
  catalog: PluginCatalogService;
  logger?: Logger;
}

export class CatalogApi implements AdminSubRouter {
  private readonly logger: Logger;

  constructor(private readonly deps: CatalogApiDeps) {
    this.logger = deps.logger ?? createLogger('admin.catalog');
  }

  /** Returns true when the URL matched a catalog route (including error responses). */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const segments = url.pathname.replace(/^\/mcp\/v1\/admin\/?/, '').split('/').filter(Boolean);
    if (segments[0] !== 'catalog') return false;
    const rest = segments.slice(1);
    const method = req.method ?? 'GET';

    try {
      // --- Sources ---------------------------------------------------------
      if (rest.length === 1 && rest[0] === 'sources') {
        this.requireMaster(req);
        if (method === 'GET') {
          this.sendJson(res, 200, { sources: this.deps.catalog.listSources() });
          return true;
        }
        if (method === 'POST') {
          const body = await this.readObjectBody(req);
          const source = await this.deps.catalog.addSource({
            label: requireString(body, 'label'),
            kind: requireKind(body.kind),
            repoUrl: requireString(body, 'repoUrl'),
            ref: optionalStringOrNull(body, 'ref'),
            subpath: optionalStringOrNull(body, 'subpath'),
            token: optionalStringOrNull(body, 'token'),
          });
          this.sendJson(res, 201, { source });
          return true;
        }
        return false;
      }

      if (rest[0] === 'sources' && rest.length === 2 && method === 'DELETE') {
        this.requireMaster(req);
        this.deps.catalog.removeSource(rest[1] as string);
        this.sendJson(res, 200, { deleted: true });
        return true;
      }

      if (rest[0] === 'sources' && rest.length === 3 && rest[2] === 'entries' && method === 'GET') {
        this.requireMaster(req);
        const sourceId = rest[1] as string;
        const refresh = url.searchParams.get('refresh');
        const entries = await (this.deps.catalog as PluginCatalogWithRefresh).listEntries(sourceId, {
          refresh: refresh === '1' || refresh === 'true',
        });
        this.sendJson(res, 200, { source: this.findSource(sourceId), entries });
        return true;
      }

      // --- Install ---------------------------------------------------------
      if (rest.length === 1 && rest[0] === 'install' && method === 'POST') {
        this.requireMaster(req);
        const body = await this.readObjectBody(req);
        const result = await this.deps.catalog.install({
          sourceId: requireString(body, 'sourceId'),
          entryId: requireString(body, 'entryId'),
          name: optionalStringOrNull(body, 'name') ?? undefined,
          env: optionalEnv(body, 'env'),
          envFile: optionalStringOrNull(body, 'envFile'),
          start: optionalBoolean(body, 'start'),
          test: optionalBoolean(body, 'test'),
        });
        this.sendJson(res, 201, result);
        return true;
      }

      // --- Import by URL ---------------------------------------------------
      if (rest.length === 1 && rest[0] === 'import-url' && method === 'POST') {
        this.requireMaster(req);
        const body = await this.readObjectBody(req);
        const result = await this.deps.catalog.importUrl({
          url: requireString(body, 'url'),
          ref: optionalStringOrNull(body, 'ref'),
          subpath: optionalStringOrNull(body, 'subpath'),
          name: optionalStringOrNull(body, 'name') ?? undefined,
          env: optionalEnv(body, 'env'),
          envFile: optionalStringOrNull(body, 'envFile'),
          start: optionalBoolean(body, 'start'),
          test: optionalBoolean(body, 'test'),
        });
        this.sendJson(res, 201, result);
        return true;
      }

      return false;
    } catch (error) {
      const gatewayError =
        error instanceof GatewayError
          ? error
          : new GatewayError(ErrorCodes.INTERNAL_ERROR, String(error), { httpStatus: 500 });
      this.logger.debug('catalog request failed', {
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

  private findSource(sourceId: string): CatalogSource | null {
    return this.deps.catalog.listSources().find((source) => source.id === sourceId) ?? null;
  }

  private requireMaster(req: IncomingMessage): AuthenticatedKey {
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
      throw accessDenied('Access Denied: a master key is required for catalog management.', {
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
// Body field helpers
// ---------------------------------------------------------------------------

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidParams(`"${field}" is required and must be a non-empty string`);
  }
  return value.trim();
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

function optionalEnv(
  body: Record<string, unknown>,
  field: string,
): Record<string, string> | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw invalidParams(`"${field}" must be an object of string values`);
  }
  const env: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entryValue !== 'string') {
      throw invalidParams(`"${field}.${key}" must be a string`);
    }
    env[key] = entryValue;
  }
  return env;
}

function requireKind(value: unknown): CatalogSourceKind {
  if (typeof value !== 'string' || !CATALOG_SOURCE_KINDS.includes(value as CatalogSourceKind)) {
    throw invalidParams(`"kind" must be one of ${CATALOG_SOURCE_KINDS.join(', ')}`);
  }
  return value as CatalogSourceKind;
}
