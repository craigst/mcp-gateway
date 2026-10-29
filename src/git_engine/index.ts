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
  assertAllowedCloneUrl,
  assertSafeRef,
  basicAuthHeader,
  cloneEnvExtras,
  cloneRepository,
  REDACTED,
  resolveGitHead,
  scrubSecrets,
  type CloneRepositoryOptions,
  type CloneResultMeta,
} from './clone.js';
export {
  BUILD_TIMEOUT_MS,
  MAX_BUILD_LOG_LINES,
  runBuildCommand,
  tailLines,
  type RunBuildOptions,
  type RunBuildResult,
} from './build.js';
export {
  buildChangelogUrl,
  compareSemverTags,
  isSemverTag,
  parseSemverTag,
  pickDefaultBranch,
  pickLatestTag,
  resolveRemoteRefs,
  type RemoteRefs,
  type ResolveRemoteRefsInput,
} from './remote.js';
export {
  deriveSubpath,
  scrubbedGatewayError,
  stagedUpdateRepository,
  type StagedUpdate,
  type StagedUpdateInput,
} from './staged.js';
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
