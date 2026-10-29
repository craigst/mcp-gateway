/**
 * Credential providers (v0.7): Vaultwarden (default), 1Password and the
 * gateway AES vault, behind one `CredentialProviderService`.
 */
export {
  credentialSecretName,
  DEFAULT_PROVIDER,
  DEFAULT_PROVIDER_SETTING,
  DefaultCredentialProviderService,
  extractDeliveryPath,
  parseDeliveredValue,
  parseVaultwardenItems,
  PROVIDER_IDS,
  type DefaultCredentialProviderServiceDeps,
} from './service.js';
