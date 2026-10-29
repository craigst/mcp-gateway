import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import type { AuthenticatedKey } from '../../src/core/types.js';
import { authenticateRequest, isSessionRequest, sessionPrincipal } from '../../src/auth/request-auth.js';
import { SqliteUiAuthService } from '../../src/auth/service.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';
import { makeConfig, makeDb, mockRequest, silentLogger, TEST_PASSWORD, TEST_USERNAME } from './support.js';

let db: DatabaseSync;
let keys: SqliteKeyService;
let uiAuth: SqliteUiAuthService;

beforeEach(() => {
  db = makeDb();
  keys = new SqliteKeyService(db, { logger: silentLogger() });
  uiAuth = new SqliteUiAuthService(db, makeConfig(), { logger: silentLogger() });
  uiAuth.ensureBootstrapUser();
});

afterEach(() => {
  db.close();
});

function login(): { token: string; cookie: string } {
  const session = uiAuth.login(TEST_USERNAME, TEST_PASSWORD);
  return { token: session.token, cookie: `mcp_session=${session.token}` };
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

describe('authenticateRequest with API keys', () => {
  it('authenticates a Bearer API key', () => {
    const issued = keys.issue({ name: 'agent', keyType: 'agent' });
    const principal: AuthenticatedKey = authenticateRequest(
      mockRequest({ headers: { authorization: `Bearer ${issued.plaintext}` } }),
      keys,
      uiAuth,
    );
    expect(principal.id).toBe(issued.key.id);
    expect(principal.keyType).toBe('agent');
    expect(principal.plaintext).toBe(issued.plaintext);
  });

  it('authenticates an X-MCP-API-Key header', () => {
    const issued = keys.issue({ name: 'agent', keyType: 'agent' });
    const principal = authenticateRequest(
      mockRequest({ headers: { 'x-mcp-api-key': issued.plaintext } }),
      keys,
      uiAuth,
    );
    expect(principal.id).toBe(issued.key.id);
  });

  it('rejects invalid or malformed API keys', () => {
    expect(
      gatewayError(() =>
        authenticateRequest(mockRequest({ headers: { authorization: 'Bearer bogus' } }), keys, uiAuth),
      ).code,
    ).toBe(ErrorCodes.KEY_INVALID);
    expect(
      gatewayError(() =>
        authenticateRequest(mockRequest({ headers: { authorization: 'Bearer' } }), keys, uiAuth),
      ).code,
    ).toBe(ErrorCodes.KEY_INVALID);
    expect(
      gatewayError(() =>
        authenticateRequest(
          mockRequest({ headers: { 'x-mcp-api-key': 'mcp_ag_bogus' } }),
          keys,
          uiAuth,
        ),
      ).code,
    ).toBe(ErrorCodes.KEY_INVALID);
  });

  it('prefers a valid API key over a session cookie', () => {
    const issued = keys.issue({ name: 'agent', keyType: 'agent' });
    const { cookie } = login();
    const principal = authenticateRequest(
      mockRequest({ headers: { authorization: `Bearer ${issued.plaintext}`, cookie } }),
      keys,
      uiAuth,
    );
    expect(principal.id).toBe(issued.key.id);
    expect(principal.metadata.via).toBeUndefined();
  });

  it('does not fall back to the cookie when the API key is invalid', () => {
    const { cookie } = login();
    expect(
      gatewayError(() =>
        authenticateRequest(
          mockRequest({ headers: { authorization: 'Bearer invalid-key', cookie } }),
          keys,
          uiAuth,
        ),
      ).code,
    ).toBe(ErrorCodes.KEY_INVALID);
  });
});

describe('authenticateRequest with a session cookie', () => {
  it('returns a synthetic master principal for a live session', () => {
    const { token } = login();
    const principal = authenticateRequest(
      mockRequest({ headers: { cookie: `mcp_session=${token}` } }),
      keys,
      uiAuth,
    );

    expect(principal).toMatchObject({
      id: `ui:${TEST_USERNAME}`,
      name: TEST_USERNAME,
      keyType: 'master',
      keyPrefix: 'ui',
      serverGrants: [],
      delegationAllowed: true,
      escalationAllowed: true,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      metadata: { via: 'session' },
    });
    expect(Number.isNaN(Date.parse(principal.createdAt))).toBe(false);
    expect('keyHash' in (principal as unknown as Record<string, unknown>)).toBe(false);
    expect('plaintext' in (principal as unknown as Record<string, unknown>)).toBe(false);
  });

  it('rejects missing, unknown and revoked sessions', () => {
    expect(gatewayError(() => authenticateRequest(mockRequest(), keys, uiAuth)).code).toBe(
      ErrorCodes.KEY_INVALID,
    );
    expect(
      gatewayError(() =>
        authenticateRequest(mockRequest({ headers: { cookie: 'mcp_session=bogus' } }), keys, uiAuth),
      ).code,
    ).toBe(ErrorCodes.KEY_INVALID);

    const { token } = login();
    uiAuth.logout(token);
    expect(
      gatewayError(() =>
        authenticateRequest(mockRequest({ headers: { cookie: `mcp_session=${token}` } }), keys, uiAuth),
      ).code,
    ).toBe(ErrorCodes.KEY_INVALID);
  });

  it('accepts same-origin unsafe requests', () => {
    const { token } = login();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const principal = authenticateRequest(
        mockRequest({
          method,
          headers: {
            cookie: `mcp_session=${token}`,
            host: 'localhost:8080',
            origin: 'http://localhost:8080',
          },
        }),
        keys,
        uiAuth,
      );
      expect(principal.id).toBe(`ui:${TEST_USERNAME}`);
    }
  });

  it('rejects cross-origin cookie-authenticated writes', () => {
    const { token } = login();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const error = gatewayError(() =>
        authenticateRequest(
          mockRequest({
            method,
            headers: {
              cookie: `mcp_session=${token}`,
              host: 'localhost:8080',
              origin: 'https://evil.example',
            },
          }),
          keys,
          uiAuth,
        ),
      );
      expect(error.code).toBe(ErrorCodes.ACCESS_DENIED);
      expect(error.data?.reason).toBe('CROSS_ORIGIN_SESSION_REQUEST');
    }
  });

  it('allows cross-origin safe reads (GET/HEAD/OPTIONS) and same-origin-less writes', () => {
    const { token } = login();
    expect(
      authenticateRequest(
        mockRequest({
          method: 'GET',
          headers: { cookie: `mcp_session=${token}`, host: 'localhost:8080', origin: 'https://evil.example' },
        }),
        keys,
        uiAuth,
      ).id,
    ).toBe(`ui:${TEST_USERNAME}`);

    expect(
      authenticateRequest(
        mockRequest({ method: 'POST', headers: { cookie: `mcp_session=${token}` } }),
        keys,
        uiAuth,
      ).id,
    ).toBe(`ui:${TEST_USERNAME}`);
  });

  it('rejects a malformed Origin on unsafe requests', () => {
    const { token } = login();
    const error = gatewayError(() =>
      authenticateRequest(
        mockRequest({
          method: 'POST',
          headers: { cookie: `mcp_session=${token}`, host: 'localhost:8080', origin: 'null' },
        }),
        keys,
        uiAuth,
      ),
    );
    expect(error.code).toBe(ErrorCodes.ACCESS_DENIED);
    expect(error.data?.reason).toBe('CROSS_ORIGIN_SESSION_REQUEST');
  });
});

