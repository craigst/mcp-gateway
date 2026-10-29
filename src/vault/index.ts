/**
 * Encrypted vault module: AES-256-GCM crypto helpers and the SQLite-backed
 * `VaultService` implementation.
 */
export {
  DEFAULT_VAULT_SALT,
  decrypt,
  deriveKey,
  encrypt,
  type EncryptedPayload,
} from './crypto.js';
export {
  SqliteVaultService,
  VAULT_SECRET_NAME_PATTERN,
  type SqliteVaultServiceOptions,
} from './store.js';
