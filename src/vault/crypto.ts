/**
 * AES-256-GCM envelope encryption for vault secrets.
 *
 * The data-encryption key is derived from the operator-supplied secret with
 * scrypt (`MCP_VAULT_SECRET`). Every write uses a fresh random 96-bit IV and
 * produces an authentication tag, so tampering with any part of the envelope
 * fails closed.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { ErrorCodes, GatewayError } from '../core/errors.js';

/** Domain-separated default salt, versioned so the KDF can be rotated later. */
export const DEFAULT_VAULT_SALT = 'mcp-gateway/vault/v1';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface EncryptedPayload {
  /** Base64-encoded ciphertext (GCM output, no tag). */
  ciphertext: string;
  /** Base64-encoded 12-byte initialization vector. */
  iv: string;
  /** Base64-encoded 16-byte GCM authentication tag. */
  authTag: string;
}

/** Derive the 32-byte AES key from the vault secret with scrypt. */
export function deriveKey(secret: string, salt: string = DEFAULT_VAULT_SALT): Buffer {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new GatewayError(ErrorCodes.INTERNAL_ERROR, 'Vault secret is not configured');
  }
  return scryptSync(secret, salt, KEY_BYTES);
}

/** Encrypt a UTF-8 string. Returns base64 fields; the IV is unique per call. */
export function encrypt(plaintext: string, secret: string): EncryptedPayload {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * Decrypt a base64 envelope produced by {@link encrypt}.
 *
 * Any failure (tampered ciphertext / IV / tag, wrong secret, malformed field)
 * is reported with the same opaque error so callers cannot distinguish causes
 * and plaintext is never included in an error message.
 */
export function decrypt(payload: EncryptedPayload, secret: string): string {
  try {
    const key = deriveKey(secret);
    const iv = Buffer.from(payload.iv, 'base64');
    const authTag = Buffer.from(payload.authTag, 'base64');
    const ciphertext = Buffer.from(payload.ciphertext, 'base64');
    if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
      throw new Error('malformed vault envelope');
    }
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new GatewayError(
      ErrorCodes.INTERNAL_ERROR,
      'Vault decryption failed: authentication tag mismatch',
      { httpStatus: 500 },
    );
  }
}
