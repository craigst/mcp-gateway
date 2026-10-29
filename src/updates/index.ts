/**
 * Server update tracking (v0.4): upstream source persistence, update checks and
 * staged in-place updates.
 */
export {
  DefaultServerUpdateService,
  type BackfillResult,
  type DefaultServerUpdateServiceDeps,
} from './service.js';
export {
  checkedAtNow,
  resolveInstalledCommit,
  resolveInstalledVersion,
  SqliteServerSourceStore,
  type ServerSourceStore,
} from './store.js';
