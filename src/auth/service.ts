/**
 * SQLite-backed built-in Web UI authentication.
 *
 * The console uses a username/password session (HttpOnly cookie); API keys remain
 * the credential for AI agents and external management clients. Sessions are stored
 * only as SHA-256 hashes of the raw token, so a database leak does not yield live
 * session cookies.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GatewayConfig } from '../core/config.js';
import { invalidKey, invalidParams } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { UiAuthService, UiSession, UiUser } from '../core/ports.js';
import { sessionTtlMs } from './cookies.js';
import { hashPassword, verifyPassword } from './passwords.js';

export interface UiAuthServiceOptions {
  logger?: Logger;
}

/** Unknown-user logins verify a dummy hash to keep timing uniform (no user enumeration). */
const DUMMY_PASSWORD = 'timing-equaliser-placeholder-value';

/** Extend a session's expiry on activity at most once per this window. */
const SLIDING_WINDOW_MS = 5 * 60 * 1000;

const GENERATED_PASSWORD_BYTES = 18; // -> 24 base64url characters

interface UiUserRow {
  username: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

interface UiSessionRow {
  id: string;
  token_hash: string;
  username: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  revoked_at: string | null;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function generatedPassword(): string {
  return randomBytes(GENERATED_PASSWORD_BYTES).toString('base64url');
}

export class SqliteUiAuthService implements UiAuthService {
  private readonly db: DatabaseSync;
  private readonly config: GatewayConfig;
  private readonly logger: Logger;
  private readonly ttlMs: number;
  private dummyHash: string | null = null;

  constructor(db: DatabaseSync, config: GatewayConfig, options: UiAuthServiceOptions = {}) {
    this.db = db;
    this.config = config;
    this.logger = options.logger ?? createLogger('auth');
    this.ttlMs = sessionTtlMs(config);
  }

  private getUser(username: string): UiUserRow | null {
    const row = this.db
      .prepare('SELECT * FROM ui_users WHERE username = ?')
      .get(username) as unknown as UiUserRow | undefined;
    return row ?? null;
  }

  private tokenHash(token: string): string {
    return sha256Hex(token);
  }

  private timingEqualiserHash(): string {
    this.dummyHash ??= hashPassword(DUMMY_PASSWORD);
    return this.dummyHash;
  }

  private purgeExpiredSessions(now: Date = new Date()): void {
    this.db.prepare('DELETE FROM ui_sessions WHERE expires_at <= ?').run(now.toISOString());
  }

