import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GatewayConfig } from '../../src/core/config.js';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import { verifyPassword } from '../../src/auth/passwords.js';
import { SqliteUiAuthService } from '../../src/auth/service.js';
import {
  captureLogger,
  makeConfig,
  makeDb,
  silentLogger,
  TEST_PASSWORD,
  TEST_TTL_MS,
  TEST_USERNAME,
} from './support.js';

interface UserRowShape {
  username: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

interface SessionRowShape {
  id: string;
  token_hash: string;
  username: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  revoked_at: string | null;
}

let db: DatabaseSync;
let config: GatewayConfig;
let auth: SqliteUiAuthService;

beforeEach(() => {
  db = makeDb();
  config = makeConfig();
  auth = new SqliteUiAuthService(db, config, { logger: silentLogger() });
  auth.ensureBootstrapUser();
});

afterEach(() => {
  db.close();
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function userRows(database: DatabaseSync = db): UserRowShape[] {
  return database.prepare('SELECT * FROM ui_users').all() as unknown as UserRowShape[];
}

function sessionRows(database: DatabaseSync = db): SessionRowShape[] {
  return database.prepare('SELECT * FROM ui_sessions').all() as unknown as SessionRowShape[];
}

function sessionRowByHash(tokenHash: string, database: DatabaseSync = db): SessionRowShape | null {
  const row = database
    .prepare('SELECT * FROM ui_sessions WHERE token_hash = ?')
    .get(tokenHash) as unknown as SessionRowShape | undefined;
  return row ?? null;
}

function gatewayError(fn: () => unknown): GatewayError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }
  throw new Error('Expected the function to throw a GatewayError.');
}

describe('SqliteUiAuthService.ensureBootstrapUser', () => {
  it('creates the configured user with a scrypt password hash', () => {
    const users = userRows();
    expect(users).toHaveLength(1);
    expect(users[0]?.username).toBe(TEST_USERNAME);
    expect(users[0]?.password_hash.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(users[0]?.password_hash).not.toContain(TEST_PASSWORD);
    expect(verifyPassword(TEST_PASSWORD, users[0]?.password_hash ?? '')).toBe(true);
    expect(users[0]?.last_login_at).toBeNull();
  });

  it('is idempotent and never overwrites an existing user', () => {
    const before = userRows()[0];
    auth.ensureBootstrapUser();
    auth.ensureBootstrapUser();
    const after = userRows();

    expect(after).toHaveLength(1);
    expect(after[0]?.password_hash).toBe(before?.password_hash);
    expect(after[0]?.created_at).toBe(before?.created_at);
  });

  it('leaves an existing user untouched when the config changes', () => {
    const otherDb = makeDb();
    try {
      const firstConfig = makeConfig();
      const first = new SqliteUiAuthService(otherDb, firstConfig, { logger: silentLogger() });
      first.ensureBootstrapUser();
      const originalHash = userRows(otherDb)[0]?.password_hash;

      const second = new SqliteUiAuthService(
        otherDb,
        makeConfig({ uiUsername: 'other-admin', uiPassword: 'another-secret-123' }),
        { logger: silentLogger() },
      );
      second.ensureBootstrapUser();

      const users = userRows(otherDb);
      expect(users).toHaveLength(1);
      expect(users[0]?.username).toBe(TEST_USERNAME);
      expect(users[0]?.password_hash).toBe(originalHash);
      expect(first.login(TEST_USERNAME, TEST_PASSWORD).user.username).toBe(TEST_USERNAME);
      expect(gatewayError(() => second.login('other-admin', 'another-secret-123')).code).toBe(
        ErrorCodes.KEY_INVALID,
      );
    } finally {
      otherDb.close();
    }
  });

  it('generates a 24-character password and logs it once at warn level', () => {
    const freshDb = makeDb();
    try {
      const capture = captureLogger();
      const service = new SqliteUiAuthService(
        freshDb,
        makeConfig({ uiPassword: null }),
        { logger: capture.logger },
      );
      service.ensureBootstrapUser();

      const warnings = capture.records.filter(
        (record) =>
          record.level === 'warn' && record.message.includes('generated Web UI password'),
      );
      expect(warnings).toHaveLength(1);
      const generated = warnings[0]?.context?.password;
      expect(typeof generated).toBe('string');
      expect(String(generated)).toHaveLength(24);
      expect(warnings[0]?.context?.username).toBe(TEST_USERNAME);

      const infos = capture.records.filter(
        (record) => record.level === 'info' && record.context?.username === TEST_USERNAME,
      );
      expect(infos.length).toBeGreaterThanOrEqual(1);

      const stored = userRows(freshDb)[0]?.password_hash ?? '';
      expect(verifyPassword(String(generated), stored)).toBe(true);
      expect(service.login(TEST_USERNAME, String(generated)).user.username).toBe(TEST_USERNAME);
    } finally {
      freshDb.close();
    }
  });

  it('honours a custom username and explicit password', () => {
    const freshDb = makeDb();
    try {
      const service = new SqliteUiAuthService(
        freshDb,
        makeConfig({ uiUsername: 'craig', uiPassword: 'another-long-secret' }),
        { logger: silentLogger() },
      );
      service.ensureBootstrapUser();
      expect(userRows(freshDb)[0]?.username).toBe('craig');
      expect(service.login('craig', 'another-long-secret').user.username).toBe('craig');
    } finally {
      freshDb.close();
    }
  });

  it('rejects an explicitly configured password below the minimum length', () => {
    const freshDb = makeDb();
    try {
      const service = new SqliteUiAuthService(
        freshDb,
        makeConfig({ uiPassword: 'short' }),
        { logger: silentLogger() },
      );
      const error = gatewayError(() => service.ensureBootstrapUser());
      expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
      expect(userRows(freshDb)).toHaveLength(0);
    } finally {
      freshDb.close();
    }
  });
});

describe('SqliteUiAuthService.login', () => {
  it('creates a session, hashes the token and records last_login_at', () => {
    const session = auth.login(TEST_USERNAME, TEST_PASSWORD);

    expect(session.user).toEqual({ username: TEST_USERNAME });
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(session.expiresAt) - Date.now()).toBeGreaterThan(TEST_TTL_MS - 10_000);
    expect(Date.parse(session.expiresAt) - Date.now()).toBeLessThanOrEqual(TEST_TTL_MS);

    const rows = sessionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.username).toBe(TEST_USERNAME);
    expect(rows[0]?.token_hash).toBe(sha256(session.token));
    expect(rows[0]?.token_hash).not.toBe(session.token);
    expect(rows[0]?.revoked_at).toBeNull();
    expect(rows[0]?.expires_at).toBe(session.expiresAt);
    expect(rows[0]?.last_seen_at).toBe(rows[0]?.created_at);
    expect(JSON.stringify(rows[0])).not.toContain(session.token);

    expect(userRows()[0]?.last_login_at).not.toBeNull();
  });

  it('uses the configured TTL for expiresAt and the stored row', () => {
    const shortLived = new SqliteUiAuthService(
      db,
      makeConfig({ uiSessionTtlMs: 60_000 }),
      { logger: silentLogger() },
    );
    const session = shortLived.login(TEST_USERNAME, TEST_PASSWORD);
    const row = sessionRowByHash(sha256(session.token));
    expect(row?.expires_at).toBe(session.expiresAt);
    const delta = Date.parse(session.expiresAt) - Date.now();
    expect(delta).toBeGreaterThan(55_000);
    expect(delta).toBeLessThanOrEqual(60_000);
  });

  it('issues a distinct token for every login', () => {
    const first = auth.login(TEST_USERNAME, TEST_PASSWORD);
    const second = auth.login(TEST_USERNAME, TEST_PASSWORD);
    expect(first.token).not.toBe(second.token);
    expect(sessionRows()).toHaveLength(2);
  });

  it('rejects a wrong password and an unknown user with the same generic error', () => {
    const wrongPassword = gatewayError(() => auth.login(TEST_USERNAME, 'wrong-password'));
    const unknownUser = gatewayError(() => auth.login('nobody', TEST_PASSWORD));

    expect(wrongPassword.code).toBe(ErrorCodes.KEY_INVALID);
    expect(unknownUser.code).toBe(ErrorCodes.KEY_INVALID);
    expect(wrongPassword.message).toBe(unknownUser.message);
    expect(wrongPassword.data?.reason).toBe('INVALID_CREDENTIALS');
    expect(unknownUser.data?.reason).toBe('INVALID_CREDENTIALS');
    expect(sessionRows()).toHaveLength(0);
  });

  it('rejects empty credentials generically', () => {
    expect(gatewayError(() => auth.login('', '')).code).toBe(ErrorCodes.KEY_INVALID);
    expect(gatewayError(() => auth.login(TEST_USERNAME, '')).code).toBe(ErrorCodes.KEY_INVALID);
    expect(gatewayError(() => auth.login('', TEST_PASSWORD)).code).toBe(ErrorCodes.KEY_INVALID);
  });

  it('opportunistically purges expired sessions on login', () => {
    db.prepare(
      `INSERT INTO ui_sessions (id, token_hash, username, created_at, expires_at, last_seen_at, revoked_at)
       VALUES ('sess_expired', ?, ?, ?, ?, ?, NULL)`,
    ).run(
      sha256('expired-token'),
      TEST_USERNAME,
      new Date(Date.now() - 7_200_000).toISOString(),
      new Date(Date.now() - 3_600_000).toISOString(),
      new Date(Date.now() - 7_200_000).toISOString(),
    );
    expect(sessionRows()).toHaveLength(1);

    auth.login(TEST_USERNAME, TEST_PASSWORD);
    const rows = sessionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe('sess_expired');
  });
});

