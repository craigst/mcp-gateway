/**
 * Shared helpers and prop types for the tabbed catalog workspace.
 * Kept free of React so it can be unit-tested and reused by every tab.
 */
import type { AsyncState } from '../../lib/hooks.js';
import { api } from '../../lib/api.js';
import type {
  CatalogEntry,
  CatalogSource,
  CatalogSourceKind,
  InstallTestResult,
  ServerRecord,
} from '../../../core/types.js';

export type CatalogTab = 'installed' | 'discover' | 'sources' | 'import';

export const CATALOG_TABS: readonly { key: CatalogTab; label: string; hint: string }[] = [
  { key: 'installed', label: 'Installed', hint: 'run · test · policy' },
  { key: 'discover', label: 'Discover', hint: 'private catalog' },
  { key: 'sources', label: 'Sources', hint: 'connect GitHub' },
  { key: 'import', label: 'Import', hint: 'local harnesses' },
];

export type ServersState = AsyncState<ServerRecord[]> & { reload: () => void };
export type SourcesState = AsyncState<CatalogSource[]> & { reload: () => void };

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const REPO_URL_PATTERN = /^https?:\/\/[^\s]+$/i;

export interface EnvRow {
  id: number;
  key: string;
  value: string;
}

let envRowSequence = 0;

export function newEnvRow(key = '', value = ''): EnvRow {
  envRowSequence += 1;
  return { id: envRowSequence, key, value };
}

/** Seed editable env rows from discovery key names (values are never returned). */
export function envRowsFromKeys(keys: readonly string[]): EnvRow[] {
  return keys.map((key) => newEnvRow(key, ''));
}

/**
 * Validate editable env rows and collapse them into a `KEY=VALUE` map.
 * Blank rows are ignored; only rows with a value or an invalid key fail.
 */
export function parseEnvRows(rows: readonly EnvRow[]): { env: Record<string, string>; error: string | null } {
  const env: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key === '') {
      if (row.value.trim() !== '') return { env, error: 'Environment variable name is required when a value is set.' };
      continue;
    }
    if (!ENV_KEY_PATTERN.test(key)) return { env, error: `Invalid environment variable name: ${key}` };
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      return { env, error: `Duplicate environment variable name: ${key}` };
    }
    env[key] = row.value;
  }
  return { env, error: null };
}

/** Parse the JSON-object env blob used by the manual register form. */
export function parseEnvJson(value: string): Record<string, string> {
  const trimmed = value.trim();
  if (trimmed === '') return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('env must be a JSON object');
  }
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) env[key] = String(entry);
  return env;
}

export function splitList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// ---------------------------------------------------------------------------
// Server lifecycle helpers
// ---------------------------------------------------------------------------

export type ServerAction = 'start' | 'stop' | 'restart';

export function statusAllows(status: string, action: ServerAction): boolean {
  switch (action) {
    case 'start':
      return status === 'stopped' || status === 'failed';
    case 'stop':
      return status === 'running' || status === 'degraded' || status === 'starting';
    case 'restart':
      return status === 'running' || status === 'degraded';
    default:
      return false;
  }
}

export function callServerAction(action: ServerAction, id: string): Promise<ServerRecord> {
  if (action === 'start') return api.startServer(id);
  if (action === 'stop') return api.stopServer(id);
  return api.restartServer(id);
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

export function describeTestResult(test: InstallTestResult): string {
  if (!test.ok) return test.error ? `Probe failed: ${test.error}` : 'Probe failed';
  return `${test.toolCount} tool${test.toolCount === 1 ? '' : 's'} · ${formatLatency(test.latencyMs)}`;
}

export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function sourceKindLabel(kind: CatalogSourceKind): string {
  switch (kind) {
    case 'dsh-umbrella':
      return 'umbrella repo';
    case 'github-repo':
      return 'single repo';
    case 'catalog-json':
      return 'catalog JSON';
    default:
      return kind;
  }
}

export function entryKindLabel(entry: CatalogEntry): string {
  return entry.kind === 'bundle' ? 'bundle' : 'mcp server';
}

export function installedStateLabel(entry: CatalogEntry): string {
  return entry.installedServerId ? `installed · ${entry.installedServerId}` : 'not installed';
}

export function sourceTokenLabel(source: CatalogSource): string {
  return source.tokenSecretName ? 'token in vault' : 'public';
}
