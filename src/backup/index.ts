/**
 * Encrypted backup/restore (v0.6).
 */
export {
  BACKUP_FORMAT,
  BACKUP_GATEWAY_VERSION,
  BACKUP_KDF,
  BACKUP_VERSION,
  decryptBackup,
  deriveBackupKey,
  encryptBackup,
  invalidBackupError,
} from './crypto.js';
export {
  DefaultBackupService,
  type BackupPayload,
  type DefaultBackupServiceDeps,
} from './service.js';
