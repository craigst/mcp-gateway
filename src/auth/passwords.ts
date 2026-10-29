/**
 * Password hashing for the built-in Web UI login.
 *
 * Passwords are stored as scrypt derivations with a per-hash random salt:
 *
 *   scrypt$<N>$<r>$<p>$<saltBase64>$<derivedKeyBase64>
 *
 * scrypt is memory-hard, so a leaked `ui_users` table is expensive to attack
 * offline. Verification is constant-time via `timingSafeEqual`, and parsing of
 * stored hashes is deliberately defensive (a malformed row fails closed).
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { invalidParams } from '../core/errors.js';

export const SCRYPT_N = 16_384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEY_LENGTH = 64;
export const SCRYPT_SALT_BYTES = 16;
export const MIN_PASSWORD_LENGTH = 8;
export const HASH_SCHEME = 'scrypt';

/** scrypt needs ~128 * N * r bytes; give it headroom and cap hostile parameters. */
const MAX_SCRYPT_MEMORY_BYTES = 128 * 1024 * 1024;
const MAX_N = 262_144;
const MAX_R = 32;
const MAX_P = 16;

function assertAcceptablePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw invalidParams(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  }
}

/** Hash a plaintext password into the self-describing scrypt format. */
export function hashPassword(password: string): string {
  assertAcceptablePassword(password);
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derivedKey = scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_SCRYPT_MEMORY_BYTES,
  });
  return [
    HASH_SCHEME,
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64'),
    derivedKey.toString('base64'),
  ].join('$');
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  expected: Buffer;
}

function parseStoredHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6) return null;
  const [scheme, rawN, rawR, rawP, rawSalt, rawKey] = parts;
  if (scheme !== HASH_SCHEME) return null;
  if (!rawN || !rawR || !rawP || !rawSalt || !rawKey) return null;

  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(n) || n < 1_024 || n > MAX_N) return null;
  if (!Number.isInteger(r) || r < 1 || r > MAX_R) return null;
  if (!Number.isInteger(p) || p < 1 || p > MAX_P) return null;
  if (128 * n * r > MAX_SCRYPT_MEMORY_BYTES) return null;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(rawSalt, 'base64');
    expected = Buffer.from(rawKey, 'base64');
  } catch {
    return null;
  }
  if (salt.length === 0 || expected.length === 0) return null;
  return { n, r, p, salt, expected };
}

/**
 * Verify a plaintext password against a stored hash.
 *
 * Never throws: malformed stored hashes, non-string inputs and wrong lengths all
 * return `false`. The derivation is still computed for wrong-length hashes where
 * possible so callers can keep authentication timing uniform.
 */
export function verifyPassword(password: string, stored: string): boolean {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;

  let actual: Buffer;
  try {
    actual = scryptSync(password, parsed.salt, parsed.expected.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_SCRYPT_MEMORY_BYTES,
    });
  } catch {
    return false;
  }
  if (actual.length !== parsed.expected.length) return false;
  return timingSafeEqual(actual, parsed.expected);
}