describe('SqliteUiAuthService.authenticate', () => {
  it('resolves a live session token to its user', () => {
    const session = auth.login(TEST_USERNAME, TEST_PASSWORD);
    expect(auth.authenticate(session.token)).toEqual({ username: TEST_USERNAME });
  });

  it('returns null for missing, empty and unknown tokens', () => {
    expect(auth.authenticate(null)).toBeNull();
    expect(auth.authenticate(undefined)).toBeNull();
    expect(auth.authenticate('')).toBeNull();
    expect(auth.authenticate('not-a-real-token')).toBeNull();
  });

  it('returns null for revoked sessions and keeps the audit row', () => {
    const session = auth.login(TEST_USERNAME, TEST_PASSWORD);
    auth.logout(session.token);
    expect(auth.authenticate(session.token)).toBeNull();

    const row = sessionRowByHash(sha256(session.token));
    expect(row).not.toBeNull();
    expect(row?.revoked_at).not.toBeNull();
  });

  it('returns null and purges expired sessions', () => {
    const session = auth.login(TEST_USERNAME, TEST_PASSWORD);
    db.prepare('UPDATE ui_sessions SET expires_at = ? WHERE token_hash = ?').run(
      new Date(Date.now() - 1_000).toISOString(),
      sha256(session.token),
    );

    expect(auth.authenticate(session.token)).toBeNull();
    expect(sessionRowByHash(sha256(session.token))).toBeNull();
  });

  it('returns null when the user no longer exists', () => {
    const session = auth.login(TEST_USERNAME, TEST_PASSWORD);
    db.prepare('DELETE FROM ui_users WHERE username = ?').run(TEST_USERNAME);
    expect(auth.authenticate(session.token)).toBeNull();
  });

  it('extends expiry on activity after the sliding window', () => {
    const shortLived = new SqliteUiAuthService(
      db,
      makeConfig({ uiSessionTtlMs: 60_000 }),
      { logger: silentLogger() },
    );
    const session = shortLived.login(TEST_USERNAME, TEST_PASSWORD);
    const tokenHash = sha256(session.token);
    const oldLastSeen = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.prepare('UPDATE ui_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(
      oldLastSeen,
      new Date(Date.now() + 30_000).toISOString(),
      tokenHash,
    );

    expect(shortLived.authenticate(session.token)).toEqual({ username: TEST_USERNAME });
    const extendedRow = sessionRowByHash(tokenHash);
    expect(Date.parse(extendedRow?.expires_at ?? '')).toBeGreaterThan(Date.now() + 50_000);
    expect(Date.parse(extendedRow?.last_seen_at ?? '')).toBeGreaterThan(Date.parse(oldLastSeen));

    // A second immediate request is inside the window and must not write again.
    const extendedExpiry = extendedRow?.expires_at;
    expect(shortLived.authenticate(session.token)).toEqual({ username: TEST_USERNAME });
    expect(sessionRowByHash(tokenHash)?.expires_at).toBe(extendedExpiry);
  });

  it('does not extend a session whose last activity is recent', () => {
    const session = auth.login(TEST_USERNAME, TEST_PASSWORD);
    const before = sessionRowByHash(sha256(session.token))?.expires_at;
    expect(auth.authenticate(session.token)).toEqual({ username: TEST_USERNAME });
    expect(sessionRowByHash(sha256(session.token))?.expires_at).toBe(before);
  });
});

