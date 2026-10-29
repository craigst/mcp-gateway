import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCodes } from '../../src/core/errors.js';
import { AuthApi } from '../../src/auth/http.js';
import { SqliteUiAuthService } from '../../src/auth/service.js';
import {
  jsonResponse,
  makeConfig,
  makeDb,
  mockRequest,
  mockResponse,
  setCookieHeader,
  silentLogger,
  TEST_PASSWORD,
  TEST_USERNAME,
  tokenFromSetCookie,
  type MockRequestOptions,
  type MockResponse,
} from './support.js';

let db: DatabaseSync;
let uiAuth: SqliteUiAuthService;
let api: AuthApi;

beforeEach(() => {
  db = makeDb();
  uiAuth = new SqliteUiAuthService(db, makeConfig(), { logger: silentLogger() });
  uiAuth.ensureBootstrapUser();
  api = new AuthApi({ uiAuth, config: makeConfig(), logger: silentLogger() });
});

afterEach(() => {
  db.close();
});

interface CallResult {
  handled: boolean;
  res: MockResponse;
  json: () => any;
}

async function call(
  method: string,
  path: string,
  options: MockRequestOptions = {},
  handler: AuthApi = api,
): Promise<CallResult> {
  const request = mockRequest({ method, headers: options.headers, body: options.body });
  const response = mockResponse();
  const handled = await handler.handle(
    request,
    response.asServerResponse(),
    new URL(`http://localhost:8080${path}`),
  );
  return { handled, res: response, json: () => jsonResponse(response) };
}

async function login(
  username = TEST_USERNAME,
  password = TEST_PASSWORD,
  handler: AuthApi = api,
): Promise<{ result: CallResult; token: string }> {
  const result = await call('POST', '/mcp/v1/auth/login', { body: { username, password } }, handler);
  const token = tokenFromSetCookie(setCookieHeader(result.res));
  if (token === null) throw new Error('login did not set a session cookie');
  return { result, token };
}

