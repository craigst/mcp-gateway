/**
 * Admin REST surface for v0.6 encrypted backups.
 *
 * Mounted by `AdminApi` for the `backups` area. All routes require a master API
 * key or a Web UI session (the injected authenticator). Creating or restoring a
 * backup additionally verifies the operator's LOGIN PASSWORD (the session
 * principal contributes its username; Bearer/master clients must pass
 * `username` in the body), because the password derives the backup key.
 *
 * Responses never contain decrypted state: backups are handed out only as the
 * encrypted `.mcpbak` envelope.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { GatewayConfig } from '../core/config.js';
import { ErrorCodes, GatewayError, accessDenied, invalidKey, invalidParams } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type { Logger } from '../core/logger.js';
import type { BackupService, KeyService, UiAuthService } from '../core/ports.js';
import type { AuthenticatedKey, BackupEnvelope } from '../core/types.js';
import { readJsonBody } from '../gateway/server.js';
import type { AdminSubRouter } from './types.js';

const SESSION_PRINCIPAL_PREFIX = 'ui:';
const DOWNLOAD_CONTENT_TYPE = 'application/json; charset=utf-8';

export interface BackupApiDeps {
  config: GatewayConfig;
  keys: KeyService;
  auth: UiAuthService;
  backup: BackupService;
  /** Resolves Bearer API key or Web UI session cookie. */
  authenticate?: (req: IncomingMessage) => AuthenticatedKey;
  logger?: Logger;
}

export class BackupApi implements AdminSubRouter {
  private readonly logger: Logger;

  constructor(private readonly deps: BackupApiDeps) {
    this.logger = deps.logger ?? createLogger('admin.backup');
  }

  /** Returns true when the URL matched a backup route (including errors). */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const segments = url.pathname.replace(/^\/mcp\/v1\/admin\/?/, '').split('/').filter(Boolean);
    if (segments[0] !== 'backups') return false;
    const rest = segments.slice(1);
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      // --- Collection ------------------------------------------------------
      if (rest.length === 0) {
        const principal = this.requireMaster(req);
        if (method === 'GET') {
          this.sendJson(res, 200, { backups: this.deps.backup.list() });
          return true;
        }
        if (method === 'POST') {
          const body = await this.readObjectBody(req);
          const password = requirePassword(body);
          const username = this.resolveOperatorUsername(principal, body);
          this.verifyOperatorPassword(username, password);
          const includeAudit = optionalBoolean(body, 'includeAudit');
          const metadata = this.deps.backup.create({
            password,
            ...(includeAudit === undefined ? {} : { includeAudit }),
          });
          this.logger.info('backup created via API', {
            backupId: metadata.id,
            principalId: principal.id,
            includeAudit: metadata.includeAudit,
          });
          this.sendJson(res, 201, metadata);
          return true;
        }
        return false;
      }

      // --- Restore ---------------------------------------------------------
      if (rest.length === 1 && rest[0] === 'restore') {
        if (method !== 'POST') return false;
        const principal = this.requireMaster(req);
        const body = await this.readObjectBody(req);
        const password = requirePassword(body);
        const username = this.resolveOperatorUsername(principal, body);
        this.verifyOperatorPassword(username, password);
        const envelope = parseEnvelope(body.backup);
        const confirm = body.confirm;
        if (typeof confirm !== 'string') {
          throw invalidParams('"confirm" must be the string "RESTORE"');
        }
        const result = this.deps.backup.restore({ envelope, password, confirm });
        this.logger.info('backup restored via API', {
          principalId: principal.id,
          servers: result.serversRestored,
          reinstallRequired: result.reinstallRequired.length,
        });
        this.sendJson(res, 200, { result });
        return true;
      }

      // --- Download --------------------------------------------------------
      if (rest.length === 2 && rest[1] === 'download') {
        if (method !== 'GET') return false;
        this.requireMaster(req);
        const { metadata, envelope } = this.deps.backup.read(rest[0] as string);
        const body = JSON.stringify(envelope);
        const fileName = metadata.fileName.length > 0 ? metadata.fileName : `${metadata.id}.mcpbak`;
        res.writeHead(200, {
          'content-type': DOWNLOAD_CONTENT_TYPE,
          'content-length': Buffer.byteLength(body, 'utf8'),
          'content-disposition': `attachment; filename="${fileName.replace(/"/g, '')}"`,
          'cache-control': 'no-store',
        });
        res.end(body);
        return true;
      }

      // --- Delete ----------------------------------------------------------
      if (rest.length === 1) {
        if (method !== 'DELETE') return false;
        this.requireMaster(req);
        this.deps.backup.remove(rest[0] as string);
        this.sendJson(res, 200, { deleted: true });
        return true;
      }

      return false;
    } catch (error) {
      const gatewayError =
        error instanceof GatewayError
          ? error
          : new GatewayError(ErrorCodes.INTERNAL_ERROR, String(error), { httpStatus: 500 });
      this.logger.debug('backup request failed', {
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
        throw accessDenied('Access Denied: master privileges are required for backup management.', {
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
      throw accessDenied('Access Denied: a master key is required for backup management.', {
        reason: 'SCOPE_RESTRICTION',
      });
    }
    return key;
  }

  /** Session principals supply their own username; API clients must pass one. */
  private resolveOperatorUsername(
    principal: AuthenticatedKey,
    body: Record<string, unknown>,
  ): string {
    if (principal.id.startsWith(SESSION_PRINCIPAL_PREFIX)) {
      const username = principal.id.slice(SESSION_PRINCIPAL_PREFIX.length).trim();
      if (username.length === 0) {
        throw invalidParams('Unable to resolve the session username for backup verification');
      }
      return username;
    }
    const username = body.username;
    if (typeof username !== 'string' || username.trim().length === 0) {
      throw invalidParams(
        '"username" is required when creating or restoring a backup with an API key',
      );
    }
    return username.trim();
  }

  private verifyOperatorPassword(username: string, password: string): void {
    let valid: boolean;
    try {
      valid = this.deps.auth.verifyUserPassword(username, password);
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new GatewayError(ErrorCodes.KEY_INVALID, 'Unauthorized: invalid username or password.', {
        httpStatus: 401,
        data: { status: 'UNAUTHORIZED', reason: 'INVALID_CREDENTIALS' },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

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

function requirePassword(body: Record<string, unknown>): string {
  const password = body.password;
  if (typeof password !== 'string' || password.length === 0) {
    throw invalidParams('"password" is required');
  }
  return password;
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw invalidParams(`"${field}" must be a boolean`);
  return value;
}

/** Accepts an envelope object or a base64-encoded JSON envelope string. */
function parseEnvelope(value: unknown): BackupEnvelope {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as unknown;
    } catch {
      throw invalidParams('"backup" is not a valid base64-encoded backup envelope');
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidParams('"backup" must be a backup envelope object or a base64 string');
  }
  return parsed as unknown as BackupEnvelope;
}
