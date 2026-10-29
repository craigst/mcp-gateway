/**
 * Encrypted backup envelope (v0.6).
 *
 * A backup is a password-protected snapshot of the gateway state:
 *
 *   payload --JSON--> gzip --> AES-256-GCM(password-derived key) --> envelope
 *
 * The key is derived with scrypt (N=16384, r=8, p=1, 32-byte output) using a
 * random per-backup salt; the AES key/IV are never reused. The envelope stores
 * every KDF/cipher parameter it needs, so a backup can be restored on a fresh
 * install with only the operator's password.
 *
 * Any decryption/authentication/format failure surfaces as ONE opaque error:
 * "Invalid backup password or corrupted backup" (no oracle about whether the
 * password or the data was wrong).
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import { ErrorCodes, GatewayError, invalidParams } from '../core/errors.js';
import type { BackupEnvelope } from '../core/types.js';

export const BACKUP_FORMAT = 'mcp-gateway-backup';
export const BACKUP_VERSION = 1;
/** Version stamped into new backups. */
export const BACKUP_GATEWAY_VERSION = '0.6.0';

export const BACKUP_KDF = { N: 16_384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_KDF_N = 1_048_576;
const MAX_KDF_R = 32;
const MAX_KDF_P = 16;
/** Hard cap on the decrypted payload to bound memory on hostile input. */
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const MAX_CIPHERTEXT_BYTES = 256 * 1024 * 1024;

export function invalidBackupError(): GatewayError {
  return new GatewayError(ErrorCodes.INVALID_PARAMS, 'Invalid backup password or corrupted backup', {
    httpStatus: 400,
    data: { status: 'INVALID_PARAMS' },
  });
}

function assertPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length === 0) {
    throw invalidParams('A backup password is required');
  }
}

/**
 * Derives the 32-byte AES key for a backup password (scrypt, N=16384/r=8/p=1).
 * `salt` must be the random per-backup salt from the envelope.
 */
export function deriveBackupKey(password: string, salt: Buffer): Buffer {
  assertPassword(password);
  if (!Buffer.isBuffer(salt) || salt.length === 0) {
    throw invalidParams('A backup salt is required');
  }
  return scryptSync(password, salt, KEY_LENGTH, {
    N: BACKUP_KDF.N,
    r: BACKUP_KDF.r,
    p: BACKUP_KDF.p,
    maxmem: 64 * 1024 * 1024,
  });
}

/** Encrypts an arbitrary JSON payload into a self-describing backup envelope. */
export function encryptBackup(payload: unknown, password: string): BackupEnvelope {
  assertPassword(password);
  const createdAt = new Date().toISOString();
  const salt = randomBytes(SALT_BYTES);
  const key = deriveBackupKey(password, salt);
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload ?? null), 'utf8'));
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt,
    gatewayVersion: BACKUP_GATEWAY_VERSION,
    kdf: {
      name: 'scrypt',
      N: BACKUP_KDF.N,
      r: BACKUP_KDF.r,
      p: BACKUP_KDF.p,
      saltB64: salt.toString('base64'),
    },
    cipher: {
      name: 'aes-256-gcm',
      ivB64: iv.toString('base64'),
      tagB64: tag.toString('base64'),
      dataB64: encrypted.toString('base64'),
    },
  };
}

interface ValidatedEnvelope {
  salt: Buffer;
  iv: Buffer;
  tag: Buffer;
  data: Buffer;
  N: number;
  r: number;
  p: number;
}

function decodeBase64(value: unknown, expectedLength?: number): Buffer {
  if (typeof value !== 'string' || value.length === 0) throw invalidBackupError();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw invalidBackupError();
  const buffer = Buffer.from(value, 'base64');
  if (expectedLength !== undefined && buffer.length !== expectedLength) throw invalidBackupError();
  if (buffer.length > MAX_CIPHERTEXT_BYTES) throw invalidBackupError();
  return buffer;
}

function validatedEnvelope(envelope: unknown): ValidatedEnvelope {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw invalidBackupError();
  }
  const record = envelope as Record<string, unknown>;
  if (record.format !== BACKUP_FORMAT) throw invalidBackupError();
  if (record.version !== BACKUP_VERSION) throw invalidBackupError();

  const kdf = record.kdf;
  if (typeof kdf !== 'object' || kdf === null || Array.isArray(kdf)) throw invalidBackupError();
  const kdfRecord = kdf as Record<string, unknown>;
  if (kdfRecord.name !== 'scrypt') throw invalidBackupError();
  const N = kdfRecord.N;
  const r = kdfRecord.r;
  const p = kdfRecord.p;
  if (
    typeof N !== 'number' ||
    !Number.isInteger(N) ||
    N < 1024 ||
    N > MAX_KDF_N ||
    typeof r !== 'number' ||
    !Number.isInteger(r) ||
    r < 1 ||
    r > MAX_KDF_R ||
    typeof p !== 'number' ||
    !Number.isInteger(p) ||
    p < 1 ||
    p > MAX_KDF_P
  ) {
    throw invalidBackupError();
  }

  const cipher = record.cipher;
  if (typeof cipher !== 'object' || cipher === null || Array.isArray(cipher)) {
    throw invalidBackupError();
  }
  const cipherRecord = cipher as Record<string, unknown>;
  if (cipherRecord.name !== 'aes-256-gcm') throw invalidBackupError();

  const salt = decodeBase64(kdfRecord.saltB64);
  if (salt.length < 8 || salt.length > 64) throw invalidBackupError();

  return {
    salt,
    iv: decodeBase64(cipherRecord.ivB64, IV_BYTES),
    tag: decodeBase64(cipherRecord.tagB64, TAG_BYTES),
    data: decodeBase64(cipherRecord.dataB64),
    N,
    r,
    p,
  };
}

/**
 * Decrypts and parses a backup envelope.
 *
 * Throws `GatewayError(INVALID_PARAMS)` with the same opaque message for a wrong
 * password, a tampered ciphertext/tag, or a malformed envelope.
 */
export function decryptBackup(envelope: BackupEnvelope, password: string): unknown {
  assertPassword(password);
  let parsed: ValidatedEnvelope;
  try {
    parsed = validatedEnvelope(envelope);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw invalidBackupError();
  }

  let plaintext: Buffer;
  try {
    const key = scryptSync(password, parsed.salt, KEY_LENGTH, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: 128 * 1024 * 1024,
    });
    const decipher = createDecipheriv('aes-256-gcm', key, parsed.iv);
    decipher.setAuthTag(parsed.tag);
    plaintext = Buffer.concat([decipher.update(parsed.data), decipher.final()]);
  } catch {
    throw invalidBackupError();
  }

  let json: string;
  try {
    json = gunzipSync(plaintext, { maxOutputLength: MAX_PAYLOAD_BYTES }).toString('utf8');
  } catch {
    throw invalidBackupError();
  }

  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw invalidBackupError();
  }
}
