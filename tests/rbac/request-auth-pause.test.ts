import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/core/db.js';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import { createLogger } from '../../src/core/logger.js';
import type { UiAuthService } from '../../src/core/ports.js';
import { authenticateRequest, isSessionRequest } from '../../src/auth/request-auth.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';

let db: DatabaseSync;
let keys: SqliteKeyService;

const silent = createLogger('test', 'silent');

/** Minimal session backing for the Web UI cookie path. */
const uiAuth = {
  hasUsers: () => true,
  authenticate: (token: string | null | undefined) =>
    token === 'valid-session-token' ? { username: 'operator' } : null,
} as unknown as UiAuthService;

beforeEach(() => {
  db = openDatabase(':memory:');
  keys = new SqliteKeyService(db, { logger: silent });
});

afterEach(() => {
  db.close();
});

function request(headers: Record<string, string>) {
  return { method: 'POST', headers } as unknown as Parameters<typeof authenticateRequest>[0];
}

function pausedError(fn: () => unknown): GatewayError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }
  throw new Error('Expected a GatewayError');
}

describe('authenticateRequest + paused API keys', () => {
  it('rejects a paused Bearer key with KEY_PAUSED and a clear message', () => {
    const issued = keys.issue({ name: 'agent', keyType: 'agent' });
    keys.pause(issued.key.id);

    const error = pausedError(() =>
      authenticateRequest(request({ authorization: `Bearer ${issued.plaintext}` }), keys, uiAuth),
    );
    expect(error.code).toBe(ErrorCodes.ACCESS_DENIED);
    expect(error.httpStatus).toBe(403);
    expect(error.message).toBe('This API key is paused. Resume it in the console.');
    expect(error.data).toEqual({ status: 'ACCESS_DENIED', reason: 'KEY_PAUSED' });
  });

  it('rejects a paused key presented through X-MCP-API-Key', () => {
    const issued = keys.issue({ name: 'agent', keyType: 'agent' });
    keys.pause(issued.key.id);

    const error = pausedError(() =>
      authenticateRequest(request({ 'x-mcp-api-key': issued.plaintext }), keys, uiAuth),
    );
    expect(error.data?.reason).toBe('KEY_PAUSED');
  });

  it('accepts the key again after resume', () => {
    const issued = keys.issue({ name: 'agent', keyType: 'agent' });
    keys.pause(issued.key.id);
    expect(
      pausedError(() =>
        authenticateRequest(request({ authorization: `Bearer ${issued.plaintext}` }), keys, uiAuth),
      ).data?.reason,
    ).toBe('KEY_PAUSED');

    keys.resume(issued.key.id);
    const principal = authenticateRequest(
      request({ authorization: `Bearer ${issued.plaintext}` }),
      keys,
      uiAuth,
    );
    expect(principal.id).toBe(issued.key.id);
    expect(principal.pausedAt).toBeNull();
  });

  it('does not affect Web UI session principals', () => {
    const sessionHeaders = { cookie: 'mcp_session=valid-session-token' };
    expect(isSessionRequest(request(sessionHeaders))).toBe(true);
    const principal = authenticateRequest(request(sessionHeaders), keys, uiAuth);
    expect(principal.id).toBe('ui:operator');
    expect(principal.pausedAt).toBeNull();
    expect(principal.metadata).toEqual({ via: 'session' });
  });
});