describe('isSessionRequest', () => {
  it('is true when only a session cookie is present', () => {
    const { token } = login();
    expect(isSessionRequest(mockRequest({ headers: { cookie: `mcp_session=${token}` } }))).toBe(true);
  });

  it('is false without a cookie or when API key credentials are present', () => {
    const issued = keys.issue({ name: 'agent', keyType: 'agent' });
    const { token } = login();
    expect(isSessionRequest(mockRequest())).toBe(false);
    expect(
      isSessionRequest(mockRequest({ headers: { authorization: `Bearer ${issued.plaintext}` } })),
    ).toBe(false);
    expect(
      isSessionRequest(mockRequest({ headers: { 'x-mcp-api-key': issued.plaintext } })),
    ).toBe(false);
    expect(
      isSessionRequest(
        mockRequest({
          headers: { authorization: `Bearer ${issued.plaintext}`, cookie: `mcp_session=${token}` },
        }),
      ),
    ).toBe(false);
  });
});

describe('sessionPrincipal', () => {
  it('builds the documented synthetic master principal', () => {
    const principal = sessionPrincipal('alice');
    expect(principal.id).toBe('ui:alice');
    expect(principal.name).toBe('alice');
    expect(principal.keyType).toBe('master');
    expect(principal.keyPrefix).toBe('ui');
    expect(principal.metadata).toEqual({ via: 'session' });
    expect(principal.delegationAllowed).toBe(true);
    expect(principal.escalationAllowed).toBe(true);
  });
});
