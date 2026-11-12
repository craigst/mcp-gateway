/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for the Instagram two-factor code.
 *
 * The secret is the base32 seed an authenticator app holds (Bitwarden's
 * "authenticator key", e.g. `JBSWY3DPEHPK3PXP`). It is only ever held in the
 * gateway vault and decoded in memory; codes are never logged or persisted.
 */
import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Strip spaces/hyphens and padding; 2FA seeds are case-insensitive. */
export function normalizeTotpSecret(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, '');
}

/** RFC 4648 base32 -> bytes, rejecting anything that is not a 2FA seed. */
export function decodeBase32(raw: string): Buffer {
  const secret = normalizeTotpSecret(raw);
  if (secret.length === 0 || !/^[A-Z2-7]+$/.test(secret)) {
    throw new Error('2FA secret is not valid base32');
  }
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of secret) {
    value = (value << 5) | ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export interface TotpOptions {
  digits?: number;
  periodSeconds?: number;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: number;
}

/** The code an authenticator app is showing at `now`. */
export function generateTotp(rawSecret: string, options: TotpOptions = {}): string {
  const digits = options.digits ?? 6;
  const period = options.periodSeconds ?? 30;
  const counter = Math.floor((options.now ?? Date.now()) / 1000 / period);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  message.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac('sha1', decodeBase32(rawSecret)).update(message).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Seconds until the code changes — shown in the console so an operator is not surprised by a 2FA prompt. */
export function totpRemainingSeconds(periodSeconds = 30, now: number = Date.now()): number {
  const elapsed = Math.floor(now / 1000) % periodSeconds;
  return periodSeconds - elapsed;
}
