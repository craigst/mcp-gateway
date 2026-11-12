import { describe, expect, it } from 'vitest';

import { decodeBase32, generateTotp, normalizeTotpSecret, totpRemainingSeconds } from '../../src/social/totp.js';

// RFC 6238 test seed ("12345678901234567890" in ASCII) as base32.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('TOTP', () => {
  it('normalizes a pasted authenticator key', () => {
    expect(normalizeTotpSecret(' jbsw y3dp-ehpk 3pxp== ')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('decodes base32', () => {
    expect(decodeBase32('JBSWY3DPEHPK3PXP').toString('hex')).toBe('48656c6c6f21deadbeef');
  });

  it('matches the RFC 6238 SHA-1 vectors (8 digits)', () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, expected] of vectors) {
      expect(generateTotp(RFC_SECRET, { digits: 8, now: seconds * 1000 })).toBe(expected);
    }
  });

  it('returns the last six digits of the same counter', () => {
    expect(generateTotp(RFC_SECRET, { now: 59_000 })).toBe('287082');
  });

  it('rejects a non-base32 secret', () => {
    expect(() => generateTotp('not a secret!', { now: 0 })).toThrow(/base32/);
  });

  it('counts down the current step', () => {
    expect(totpRemainingSeconds(30, 0)).toBe(30);
    expect(totpRemainingSeconds(30, 29_000)).toBe(1);
  });
});
