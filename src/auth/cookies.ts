/**
 * Session cookie helpers for the built-in Web UI login.
 *
 * The session token lives in an HttpOnly, SameSite=Strict cookie so browser
 * JavaScript can never read it; the API never returns it in a JSON body.
 */
import type { GatewayConfig } from '../core/config.js';

export const SESSION_COOKIE_NAME = 'mcp_session';

export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Effective session lifetime in milliseconds (config value, else 12h). */
export function sessionTtlMs(config: Pick<GatewayConfig, 'uiSessionTtlMs'>): number {
  const configured = config.uiSessionTtlMs;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.max(1_000, Math.floor(configured));
  }
  return DEFAULT_SESSION_TTL_MS;
}

/** `Max-Age` seconds for the session cookie (never 0 for a live session). */
export function sessionMaxAgeSeconds(config: Pick<GatewayConfig, 'uiSessionTtlMs'>): number {
  return Math.max(1, Math.floor(sessionTtlMs(config) / 1000));
}

/**
 * Parse a `Cookie` request header into a name -> value map.
 *
 * Defensive by design: malformed pairs are skipped, quoted values are unwrapped,
 * and percent-encoding is undone when valid.
 */
export function parseCookieHeader(header: string | undefined | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (typeof header !== 'string' || header === '') return cookies;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (name === '') continue;
    let value = part.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      value = decodeURIComponent(value);
    } catch {
      // Keep the raw value; a broken escape sequence must not fail auth parsing.
    }
    cookies[name] = value;
  }
  return cookies;
}

/** Extract the raw session token from a `Cookie` header, or null. */
export function readSessionToken(cookieHeader: string | undefined | null): string | null {
  const cookies = parseCookieHeader(cookieHeader);
  const token = cookies[SESSION_COOKIE_NAME];
  return typeof token === 'string' && token !== '' ? token : null;
}

/** `Set-Cookie` value that establishes a session. */
export function serializeSessionCookie(
  token: string,
  config: Pick<GatewayConfig, 'uiSessionTtlMs' | 'uiCookieSecure'>,
): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${sessionMaxAgeSeconds(config)}`,
  ];
  if (config.uiCookieSecure === true) attributes.push('Secure');
  return attributes.join('; ');
}

/** `Set-Cookie` value that drops the session cookie. */
export function clearSessionCookie(
  config: Pick<GatewayConfig, 'uiCookieSecure'>,
): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ];
  if (config.uiCookieSecure === true) attributes.push('Secure');
  return attributes.join('; ');
}