describe('AuthApi.login', () => {
  it('returns the user, expiresAt and an HttpOnly session cookie', async () => {
    const { result, token } = await login();

    expect(result.handled).toBe(true);
    expect(result.res.statusCode).toBe(200);
    const body = result.json();
    expect(body).toEqual({ user: { username: TEST_USERNAME }, expiresAt: expect.any(String) });
    expect(Number.isNaN(Date.parse(body.expiresAt))).toBe(false);
    expect(result.res.payload).not.toContain(token);
    expect(result.res.payload).not.toContain('scrypt');
    expect(result.res.payload).not.toContain('password');

    const cookie = setCookieHeader(result.res);
    expect(cookie).toContain(`mcp_session=${token}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=43200');
    expect(cookie).not.toContain('Secure');
    expect(result.res.headers['content-type']).toContain('application/json');
  });

  it('sets Secure when uiCookieSecure is enabled', async () => {
    const secureApi = new AuthApi({
      uiAuth,
      config: makeConfig({ uiCookieSecure: true }),
      logger: silentLogger(),
    });
    const { result } = await login(TEST_USERNAME, TEST_PASSWORD, secureApi);
    expect(setCookieHeader(result.res)).toContain('; Secure');
  });

  it('returns a generic 401 for a wrong password and an unknown user', async () => {
    for (const [username, password] of [
      [TEST_USERNAME, 'wrong-password'],
      ['nobody', TEST_PASSWORD],
    ] as const) {
      const result = await call('POST', '/mcp/v1/auth/login', { body: { username, password } });
      expect(result.res.statusCode).toBe(401);
      expect(result.json()).toEqual({
        error: {
          code: ErrorCodes.KEY_INVALID,
          message: 'Invalid username or password.',
          data: { status: 'UNAUTHORIZED' },
        },
      });
      expect(setCookieHeader(result.res)).toBe('');
    }
  });

  it('returns 400 for malformed bodies', async () => {
    const cases: unknown[] = [{}, { username: TEST_USERNAME }, { password: TEST_PASSWORD }, 'not-json'];
    for (const body of cases) {
      const result = await call('POST', '/mcp/v1/auth/login', { body });
      expect(result.res.statusCode).toBe(400);
      expect(result.json().error.code).toBe(ErrorCodes.INVALID_PARAMS);
    }

    const empty = await call('POST', '/mcp/v1/auth/login');
    expect(empty.res.statusCode).toBe(400);
    expect(empty.json().error.code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it('rejects non-POST methods with 405', async () => {
    const result = await call('GET', '/mcp/v1/auth/login');
    expect(result.handled).toBe(true);
    expect(result.res.statusCode).toBe(405);
    expect(result.json().error.code).toBe(ErrorCodes.METHOD_NOT_FOUND);
  });

  it('accepts a trailing slash on the path', async () => {
    const result = await call('POST', '/mcp/v1/auth/login/', {
      body: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    expect(result.res.statusCode).toBe(200);
  });
});

describe('AuthApi.me', () => {
  it('returns the authenticated user for a live session', async () => {
    const { token } = await login();
    const result = await call('GET', '/mcp/v1/auth/me', {
      headers: { cookie: `mcp_session=${token}` },
    });
    expect(result.res.statusCode).toBe(200);
    expect(result.json()).toEqual({ authenticated: true, user: { username: TEST_USERNAME } });
  });

  it('returns 401 without or with an invalid session', async () => {
    const headerCases: Array<Record<string, string>> = [{}, { cookie: 'mcp_session=bogus' }];
    for (const headers of headerCases) {
      const result = await call('GET', '/mcp/v1/auth/me', { headers });
      expect(result.res.statusCode).toBe(401);
      expect(result.json().error.code).toBe(ErrorCodes.KEY_INVALID);
      expect(result.json().error.message).toBe('Not authenticated.');
    }
  });
});

describe('AuthApi.logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const { token } = await login();
    const result = await call('POST', '/mcp/v1/auth/logout', {
      headers: { cookie: `mcp_session=${token}` },
    });

    expect(result.res.statusCode).toBe(200);
    expect(result.json()).toEqual({ ok: true });
    const cookie = setCookieHeader(result.res);
    expect(cookie).toContain('mcp_session=;');
    expect(cookie).toContain('Max-Age=0');
    expect(uiAuth.authenticate(token)).toBeNull();

    // Idempotent, and safe without a cookie.
    const again = await call('POST', '/mcp/v1/auth/logout', {
      headers: { cookie: `mcp_session=${token}` },
    });
    expect(again.res.statusCode).toBe(200);
    const anonymous = await call('POST', '/mcp/v1/auth/logout');
    expect(anonymous.res.statusCode).toBe(200);
    expect(anonymous.json()).toEqual({ ok: true });
  });
});

describe('AuthApi.password', () => {
  it('requires a session', async () => {
    const result = await call('POST', '/mcp/v1/auth/password', {
      body: { currentPassword: TEST_PASSWORD, newPassword: 'new-secret-password' },
    });
    expect(result.res.statusCode).toBe(401);
    expect(result.json().error.code).toBe(ErrorCodes.KEY_INVALID);
  });

  it('returns 400 for a wrong current password and keeps the session alive', async () => {
    const { token } = await login();
    const result = await call('POST', '/mcp/v1/auth/password', {
      headers: { cookie: `mcp_session=${token}` },
      body: { currentPassword: 'wrong-current', newPassword: 'new-secret-password' },
    });
    expect(result.res.statusCode).toBe(400);
    expect(result.json().error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(result.json().error.message).toContain('Current password is incorrect.');

    const me = await call('GET', '/mcp/v1/auth/me', {
      headers: { cookie: `mcp_session=${token}` },
    });
    expect(me.res.statusCode).toBe(200);
  });

  it('returns 400 for a too-short new password', async () => {
    const { token } = await login();
    const result = await call('POST', '/mcp/v1/auth/password', {
      headers: { cookie: `mcp_session=${token}` },
      body: { currentPassword: TEST_PASSWORD, newPassword: 'short' },
    });
    expect(result.res.statusCode).toBe(400);
    expect(result.json().error.code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it('returns 400 for malformed bodies', async () => {
    const { token } = await login();
    const result = await call('POST', '/mcp/v1/auth/password', {
      headers: { cookie: `mcp_session=${token}` },
      body: { currentPassword: TEST_PASSWORD },
    });
    expect(result.res.statusCode).toBe(400);
    expect(result.json().error.code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it('rotates the password, revokes sessions and clears the cookie', async () => {
    const { token } = await login();
    const result = await call('POST', '/mcp/v1/auth/password', {
      headers: { cookie: `mcp_session=${token}` },
      body: { currentPassword: TEST_PASSWORD, newPassword: 'new-secret-password' },
    });

    expect(result.res.statusCode).toBe(200);
    expect(result.json()).toEqual({ ok: true });
    expect(setCookieHeader(result.res)).toContain('Max-Age=0');
    expect(uiAuth.authenticate(token)).toBeNull();

    const oldLogin = await call('POST', '/mcp/v1/auth/login', {
      body: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    expect(oldLogin.res.statusCode).toBe(401);

    const newLogin = await call('POST', '/mcp/v1/auth/login', {
      body: { username: TEST_USERNAME, password: 'new-secret-password' },
    });
    expect(newLogin.res.statusCode).toBe(200);
  });
});

describe('AuthApi routing', () => {
  it('returns false for non-auth paths', async () => {
    for (const path of ['/mcp/v1/tools', '/mcp/v1/authx', '/health', '/']) {
      const result = await call('GET', path);
      expect(result.handled).toBe(false);
      expect(result.res.payload).toBe('');
    }
  });

  it('handles unknown auth sub-paths with 404', async () => {
    for (const path of ['/mcp/v1/auth', '/mcp/v1/auth/', '/mcp/v1/auth/unknown']) {
      const result = await call('GET', path);
      expect(result.handled).toBe(true);
      expect(result.res.statusCode).toBe(404);
    }
  });
});
