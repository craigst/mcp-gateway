/**
 * Public auth surface: password hashing, session service, cookie helpers,
 * request authentication, and the `/mcp/v1/auth` HTTP handler.
 */
export {
  hashPassword,
  verifyPassword,
  HASH_SCHEME,
  MIN_PASSWORD_LENGTH,
  SCRYPT_KEY_LENGTH,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  SCRYPT_SALT_BYTES,
} from './passwords.js';
export {
  clearSessionCookie,
  DEFAULT_SESSION_TTL_MS,
  parseCookieHeader,
  readSessionToken,
  SESSION_COOKIE_NAME,
  serializeSessionCookie,
  sessionMaxAgeSeconds,
  sessionTtlMs,
} from './cookies.js';
export { SqliteUiAuthService, type UiAuthServiceOptions } from './service.js';
export { authenticateRequest, isSessionRequest, sessionPrincipal } from './request-auth.js';
export { AuthApi, AUTH_PATH_PREFIX, type AuthApiDependencies } from './http.js';
