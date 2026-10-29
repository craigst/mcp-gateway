import { scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import {
  hashPassword,
  MIN_PASSWORD_LENGTH,
  SCRYPT_KEY_LENGTH,
  SCRYPT_SALT_BYTES,
  verifyPassword,
} from '../../src/auth/passwords.js';

const PASSWORD = 'correct-horse-battery-staple';

function gatewayError(fn: () => unknown): GatewayError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }
  throw new Error('Expected the function to throw a GatewayError.');
}

function parts(stored: string): string[] {
  return stored.split('$');
}

describe('hashPassword', () => {
  it('produces the documented scrypt hash format', () => {
    const stored = hashPassword(PASSWORD);
    const [scheme, n, r, p, salt, key] = parts(stored);

    expect(scheme).toBe('scrypt');
    expect(n).toBe('16384');
    expect(r).toBe('8');
    expect(p).toBe('1');
    expect(salt).toBeDefined();
    expect(key).toBeDefined();
    expect(Buffer.from(salt ?? '', 'base64')).toHaveLength(SCRYPT_SALT_BYTES);
    expect(Buffer.from(key ?? '', 'base64')).toHaveLength(SCRYPT_KEY_LENGTH);
    expect(stored).not.toContain(PASSWORD);
  });

  it('uses a fresh random salt for every hash', () => {
    const first = hashPassword(PASSWORD);
    const second = hashPassword(PASSWORD);
    expect(first).not.toBe(second);
    expect(parts(first)[4]).not.toBe(parts(second)[4]);
    expect(verifyPassword(PASSWORD, first)).toBe(true);
    expect(verifyPassword(PASSWORD, second)).toBe(true);
  });

  it('accepts exactly the minimum length and long unicode passwords', () => {
    const minimum = 'a'.repeat(MIN_PASSWORD_LENGTH);
    expect(verifyPassword(minimum, hashPassword(minimum))).toBe(true);
    const unicode = 'pässwörd-with-emoji-🔐-and-more';
    expect(verifyPassword(unicode, hashPassword(unicode))).toBe(true);
  });

  it('rejects passwords shorter than the minimum with invalidParams', () => {
    expect(gatewayError(() => hashPassword('short')).code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(gatewayError(() => hashPassword('')).code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(gatewayError(() => hashPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).code).toBe(
      ErrorCodes.INVALID_PARAMS,
    );
    expect(
      gatewayError(() => hashPassword(undefined as unknown as string)).code,
    ).toBe(ErrorCodes.INVALID_PARAMS);
  });
});

describe('verifyPassword', () => {
  it('verifies the correct password and rejects a wrong one', () => {
    const stored = hashPassword(PASSWORD);
    expect(verifyPassword(PASSWORD, stored)).toBe(true);
    expect(verifyPassword(`${PASSWORD}x`, stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('fails closed on malformed or hostile stored hashes', () => {
    const cases = [
      '',
      'plaintext',
      'scrypt',
      'scrypt$16384$8$1',
      'scrypt$16384$8$1$only-five-parts',
      'scrypt$16384$8$1$AAAA$BBBB$extra',
      'bcrypt$16384$8$1$AAAA$BBBB',
      'scrypt$notanumber$8$1$AAAA$BBBB',
      'scrypt$16384$0$1$AAAA$BBBB',
      'scrypt$16384$8$1$$BBBB',
      'scrypt$16384$8$1$AAAA$',
      // Hostile parameters must be rejected without allocating gigabytes.
      'scrypt$99999999$32$16$AAAA$BBBB',
    ];
    for (const stored of cases) {
      expect(verifyPassword(PASSWORD, stored)).toBe(false);
    }
    expect(verifyPassword(PASSWORD, undefined as unknown as string)).toBe(false);
    expect(verifyPassword(undefined as unknown as string, hashPassword(PASSWORD))).toBe(false);
  });

  it('rejects a wrong-length digest without throwing', () => {
    const stored = hashPassword(PASSWORD);
    const [scheme, n, r, p, salt] = parts(stored);
    const truncated = [scheme, n, r, p, salt, Buffer.alloc(16).toString('base64')].join('$');
    expect(verifyPassword(PASSWORD, truncated)).toBe(false);
  });

  it('honours parameters embedded in the stored hash', () => {
    // A hash produced with different (still safe) parameters must verify.
    const salt = Buffer.from('0123456789abcdef');
    const key = scryptSync(PASSWORD, salt, 32, { N: 2048, r: 8, p: 1, maxmem: 16 * 1024 * 1024 });
    const stored = ['scrypt', '2048', '8', '1', salt.toString('base64'), key.toString('base64')].join(
      '$',
    );
    expect(verifyPassword(PASSWORD, stored)).toBe(true);
    expect(verifyPassword('wrong-password', stored)).toBe(false);
  });
});
