/**
 * Git import engine: allowlisted clone, manifest validation, bounded build and
 * `ServerRecord` production for supervisor registration.
 */
export {
  deriveServerName,
  GitImportService,
  GitImportService as DefaultGitImportService,
  type GitImportServiceDeps,
} from './service.js';
export {
  mapRuntime,
  parseManifestFile,
  splitCommand,
  validateManifest,
} from './manifest.js';
