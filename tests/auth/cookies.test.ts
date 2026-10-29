import { describe, expect, it } from 'vitest';
import {
  clearSessionCookie,
  DEFAULT_SESSION_TTL_MS,
  parseCookieHeader,
  readSessionToken,
  SESSION_COOKIE_NAME,
  serializeSessionCookie,
  sessionMaxAgeSeconds,
  sessionTtlMs,
} from '../../src/auth/cookies.js';
import { makeConfig } from './support.js';

describe('parseCookieHeader', () => {
  it('parses a single and multiple cookies, trimming whitespace', () => {
    expect(parseCookieHeader('mcp_session=abc')).toEqual({ mcp_session: 'abc' });
    expect(parseCookieHeader(' a=1 ; b=2;c=3 ')).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('handles values containing equals signs and quoted values', () => {
    expect(parseCookieHeader('token=a=b=c')).toEqual({ token: 'a=b=c' });
    expect(parseCookieHeader('quoted="hello world"')).toEqual({ quoted: 'hello world' });
  });

  it('decodes percent-encoded values and tolerates broken escapes', () => {
    expect(parseCookieHeader('name=hello%20world')).toEqual({ name: 'hello world' });
    expect(parseCookieHeader('bad=%E0%A4%A')).toEqual({ bad: '%E0%A4%A' });
  });

  it('skips malformed pairs and returns {} for empty input', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader(null)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
    expect(parseCookieHeader('novalue; =x; =; a=1')).toEqual({ a: '1' });
  });
});

describe('readSessionToken', () => {
  it('extracts the session token or returns null', () => {
    expect(readSessionToken('mcp_session=abc123; other=1')).toBe('abc123');
    expect(readSessionToken('other=1')).toBeNull();
    expect(readSessionToken('mcp_session=')).toBeNull();
    expect(readSessionToken(undefined)).toBeNull();
  });

  it('uses the documented cookie name', () => {
    expect(SESSION_COOKIE_NAME).toBe('mcp_session');
  });
});

describe('session TTL helpers', () => {
  it('defaults to 12 hours when unset or invalid', () => {
    expect(sessionTtlMs(makeConfig({ uiSessionTtlMs: undefined }))).toBe(DEFAULT_SESSION_TTL_MS);
    expect(DEFAULT_SESSION_TTL_MS).toBe(12 * 60 * 60 * 1000);
    expect(sessionTtlMs(makeConfig({ uiSessionTtlMs: 0 }))).toBe(DEFAULT_SESSION_TTL_MS);
    expect(sessionTtlMs(makeConfig({ uiSessionTtlMs: -5 }))).toBe(DEFAULT_SESSION_TTL_MS);
    expect(sessionTtlMs(makeConfig({ uiSessionTtlMs: Number.NaN }))).toBe(DEFAULT_SESSION_TTL_MS);
  });

  it('converts a custom TTL to a positive Max-Age', () => {
    expect(sessionMaxAgeSeconds(makeConfig({ uiSessionTtlMs: 90_000 }))).toBe(90);
    expect(sessionMaxAgeSeconds(makeConfig({ uiSessionTtlMs: 500 }))).toBe(1);
    expect(sessionMaxAgeSeconds(makeConfig({ uiSessionTtlMs: 12 * 60 * 60 * 1000 }))).toBe(43_200);
  });
});

describe('serializeSessionCookie', () => {
  it('sets HttpOnly, SameSite=Strict, Path and Max-Age', () => {
    expect(serializeSessionCookie('token-value', makeConfig())).toBe(
      'mcp_session=token-value; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200',
    );
  });

  it('adds Secure when uiCookieSecure is enabled', () => {
    const cookie = serializeSessionCookie('t', makeConfig({ uiCookieSecure: true }));
    expect(cookie).toContain('; Secure');
    expect(cookie.endsWith('Secure')).toBe(true);
  });

  it('never adds Secure when uiCookieSecure is false', () => {
    expect(serializeSessionCookie('t', makeConfig({ uiCookieSecure: false }))).not.toContain(
      'Secure',
    );
  });

  it('uses the configured TTL for Max-Age', () => {
    const cookie = serializeSessionCookie('t', makeConfig({ uiSessionTtlMs: 60_000 }));
    expect(cookie).toContain('Max-Age=60');
  });
});

describe('clearSessionCookie', () => {
  it('expires the cookie immediately', () => {
    const cookie = clearSessionCookie(makeConfig());
    expect(cookie.startsWith('mcp_session=;')).toBe(true);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Secure');
  });

  it('keeps the Secure flag when configured', () => {
    expect(clearSessionCookie(makeConfig({ uiCookieSecure: true }))).toContain('; Secure');
  });
});
