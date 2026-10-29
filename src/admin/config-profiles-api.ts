/**
 * Admin REST surface for v0.4 configuration profiles (`docs/API-V2.md` §8).
 *
 * Mounted by `AdminApi` for the `config-profiles` area, so paths here are relative
 * to `/mcp/v1/admin/config-profiles`. Master-only. Responses contain metadata and
 * vault references only — never a configuration value.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { GatewayConfig } from '../core/config.js';
import {
  ErrorCodes,
  GatewayError,
  accessDenied,
  invalidKey,
  invalidParams,
} from '../core/errors.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { ConfigProfileService, KeyService } from '../core/ports.js';
import type {
  AuthenticatedKey,
  ConfigProfileInput,
  ConfigProfileInputValue,
} from '../core/types.js';
import { readJsonBody } from '../gateway/server.js';
import type { AdminSubRouter } from './types.js';

const AREA = 'config-profiles';

export interface ConfigProfilesApiDeps {
  config: GatewayConfig;
  keys: KeyService;
  configProfiles: ConfigProfileService;
  logger?: Logger;
  /** Resolves Bearer API key or Web UI session cookie. */
  authenticate?: (req: IncomingMessage) => AuthenticatedKey;
}

export class ConfigProfilesApi implements AdminSubRouter {
  private readonly logger: Logger;

  constructor(private readonly deps: ConfigProfilesApiDeps) {
    this.logger = deps.logger ?? createLogger('admin.config-profiles');
  }

  /** Returns true when the URL matched a config-profile route (including errors). */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const segments = url.pathname.replace(/^\/mcp\/v1\/admin\/?/, '').split('/').filter(Boolean);
    if (segments[0] !== AREA) return false;
    const rest = segments.slice(1);
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      // --- Legacy env-file migration --------------------------------------
      if (rest.length === 1 && rest[0] === 'migrate-env-file') {
        this.requireMaster(req);
        if (method !== 'POST') return this.methodNotAllowed(res, 'POST');
        const body = await this.readBody(req);
        const serverId = requireString(body, 'serverId');
        const name = optionalString(body, 'name');
        const profile = await this.deps.configProfiles.migrateEnvFile(serverId, name ?? undefined);
        this.sendJson(res, 201, { profile });
        return true;
      }

      // --- Collection ------------------------------------------------------
      if (rest.length === 0) {
        this.requireMaster(req);
        if (method === 'GET') {
          this.sendJson(res, 200, { profiles: this.deps.configProfiles.list() });
          return true;
        }
        if (method === 'POST') {
          const body = await this.readBody(req);
          const profile = await this.deps.configProfiles.create(parseProfileInput(body));
          this.sendJson(res, 201, { profile });
          return true;
        }
        return this.methodNotAllowed(res, 'GET, POST');
      }

      const profileId = rest[0] as string;

      // --- Single profile --------------------------------------------------
      if (rest.length === 1) {
        if (method === 'GET') {
          this.requireMaster(req);
          const profile = this.deps.configProfiles.get(profileId);
          if (!profile) throw this.notFound(profileId);
          this.sendJson(res, 200, { profile });
          return true;
        }
        if (method === 'PUT') {
          this.requireMaster(req);
          const body = await this.readBody(req);
          const profile = await this.deps.configProfiles.update(profileId, parseProfileInput(body));
          this.sendJson(res, 200, { profile });
          return true;
        }
        if (method === 'DELETE') {
          this.requireMaster(req);
          this.deps.configProfiles.remove(profileId);
          this.logger.info('configuration profile deleted via API', { profileId });
          this.sendJson(res, 200, { deleted: true });
          return true;
        }
        return this.methodNotAllowed(res, 'GET, PUT, DELETE');
      }

      // --- Apply to servers -------------------------------------------------
      if (rest.length === 2 && rest[1] === 'apply') {
        this.requireMaster(req);
        if (method !== 'POST') return this.methodNotAllowed(res, 'POST');
        const body = await this.readBody(req);
        const serverIds = body.serverIds;
        if (!Array.isArray(serverIds) || serverIds.length === 0) {
          throw invalidParams('"serverIds" must be a non-empty array of server ids');
        }
        for (const value of serverIds) {
          if (typeof value !== 'string' || value.trim() === '') {
            throw invalidParams('"serverIds" must contain non-empty strings');
          }
        }
        const restart = optionalBoolean(body, 'restart');
        const test = optionalBoolean(body, 'test');
        const results = await this.deps.configProfiles.apply(
          [profileId],
          serverIds.map((value) => String(value).trim()),
          { ...(restart === undefined ? {} : { restart }), ...(test === undefined ? {} : { test }) },
        );
        this.sendJson(res, 200, { results });
        return true;
      }