describe('SqliteUiAuthService.logout', () => {
  it('revokes only the presented token', () => {
    const first = auth.login(TEST_USERNAME, TEST_PASSWORD);
    const second = auth.login(TEST_USERNAME, TEST_PASSWORD);
    auth.logout(first.token);

    expect(auth.authenticate(first.token)).toBeNull();
    expect(auth.authenticate(second.token)).toEqual({ username: TEST_USERNAME });
  });

  it('is idempotent and safe for unknown or empty tokens', () => {
    const session = auth.login(TEST_USERNAME, TEST_PASSWORD);
    expect(() => auth.logout(session.token)).not.toThrow();
    expect(() => auth.logout(session.token)).not.toThrow();
    expect(() => auth.logout('unknown')).not.toThrow();
    expect(() => auth.logout(null)).not.toThrow();
    expect(() => auth.logout(undefined)).not.toThrow();
    expect(auth.authenticate(session.token)).toBeNull();
  });
});

describe('SqliteUiAuthService.changePassword', () => {
  it('rejects a wrong current password without changing anything', () => {
    const session = auth.login(TEST_USERNAME, TEST_PASSWORD);
    const error = gatewayError(() =>
      auth.changePassword(TEST_USERNAME, 'wrong-current', 'new-secret-password'),
    );
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(auth.login(TEST_USERNAME, TEST_PASSWORD).user.username).toBe(TEST_USERNAME);
    expect(auth.authenticate(session.token)).toEqual({ username: TEST_USERNAME });
  });

  it('rejects a new password shorter than the minimum', () => {
    const error = gatewayError(() => auth.changePassword(TEST_USERNAME, TEST_PASSWORD, 'short'));
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(error.message).toContain(String(8));
    expect(auth.login(TEST_USERNAME, TEST_PASSWORD).user.username).toBe(TEST_USERNAME);
  });

  it('rejects an unknown user', () => {
    const error = gatewayError(() =>
      auth.changePassword('nobody', TEST_PASSWORD, 'new-secret-password'),
    );
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it('rotates the password, revokes all sessions and requires a fresh login', () => {
    const first = auth.login(TEST_USERNAME, TEST_PASSWORD);
    const second = auth.login(TEST_USERNAME, TEST_PASSWORD);
    expect(auth.activeSessions(TEST_USERNAME)).toBe(2);

    auth.changePassword(TEST_USERNAME, TEST_PASSWORD, 'new-secret-password');

    expect(auth.activeSessions(TEST_USERNAME)).toBe(0);
    expect(auth.authenticate(first.token)).toBeNull();
    expect(auth.authenticate(second.token)).toBeNull();
    expect(gatewayError(() => auth.login(TEST_USERNAME, TEST_PASSWORD)).code).toBe(
      ErrorCodes.KEY_INVALID,
    );
    expect(auth.login(TEST_USERNAME, 'new-secret-password').user.username).toBe(TEST_USERNAME);
    expect(userRows()[0]?.updated_at).not.toBe(userRows()[0]?.created_at);
  });
});

describe('SqliteUiAuthService.activeSessions', () => {
  it('counts live sessions only', () => {
    expect(auth.activeSessions(TEST_USERNAME)).toBe(0);
    const first = auth.login(TEST_USERNAME, TEST_PASSWORD);
    const second = auth.login(TEST_USERNAME, TEST_PASSWORD);
    expect(auth.activeSessions(TEST_USERNAME)).toBe(2);

    auth.logout(first.token);
    expect(auth.activeSessions(TEST_USERNAME)).toBe(1);

    db.prepare('UPDATE ui_sessions SET expires_at = ? WHERE token_hash = ?').run(
      new Date(Date.now() - 1).toISOString(),
      sha256(second.token),
    );
    expect(auth.activeSessions(TEST_USERNAME)).toBe(0);
    expect(auth.activeSessions('nobody')).toBe(0);
    expect(auth.activeSessions('')).toBe(0);
  });
});
