/**
 * Public discovery surface: local harness adapters + the import service.
 */
export {
  HARNESS_ADAPTERS,
  HARNESS_ADAPTER_IDS,
  expandHome,
  normalizeClaudeEntry,
  normalizeGenericEntry,
  normalizeOpenmausbotEntry,
  normalizeOpencodeEntry,
  scanAllHarnesses,
  scanAllHarnessesSync,
  type HarnessAdapter,
  type HarnessAdapterId,
  type HarnessAdapterScan,
  type HarnessScanContext,
  type NormalizeEntryOptions,
  type ScanAllOptions,
} from './adapters.js';
export {
  DefaultHarnessDiscoveryService,
  deriveRuntime,
  sanitizeServerName,
  type HarnessDiscoveryDeps,
} from './service.js';