      // --- Detach one server ------------------------------------------------
      if (rest.length === 3 && rest[1] === 'servers') {
        this.requireMaster(req);
        if (method !== 'DELETE') return this.methodNotAllowed(res, 'DELETE');
        this.deps.configProfiles.detach(profileId, rest[2] as string);
        this.sendJson(res, 200, { detached: true });
        return true;
      }

      throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Unknown config-profiles endpoint', {
        httpStatus: 404,
      });
    } catch (error) {
      const gatewayError =
        error instanceof GatewayError
          ? error
          : new GatewayError(ErrorCodes.INTERNAL_ERROR, String(error), { httpStatus: 500 });
      this.logger.debug('config-profiles request failed', {
        path: url.pathname,
        code: gatewayError.code,
        message: gatewayError.message,
      });
      this.sendJson(res, gatewayError.httpStatus, { error: gatewayError.toJSONRpcError() });
      return true;
    }
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
          'Access Denied: master privileges are required for configuration profile management.',
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
      throw accessDenied(
        'Access Denied: a master key is required for configuration profile management.',
        { reason: 'SCOPE_RESTRICTION' },
      );
    }
    return key;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private notFound(profileId: string): GatewayError {
    return new GatewayError(
      ErrorCodes.TOOL_NOT_FOUND,
      `Configuration profile '${profileId}' was not found`,
      { httpStatus: 404 },
    );
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const parsed = await readJsonBody(req, this.deps.config.requestBodyLimitBytes);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw invalidParams('JSON object body required');
    }
    return parsed as Record<string, unknown>;
  }

  private methodNotAllowed(res: ServerResponse, expected: string): boolean {
    this.sendJson(res, 405, {
      error: {
        code: ErrorCodes.METHOD_NOT_FOUND,
        message: `Method Not Allowed. Expected ${expected}.`,
        data: { status: 'METHOD_NOT_ALLOWED' },
      },
    });
    return true;
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    if (res.headersSent) return;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidParams(`"${field}" is required and must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidParams(`"${field}" must be a string`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalidParams(`"${field}" must be a boolean`);
  return value;
}

function parseInputValues(raw: unknown, field: 'entries' | 'headers'): ConfigProfileInputValue[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalidParams(`"${field}" must be an array`);
  return raw.map((item, index) => {
    if (!isRecord(item)) throw invalidParams(`"${field}[${index}]" must be an object`);
    const key = item.key;
    if (typeof key !== 'string' || key.trim() === '') {
      throw invalidParams(`"${field}[${index}].key" is required and must be a non-empty string`);
    }
    const hasValue = Object.prototype.hasOwnProperty.call(item, 'value');
    const hasSecretRef = Object.prototype.hasOwnProperty.call(item, 'secretRef');
    if (hasValue && hasSecretRef) {
      throw invalidParams(`"${field}[${index}]" must use either "value" or "secretRef", not both`);
    }
    if (!hasValue && !hasSecretRef) {
      // Update-only "keep current value" rows: the service validates that the
      // key already exists (create rejects key-only rows).
      return { key: key.trim() };
    }
    if (hasValue) {
      if (typeof item.value !== 'string') {
        throw invalidParams(`"${field}[${index}].value" must be a string`);
      }
      return { key: key.trim(), value: item.value };
    }
    if (typeof item.secretRef !== 'string' || item.secretRef.trim() === '') {
      throw invalidParams(`"${field}[${index}].secretRef" must be a non-empty string`);
    }
    return { key: key.trim(), secretRef: item.secretRef.trim() };
  });
}

/** Structural parse; semantic validation (name rules, keys, refs) lives in the service. */
function parseProfileInput(body: Record<string, unknown>): ConfigProfileInput {
  const name = body.name;
  if (typeof name !== 'string' || name.trim() === '') {
    throw invalidParams('"name" is required and must be a non-empty string');
  }
  const input: ConfigProfileInput = { name: name.trim() };
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      throw invalidParams('"description" must be a string or null');
    }
    input.description = body.description;
  }
  input.entries = parseInputValues(body.entries, 'entries');
  input.headers = parseInputValues(body.headers, 'headers');
  return input;
}
