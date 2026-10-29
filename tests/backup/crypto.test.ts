import { describe, expect, it } from 'vitest';

import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import type { BackupEnvelope } from '../../src/core/types.js';
import {
  BACKUP_FORMAT,
  BACKUP_GATEWAY_VERSION,
  BACKUP_KDF,
  BACKUP_VERSION,
  decryptBackup,
  deriveBackupKey,
  encryptBackup,
} from '../../src/backup/crypto.js';

const PASSWORD = 'correct horse battery staple';
const PAYLOAD = {
  users: [{ username: 'admin', password_hash: 'scrypt$fixture$hash' }],
  servers: [{ id: 'srv_1', name: 'brain', env: '{}' }],
  vaultSecrets: [{ name: 'API_TOKEN', value: 'super-secret-fixture-value' }],
  nested: { list: [1, 2, 3], flag: true, nothing: null },
};

function expectOpaqueError(fn: () => unknown): GatewayError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    const gatewayError = error as GatewayError;
    expect(gatewayError.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(gatewayError.message).toBe('Invalid backup password or corrupted backup');
    return gatewayError;
  }
  throw new Error('expected a GatewayError');
}

describe('backup crypto', () => {
  it('round-trips a payload through the encrypted envelope', () => {
    const envelope = encryptBackup(PAYLOAD, PASSWORD);

    expect(envelope).toMatchObject({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      gatewayVersion: BACKUP_GATEWAY_VERSION,
      kdf: { name: 'scrypt', N: BACKUP_KDF.N, r: BACKUP_KDF.r, p: BACKUP_KDF.p },
      cipher: { name: 'aes-256-gcm' },
    });
    expect(envelope.createdAt).toEqual(expect.any(String));
    expect(Buffer.from(envelope.kdf.saltB64, 'base64')).toHaveLength(16);
    expect(Buffer.from(envelope.cipher.ivB64, 'base64')).toHaveLength(12);
    expect(Buffer.from(envelope.cipher.tagB64, 'base64')).toHaveLength(16);

    expect(decryptBackup(envelope, PASSWORD)).toEqual(PAYLOAD);
    // The envelope must never contain the plaintext payload.
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('super-secret-fixture-value');
    expect(serialized).not.toContain('correct horse');
    expect(serialized).not.toContain('password_hash');
  });

  it('uses a random salt/IV per backup (no deterministic ciphertext)', () => {
    const first = encryptBackup(PAYLOAD, PASSWORD);
    const second = encryptBackup(PAYLOAD, PASSWORD);
    expect(first.kdf.saltB64).not.toBe(second.kdf.saltB64);
    expect(first.cipher.ivB64).not.toBe(second.cipher.ivB64);
    expect(first.cipher.dataB64).not.toBe(second.cipher.dataB64);
  });

  it('derives a deterministic 32-byte scrypt key for a given salt', () => {
    const salt = Buffer.from('0123456789abcdef');
    const first = deriveBackupKey(PASSWORD, salt);
    const second = deriveBackupKey(PASSWORD, salt);
    expect(first).toHaveLength(32);
    expect(first.equals(second)).toBe(true);
    expect(first.equals(deriveBackupKey('different password', salt))).toBe(false);
  });

  it('rejects a wrong password with the opaque error', () => {
    const envelope = encryptBackup(PAYLOAD, PASSWORD);
    const error = expectOpaqueError(() => decryptBackup(envelope, 'wrong password'));
    expect(error.httpStatus).toBe(400);
    expect(JSON.stringify(error)).not.toContain('super-secret-fixture-value');
  });

  it('rejects tampered ciphertext/tag with the opaque error', () => {
    const envelope = encryptBackup(PAYLOAD, PASSWORD);
    const data = Buffer.from(envelope.cipher.dataB64, 'base64');
    data[0] = (data[0] as number) ^ 0xff;

    const tamperedData: BackupEnvelope = {
      ...envelope,
      cipher: { ...envelope.cipher, dataB64: data.toString('base64') },
    };
    expectOpaqueError(() => decryptBackup(tamperedData, PASSWORD));

    const tamperedTag: BackupEnvelope = {
      ...envelope,
      cipher: { ...envelope.cipher, tagB64: Buffer.alloc(16, 7).toString('base64') },
    };
    expectOpaqueError(() => decryptBackup(tamperedTag, PASSWORD));
  });

  it('rejects malformed envelopes and unsafe KDF parameters', () => {
    const envelope = encryptBackup(PAYLOAD, PASSWORD);
    expectOpaqueError(() => decryptBackup(null as unknown as BackupEnvelope, PASSWORD));
    expectOpaqueError(() =>
      decryptBackup({ ...envelope, format: 'not-a-backup' } as unknown as BackupEnvelope, PASSWORD),
    );
    expectOpaqueError(() =>
      decryptBackup({ ...envelope, version: 2 } as unknown as BackupEnvelope, PASSWORD),
    );
    expectOpaqueError(() =>
      decryptBackup(
        { ...envelope, kdf: { ...envelope.kdf, N: 99_999_999 } } as unknown as BackupEnvelope,
        PASSWORD,
      ),
    );
    expectOpaqueError(() =>
      decryptBackup(
        { ...envelope, cipher: { ...envelope.cipher, ivB64: 'not-base64!!' } } as unknown as BackupEnvelope,
        PASSWORD,
      ),
    );
  });

  it('requires a non-empty password for both directions', () => {
    expect(() => encryptBackup(PAYLOAD, '')).toThrowError(GatewayError);
    const envelope = encryptBackup(PAYLOAD, PASSWORD);
    expect(() => decryptBackup(envelope, '')).toThrowError(GatewayError);
  });
});
