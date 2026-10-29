/**
 * Admin REST surface for gateway settings (v0.6).
 *
 *   GET /mcp/v1/admin/settings -> { settings: GatewaySettingsInfo, account: {...} }
 *
 * Read-only. Master keys and Web UI sessions may read it; non-master API keys are
 * refused. Note this deliberately reports *configuration metadata* only — never
 * secret values, vault contents or tokens.
 */
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

import type { GatewayConfig } from '../core/config.js';
import {
  ErrorCodes,
  GatewayError,
  accessDenied,
  invalidKey,
} from '../core/errors.js';
import { nowIso } from '../core/ids.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { KeyService, UiAuthService } from '../core/ports.js';
import type { AuthenticatedKey, GatewaySettingsInfo } from '../core/types.js';
import type { AdminSubRouter } from './types.js';

const AREA = 'settings';
/** VaultSecretService rejects master secrets shorter than this. */
const MIN_VAULT_SECRET_LENGTH = 16;

export interface SettingsApiDeps {
  config: GatewayConfig;
  keys: KeyService;
  db: DatabaseSync;
  auth: UiAuthService;
  logger?: Logger;
  /** Resolves Bearer API key or Web UI session cookie. */
  authenticate?: (req: IncomingMessage) => AuthenticatedKey;
}

export interface SettingsAccountInfo {
  /** Session username for a logged-in browser, otherwise the literal 'api-key'. */
  username: string;
  sessionCount: number;
}

export interface SettingsResponse {
  settings: GatewaySettingsInfo;
  account: SettingsAccountInfo;
}

export class SettingsApi implements AdminSubRouter {
  private readonly logger: Logger;

  constructor(private readonly deps: SettingsApiDeps) {
    this.logger = deps.logger ?? createLogger('admin.settings');
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const segments = url.pathname.replace(/^\/mcp\/v1\/admin\/?/, '').split('/').filter(Boolean);
    if (segments[0] !== AREA) return false;
    const rest = segments.slice(1);
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      const principal = this.requireMaster(req);

      if (rest.length > 0) {
        throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Unknown settings endpoint', {
          httpStatus: 404,
        });
      }
      if (method !== 'GET') {
        this.sendJson(res, 405, {
          error: {
            code: ErrorCodes.METHOD_NOT_FOUND,
            message: 'Method Not Allowed. Expected GET.',
            data: { status: 'METHOD_NOT_ALLOWED' },
          },
        });
        return true;
      }

      this.sendJson(res, 200, this.snapshot(principal));
      return true;
    } catch (error) {
      const gatewayError =
        error instanceof GatewayError
          ? error
          : new GatewayError(ErrorCodes.INTERNAL_ERROR, String(error), { httpStatus: 500 });
      this.logger.debug('settings request failed', {
        path: url.pathname,
        code: gatewayError.code,
        message: gatewayError.message,
      });
      this.sendJson(res, gatewayError.httpStatus, { error: gatewayError.toJSONRpcError() });
      return true;
    }
  }

  /** Build the settings/account payload for one authenticated principal. */
  private snapshot(principal: AuthenticatedKey): SettingsResponse {
    const userCount = this.countUsers();
    const sessionCount = this.countSessions();
    const firstUser = this.firstUsername();
    const configuredUsername =
      typeof this.deps.config.uiUsername === 'string' && this.deps.config.uiUsername.trim() !== ''
        ? this.deps.config.uiUsername.trim()
        : null;

    const settings: GatewaySettingsInfo = {
      version: gatewayVersion(),
      host: this.deps.config.host,
      port: this.deps.config.port,
      dataDir: this.deps.config.dataDir,
      dbPath: this.deps.config.dbPath,
      reposDir: this.deps.config.reposDir,
      uiDistDir: this.deps.config.uiDistDir,
      vaultEnabled:
        this.deps.config.vaultSecret !== null &&
        this.deps.config.vaultSecret.length >= MIN_VAULT_SECRET_LENGTH,
      gitImportEnabled: this.deps.config.gitImportAllowedPrefixes.length > 0,
      gitImportAllowedPrefixes: [...this.deps.config.gitImportAllowedPrefixes],
      delegationMaxDepth: this.deps.config.delegationMaxDepth,
      autostart: typeof this.deps.config.autostart === 'string' ? this.deps.config.autostart : '',
      logLevel: this.deps.config.logLevel,
      uiUsername: firstUser ?? configuredUsername,
      userCount,
      sessionCount,
      setupRequired: userCount === 0,
    };

    return {
      settings,
      account: {
        username: principalIsSession(principal) ? principal.name : 'api-key',
        sessionCount,
      },
    };
  }

  private countUsers(): number {
    const row = this.deps.db
      .prepare('SELECT COUNT(*) AS count FROM ui_users')
      .get() as unknown as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private countSessions(): number {
    const row = this.deps.db
      .prepare(
        `SELECT COUNT(*) AS count FROM ui_sessions
          WHERE revoked_at IS NULL AND expires_at > ?`,
      )
      .get(nowIso()) as unknown as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private firstUsername(): string | null {
    const row = this.deps.db
      .prepare('SELECT username FROM ui_users ORDER BY created_at ASC, rowid ASC LIMIT 1')
      .get() as unknown as { username?: unknown } | undefined;
    return typeof row?.username === 'string' ? row.username : null;
  }

  private requireMaster(req: IncomingMessage): AuthenticatedKey {
    const injected = this.deps.authenticate;
    if (injected) {
      return requireMasterKey(injected(req));
    }

    const header = req.headers.authorization;
    let plaintext: string | null = null;
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
      plaintext = header.slice(7).trim();
    }
    const apiKey = req.headers['x-mcp-api-key'];
    if (!plaintext && typeof apiKey === 'string') plaintext = apiKey.trim();
    if (!plaintext) throw invalidKey('MISSING_KEY');

    return requireMasterKey(this.deps.keys.authenticate(plaintext));
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

function principalIsSession(key: AuthenticatedKey): boolean {
  const via = key.metadata?.['via'];
  return via === 'session' || key.id.startsWith('ui:');
}

function requireMasterKey(key: AuthenticatedKey): AuthenticatedKey {
  if (key.keyType !== 'master') {
    throw accessDenied('Access Denied: master privileges are required to read gateway settings.', {
      reason: 'SCOPE_RESTRICTION',
    });
  }
  return key;
}

let cachedVersion: string | null = null;

/**
 * The gateway version as published in package.json. Resolved once per process:
 * cwd first (Docker /app and the repo root in dev), then module-relative locations
 * for compiled layouts that keep package.json beside the source tree.
 */
function gatewayVersion(): string {
  if (cachedVersion !== null) return cachedVersion;

  const candidates: string[] = [];
  try {
    candidates.push(join(process.cwd(), 'package.json'));
  } catch {
    /* ignore */
  }
  for (const relative of ['../../package.json', '../../../package.json']) {
    try {
      candidates.push(fileURLToPath(new URL(relative, import.meta.url)));
    } catch {
      /* ignore */
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version !== '') {
        cachedVersion = parsed.version;
        return cachedVersion;
      }
    } catch {
      // Try the next candidate.
    }
  }
  cachedVersion = '0.0.0';
  return cachedVersion;
}
