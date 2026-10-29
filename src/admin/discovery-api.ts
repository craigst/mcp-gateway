/**
 * Admin REST surface for local harness discovery (API v0.2 §2).
 *
 *   GET  /mcp/v1/admin/discovery/sources
 *   POST /mcp/v1/admin/discovery/scan     (optional body: { harnessIds? })
 *   POST /mcp/v1/admin/discovery/import
 *
 * Master-key only, matching the rest of the admin surface. Discovery is
 * read-only/local-only; this router never returns env or header values.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { accessDenied, invalidParams, ErrorCodes, GatewayError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { GatewayConfig } from '../core/config.js';
import type { HarnessDiscoveryService, KeyService } from '../core/ports.js';
import type { AuthenticatedKey, HarnessImportInput, HarnessTransport } from '../core/types.js';
import { readJsonBody } from '../gateway/server.js';
import type { AdminSubRouter } from './types.js';

export interface DiscoveryApiDeps {
  config: GatewayConfig;
  keys: KeyService;
  discovery: HarnessDiscoveryService;
  logger?: Logger;
}

const HARNESS_TRANSPORTS: readonly HarnessTransport[] = ['stdio', 'http', 'sse', 'websocket'];

/** Mounted by `AdminApi` for `/mcp/v1/admin/discovery/*`. */
export class DiscoveryApi implements AdminSubRouter {
  private readonly logger: Logger;

  constructor(private readonly deps: DiscoveryApiDeps) {
    this.logger = deps.logger ?? createLogger('admin:discovery');
  }

  /** Returns true when the URL matched a discovery route (even if it errored). */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const segments = url.pathname.replace(/^\/mcp\/v1\/admin\/?/, '').split('/').filter(Boolean);
    if (segments[0] !== 'discovery') return false;
    const rest = segments.slice(1);

    try {
      this.requireMaster(req);
      const method = req.method ?? 'GET';

      if (rest.length === 1 && rest[0] === 'sources') {
        if (method !== 'GET') {
          throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Use GET for /admin/discovery/sources', { httpStatus: 405 });
        }
        this.sendJson(res, 200, { sources: this.deps.discovery.listSources() });
        return true;
      }

      if (rest.length === 1 && rest[0] === 'scan') {
        if (method !== 'POST') {
          throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Use POST for /admin/discovery/scan', { httpStatus: 405 });
        }
        const body = await this.readOptionalObjectBody(req);
        this.sendJson(res, 200, await this.deps.discovery.scan(parseHarnessIds(body)));
        return true;
      }

      if (rest.length === 1 && rest[0] === 'import') {
        if (method !== 'POST') {
          throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Use POST for /admin/discovery/import', { httpStatus: 405 });
        }
        const body = await this.readOptionalObjectBody(req);
        if (!body) throw invalidParams('JSON object body required');
        const server = await this.deps.discovery.importEntry(parseImportInput(body));
        this.sendJson(res, 201, { server });
        return true;
      }

      throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Unknown discovery endpoint', { httpStatus: 404 });
    } catch (error) {
      const gatewayError =
        error instanceof GatewayError
          ? error
          : new GatewayError(ErrorCodes.INTERNAL_ERROR, String(error), { httpStatus: 500 });
      this.logger.debug('discovery request failed', {
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
    const header = req.headers.authorization;
    let plaintext: string | null = null;
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) plaintext = header.slice(7).trim();
    const apiKey = req.headers['x-mcp-api-key'];
    if (!plaintext && typeof apiKey === 'string') plaintext = apiKey.trim();
    if (!plaintext) throw new GatewayError(ErrorCodes.KEY_INVALID, 'Unauthorized: missing API key.', { httpStatus: 401 });
    const key = this.deps.keys.authenticate(plaintext);
    if (key.keyType !== 'master') {
      throw accessDenied('Access Denied: key type is not permitted for this admin resource.', {
        reason: 'SCOPE_RESTRICTION',
      });
    }
    return key;
  }

  /**
   * Reads an optional JSON object body. `readJsonBody` rejects empty streams, so
   * that specific case is mapped to `null` for endpoints where the body is
   * optional (discovery scan).
   */
  private async readOptionalObjectBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    let body: unknown;
    try {
      body = await readJsonBody(req, this.deps.config.requestBodyLimitBytes);
    } catch (error) {
      if (
        error instanceof GatewayError &&
        error.code === ErrorCodes.INVALID_PARAMS &&
        error.message === 'Request body is empty'
      ) {
        return null;
      }
      throw error;
    }
    if (body === null || body === undefined) return null;
    if (!isRecord(body)) throw invalidParams('JSON object body required');
    return body;
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw invalidParams(`${field} is required`);
  return text;
}

function optionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalidParams(`${field} must be an array of strings`);
  return value.map((item) => String(item));
}

function parseHarnessIds(body: Record<string, unknown> | null): string[] | undefined {
  if (!body || body.harnessIds === undefined) return undefined;
  if (!Array.isArray(body.harnessIds)) throw invalidParams('harnessIds must be an array of harness ids');
  return body.harnessIds.map((id) => String(id));
}

function parseImportInput(body: Record<string, unknown>): HarnessImportInput {
  const harness = requiredString(body, 'harness');
  const name = requiredString(body, 'name');
  const input: HarnessImportInput = { harness, name };

  if (body.transport !== undefined) {
    if (typeof body.transport !== 'string' || !(HARNESS_TRANSPORTS as readonly string[]).includes(body.transport)) {
      throw invalidParams(`transport must be one of ${HARNESS_TRANSPORTS.join(', ')}`);
    }
    input.transport = body.transport as HarnessTransport;
  }

  if (body.command !== undefined) {
    if (body.command !== null && typeof body.command !== 'string') throw invalidParams('command must be a string');
    input.command = body.command as string | null;
  }
  if (body.url !== undefined) {
    if (body.url !== null && typeof body.url !== 'string') throw invalidParams('url must be a string');
    input.url = body.url as string | null;
  }
  if (body.args !== undefined) {
    if (!Array.isArray(body.args)) throw invalidParams('args must be an array of strings');
    input.args = body.args.map((arg) => String(arg));
  }
  if (body.env !== undefined) {
    if (!isRecord(body.env)) throw invalidParams('env must be an object');
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(body.env)) {
      if (value !== null && typeof value === 'object') throw invalidParams('env values must be strings');
      env[key] = String(value);
    }
    input.env = env;
  }
  if (body.envFile !== undefined) {
    if (body.envFile !== null && typeof body.envFile !== 'string') throw invalidParams('envFile must be a string or null');
    input.envFile = body.envFile as string | null;
  }
  if (body.headers !== undefined) {
    if (!isRecord(body.headers)) throw invalidParams('headers must be an object');
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(body.headers)) {
      if (value !== null && typeof value === 'object') throw invalidParams('header values must be strings');
      headers[key] = String(value);
    }
    input.headers = headers;
  }
  if (body.highPrivilegeTools !== undefined) {
    input.highPrivilegeTools = optionalStringArray(body, 'highPrivilegeTools');
  }
  if (body.approvalRequiredTools !== undefined) {
    input.approvalRequiredTools = optionalStringArray(body, 'approvalRequiredTools');
  }
  return input;
}
