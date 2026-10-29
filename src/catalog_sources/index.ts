/**
 * Plugin catalog (GitHub / private repositories) for v0.2.
 *
 * Sources are persisted in the `catalog_sources` table; tokens live only in the
 * AES-256 vault. Providers turn a source into installable entries and the
 * service drives clone → auto-manifest → build → register → optional start/test
 * through the Git import engine.
 */
export {
  GitPluginCatalog,
  catalogTokenSecretName,
  type GitPluginCatalogDeps,
} from './service.js';
export {
  SqliteCatalogSourceRepository,
  type CatalogSourceStore,
} from './store.js';
export {
  BUNDLE_UNSUPPORTED_REASON,
  CatalogJsonCatalogProvider,
  createCatalogProvider,
  DshUmbrellaCatalogProvider,
  githubOwner,
  GithubRepoCatalogProvider,
  isSafeEntryPath,
  normalizeCatalogJson,
  normalizeRepoPath,
  parseGitmodules,
  parsePinnedCatalog,
  repoNameFromUrl,
  type CatalogJsonProviderOptions,
  type CatalogProvider,
  type CatalogProviderDeps,
  type GitmoduleEntry,
  type ParsedPinnedCatalog,
  type PinnedBundleEntry,
  type PinnedMcpEntry,
  type UmbrellaProviderOptions,
} from './providers.js';