  ensureBootstrapUser(): void {
    const countRow = this.db
      .prepare('SELECT COUNT(*) AS count FROM ui_users')
      .get() as unknown as { count?: number } | undefined;
    if (Number(countRow?.count ?? 0) > 0) return;

    const configuredUsername = this.config.uiUsername;
    const username =
      typeof configuredUsername === 'string' && configuredUsername.trim() !== ''
        ? configuredUsername.trim()
        : 'admin';
    const configuredPassword =
      typeof this.config.uiPassword === 'string' && this.config.uiPassword !== ''
        ? this.config.uiPassword
        : null;
    const isGenerated = configuredPassword === null;
    const password = configuredPassword ?? generatedPassword();
    // Throws invalidParams for an explicitly configured password shorter than the minimum.
    const passwordHash = hashPassword(password);
    const timestamp = nowIso();

    this.db
      .prepare(
        `INSERT INTO ui_users (username, password_hash, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(username, passwordHash, timestamp, timestamp);

    this.logger.info('Web UI bootstrap user created', { username });
    if (isGenerated) {
      // Shown exactly once: this is the only moment the plaintext exists.
      this.logger.warn('generated Web UI password — shown once', { username, password });
    }
  }

  login(username: string, password: string): UiSession {
    const normalizedUsername = typeof username === 'string' ? username.trim() : '';
    const candidate = typeof password === 'string' ? password : '';
    const user = normalizedUsername === '' ? null : this.getUser(normalizedUsername);

    // Always run a scrypt derivation so unknown users and wrong passwords cost the same.
    const storedHash = user?.password_hash ?? this.timingEqualiserHash();
    const passwordMatches = verifyPassword(candidate, storedHash);
    if (user === null || candidate === '' || !passwordMatches) {
      this.logger.warn('Web UI login failed', { username: normalizedUsername });
      throw invalidKey('INVALID_CREDENTIALS');
    }

    this.purgeExpiredSessions();

    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    const token = randomBytes(32).toString('base64url');

    this.db
      .prepare(
        `INSERT INTO ui_sessions
           (id, token_hash, username, created_at, expires_at, last_seen_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(newId('sess'), this.tokenHash(token), user.username, createdAt, expiresAt, createdAt);
    this.db
      .prepare('UPDATE ui_users SET last_login_at = ? WHERE username = ?')
      .run(createdAt, user.username);

    this.logger.info('Web UI login succeeded', { username: user.username });
    return { token, user: { username: user.username }, expiresAt };
  }

  authenticate(token: string | null | undefined): UiUser | null {
    if (typeof token !== 'string' || token === '') return null;
    const row = this.db
      .prepare('SELECT * FROM ui_sessions WHERE token_hash = ?')
      .get(this.tokenHash(token)) as unknown as UiSessionRow | undefined;
    if (!row) return null;
    if (row.revoked_at !== null && row.revoked_at !== undefined) return null;

    const nowMs = Date.now();
    const expiresMs = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
      // Opportunistically remove the stale row; it can never authenticate again.
      this.db.prepare('DELETE FROM ui_sessions WHERE id = ?').run(row.id);
      return null;
    }

    const user = this.getUser(row.username);
    if (!user) return null;

    // Sliding expiry: activity older than the window extends the session lifetime.
    const lastSeenMs = Date.parse(row.last_seen_at);
    if (!Number.isFinite(lastSeenMs) || nowMs - lastSeenMs >= SLIDING_WINDOW_MS) {
      const extendedExpiry = new Date(nowMs + this.ttlMs).toISOString();
      this.db
        .prepare(
          'UPDATE ui_sessions SET expires_at = ?, last_seen_at = ? WHERE id = ? AND revoked_at IS NULL',
        )
        .run(extendedExpiry, new Date(nowMs).toISOString(), row.id);
    }

    return { username: user.username };
  }

  logout(token: string | null | undefined): void {
    if (typeof token !== 'string' || token === '') return;
    const revokedAt = nowIso();
    // Idempotent: re-logging-out or logging out an unknown token is a no-op.
    this.db
      .prepare(
        'UPDATE ui_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
      )
      .run(revokedAt, this.tokenHash(token));
  }

  changePassword(username: string, currentPassword: string, newPassword: string): void {
    const normalizedUsername = typeof username === 'string' ? username.trim() : '';
    const user = normalizedUsername === '' ? null : this.getUser(normalizedUsername);
    if (!user) throw invalidParams('Current password is incorrect.');

    const current = typeof currentPassword === 'string' ? currentPassword : '';
    if (current === '' || !verifyPassword(current, user.password_hash)) {
      throw invalidParams('Current password is incorrect.');
    }

    // Validates the minimum length (throws invalidParams) before touching the DB.
    const passwordHash = hashPassword(newPassword);
    const timestamp = nowIso();
    this.db
      .prepare('UPDATE ui_users SET password_hash = ?, updated_at = ? WHERE username = ?')
      .run(passwordHash, timestamp, user.username);
    // Revoke every session for this user: the caller must log in again with the new
    // password (this includes the session that requested the change).
    this.db
      .prepare('UPDATE ui_sessions SET revoked_at = ? WHERE username = ? AND revoked_at IS NULL')
      .run(timestamp, user.username);

    this.logger.info('Web UI password changed; all sessions revoked', {
      username: user.username,
    });
  }

  activeSessions(username: string): number {
    const normalizedUsername = typeof username === 'string' ? username.trim() : '';
    if (normalizedUsername === '') return 0;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM ui_sessions
          WHERE username = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(normalizedUsername, nowIso()) as unknown as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }
}
