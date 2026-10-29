import { describe, expect, it } from 'vitest';

import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import { DEFAULT_VAULT_SALT, decrypt, deriveKey, encrypt } from '../../src/vault/crypto.js';

const SECRET = 'test-vault-secret-with-enough-entropy';

function flipByte(base64: string, index = 0): string {
  const buffer = Buffer.from(base64, 'base64');
  buffer.writeUInt8(buffer.readUInt8(index) ^ 0xff, index);
  return buffer.toString('base64');
}

function expectDecryptionFailure(run: () => unknown): GatewayError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    const gatewayError = error as GatewayError;
    expect(gatewayError.code).toBe(ErrorCodes.INTERNAL_ERROR);
    expect(gatewayError.message).toBe('Vault decryption failed: authentication tag mismatch');
    return gatewayError;
  }
  throw new Error('expected decryption to fail');
}

describe('vault crypto', () => {
  describe('deriveKey', () => {
    it('derives a deterministic 32-byte AES key', () => {
      const key = deriveKey(SECRET);
      expect(key).toBeInstanceOf(Buffer);
      expect(key).toHaveLength(32);
      expect(deriveKey(SECRET).equals(key)).toBe(true);
    });

    it('changes with the secret and with the salt', () => {
      expect(deriveKey(SECRET).equals(deriveKey(`${SECRET}!`))).toBe(false);
      expect(deriveKey(SECRET).equals(deriveKey(SECRET, 'other-salt'))).toBe(false);
      expect(deriveKey(SECRET, 'other-salt').equals(deriveKey(SECRET, 'other-salt'))).toBe(true);
    });

    it('defaults to the versioned gateway salt', () => {
      expect(deriveKey(SECRET).equals(deriveKey(SECRET, DEFAULT_VAULT_SALT))).toBe(true);
      expect(DEFAULT_VAULT_SALT).toBe('mcp-gateway/vault/v1');
    });

    it('rejects an empty secret', () => {
      expect(() => deriveKey('')).toThrow(GatewayError);
    });
  });

  describe('encrypt/decrypt round-trip', () => {
    it.each([
      'hello world',
      '  leading and trailing  ',
      'unicode: héllo 🔐 日本語',
      'x'.repeat(4096),
    ])('round-trips %j', (plaintext) => {
      const payload = encrypt(plaintext, SECRET);
      expect(payload.ciphertext).not.toBe(plaintext);
      expect(Buffer.from(payload.iv, 'base64')).toHaveLength(12);
      expect(Buffer.from(payload.authTag, 'base64')).toHaveLength(16);
      expect(decrypt(payload, SECRET)).toBe(plaintext);
    });

    it('round-trips the empty string', () => {
      expect(decrypt(encrypt('', SECRET), SECRET)).toBe('');
    });

    it('produces base64 envelope fields', () => {
      const payload = encrypt('hello world', SECRET);
      expect(payload.ciphertext).not.toBe('hello world');
      expect(Buffer.from(payload.iv, 'base64')).toHaveLength(12);
      expect(Buffer.from(payload.authTag, 'base64')).toHaveLength(16);
      expect(decrypt(payload, SECRET)).toBe('hello world');
    });

    it('never stores plaintext in the ciphertext field', () => {
      const plaintext = 'super-secret-api-token-value';
      const payload = encrypt(plaintext, SECRET);
      expect(payload.ciphertext).not.toContain(plaintext);
      expect(Buffer.from(payload.ciphertext, 'base64').toString('utf8')).not.toContain(plaintext);
    });

    it('uses a fresh IV for every write', () => {
      const first = encrypt('same plaintext', SECRET);
      const second = encrypt('same plaintext', SECRET);
      expect(first.iv).not.toBe(second.iv);
      expect(first.ciphertext).not.toBe(second.ciphertext);
      expect(decrypt(first, SECRET)).toBe('same plaintext');
      expect(decrypt(second, SECRET)).toBe('same plaintext');
    });
  });

  describe('tamper detection', () => {
    it('fails when the ciphertext is modified', () => {
      const payload = encrypt('tamper me', SECRET);
      expectDecryptionFailure(() =>
        decrypt({ ...payload, ciphertext: flipByte(payload.ciphertext) }, SECRET),
      );
    });

    it('fails when the IV is modified', () => {
      const payload = encrypt('tamper me', SECRET);
      expectDecryptionFailure(() => decrypt({ ...payload, iv: flipByte(payload.iv) }, SECRET));
    });

    it('fails when the auth tag is modified', () => {
      const payload = encrypt('tamper me', SECRET);
      expectDecryptionFailure(() =>
        decrypt({ ...payload, authTag: flipByte(payload.authTag) }, SECRET),
      );
    });

    it('fails when a field is malformed', () => {
      const payload = encrypt('tamper me', SECRET);
      expectDecryptionFailure(() => decrypt({ ...payload, iv: 'AAAA' }, SECRET));
      expectDecryptionFailure(() => decrypt({ ...payload, authTag: 'AAAA' }, SECRET));
    });

    it('fails with the wrong secret', () => {
      const payload = encrypt('wrong-secret-value', SECRET);
      expectDecryptionFailure(() => decrypt(payload, `${SECRET}-different`));
    });

    it('does not leak plaintext in the error', () => {
      const payload = encrypt('TOP_SECRET_PLAINTEXT', SECRET);
      const error = expectDecryptionFailure(() =>
        decrypt({ ...payload, authTag: flipByte(payload.authTag) }, SECRET),
      );
      expect(error.message).not.toContain('TOP_SECRET_PLAINTEXT');
      expect(JSON.stringify(error)).not.toContain('TOP_SECRET_PLAINTEXT');
    });
  });
});
