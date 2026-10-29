/**
 * Git import engine: allowlisted clone, manifest validation/auto-detection,
 * bounded build and `ServerRecord` production for supervisor registration.
 */
export {
  deriveServerName,
  GitImportService,
  GitImportService as DefaultGitImportService,
  normalizeSubpath,
  type GitImportServiceDeps,
} from './service.js';
export {
  mapRuntime,
  parseManifestFile,
  splitCommand,
  validateManifest,
} from './manifest.js';
export {
  assertSafeRef,
  basicAuthHeader,
  cloneEnvExtras,
  cloneRepository,
  REDACTED,
  scrubSecrets,
  type CloneRepositoryOptions,
  type CloneResultMeta,
} from './clone.js';
export {
  DEFAULT_NODE_BUILD_COMMAND,
  DEFAULT_PYTHON_BUILD_COMMAND,
  detectManifest,
  NODE_FILE_CANDIDATES,
  probeManifest,
  type DetectedFrom,
  type DetectedManifest,
  type ManifestProbe,
} from './autodetect.js';
