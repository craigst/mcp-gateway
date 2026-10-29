/**
 * Request authentication for the gateway ingress.
 *
 * Two credential types are accepted, API key first:
 *   1. `Authorization: Bearer <key>` or `X-MCP-API-Key: <key>` -> KeyService (agents).
 *   2. `mcp_session` HttpOnly cookie -> built-in Web UI session (humans).
 *
 * Cookie-authenticated principals are represented as a synthetic master key so the
 * existing RBAC/policy layer and admin routes work unchanged. Because cookies ride
 * along automatically, unsafe methods additionally require the request to be
 * same-origin when the browser supplies an `Origin` header (CSRF defence).
 */
import type { IncomingMessage } from 'node:http';
import { accessDenied, invalidKey } from '../core/errors.js';
import { nowIso } from '../core/ids.js';
import type { KeyService, UiAuthService } from '../core/ports.js';
import type { AuthenticatedKey } from '../core/types.js';
import { readSessionToken } from './cookies.js';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const BEARER_PATTERN = /^Bearer\s+(.+)$/i;
const API_KEY_HEADER = 'x-mcp-api-key';

function headerValue(header: string | string[] | undefined): string | null {
  if (Array.isArray(header)) return header.length > 0 ? (header[0] ?? null) : null;
  return typeof header === 'string' ? header : null;
}

function hasApiKeyCredentials(req: IncomingMessage): boolean {
  const authorization = headerValue(req.headers.authorization);
  if (authorization !== null && authorization.trim() !== '') return true;
  const apiKey = headerValue(req.headers[API_KEY_HEADER]);
  return apiKey !== null && apiKey.trim() !== '';
}

/** True when the request would authenticate via the session cookie (API keys win). */
export function isSessionRequest(req: IncomingMessage): boolean {
  if (hasApiKeyCredentials(req)) return false;
  return readSessionToken(headerValue(req.headers.cookie)) !== null;
}

/** Synthetic principal for a logged-in browser: master key scoped to the session user. */
export function sessionPrincipal(username: string): AuthenticatedKey {
  return {
    id: `ui:${username}`,
    name: username,
    keyType: 'master',
    keyPrefix: 'ui',
    serverGrants: [],
    delegationAllowed: true,
    escalationAllowed: true,
    expiresAt: null,
    revokedAt: null,
    createdAt: nowIso(),
    lastUsedAt: null,
    metadata: { via: 'session' },
  };
}

function enforceSameOrigin(req: IncomingMessage): void {
  const method = (req.method ?? 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return;

  const origin = headerValue(req.headers.origin);
  // Non-browser clients do not send Origin; only browsers can ride a cookie silently.
  if (origin === null || origin.trim() === '') return;

  const expectedHost = headerValue(req.headers.host);

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw accessDenied('Cross-origin session request rejected.', {
      reason: 'CROSS_ORIGIN_SESSION_REQUEST',
    });
  }

  if (expectedHost === null || originHost.toLowerCase() !== expectedHost.toLowerCase()) {
    throw accessDenied('Cross-origin session request rejected.', {
      reason: 'CROSS_ORIGIN_SESSION_REQUEST',
    });
  }
}

/**
 * Resolve the caller from an API key header or the session cookie.
 * Throws `GatewayError(-32005)` when no usable credential is present.
 */
export function authenticateRequest(
  req: IncomingMessage,
  keys: KeyService,
  uiAuth: UiAuthService,
): AuthenticatedKey {
  const authorization = headerValue(req.headers.authorization);
  if (authorization !== null && authorization.trim() !== '') {
    const match = BEARER_PATTERN.exec(authorization.trim());
    const token = match?.[1]?.trim() ?? '';
    if (token === '') throw invalidKey();
    return keys.authenticate(token);
  }

  const apiKeyHeader = headerValue(req.headers[API_KEY_HEADER]);
  if (apiKeyHeader !== null && apiKeyHeader.trim() !== '') {
    return keys.authenticate(apiKeyHeader.trim());
  }

  const sessionToken = readSessionToken(headerValue(req.headers.cookie));
  if (sessionToken !== null) {
    const user = uiAuth.authenticate(sessionToken);
    if (user !== null) {
      enforceSameOrigin(req);
      return sessionPrincipal(user.username);
    }
  }

  throw invalidKey();
}
