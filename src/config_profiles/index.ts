/**
 * Public configuration-profile surface.
 */
export {
  SqliteConfigProfileStore,
  type NewConfigProfileRecord,
  type StoredConfigProfile,
} from './store.js';
export {
  DefaultConfigProfileService,
  profileEnvSecretName,
  profileHeaderSecretName,
  type ConfigProfileServiceDeps,
} from './service.js';
