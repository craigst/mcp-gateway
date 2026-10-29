/**
 * Local harness discovery adapters.
 *
 * Read-only, local-only inspection of MCP servers configured by developer
 * harnesses the operator already runs outside the gateway:
 *
 *   - `claude`      → `~/.claude.json`                        (`.mcpServers`)
 *   - `opencode`    → `~/.config/opencode/opencode.json`      (`.mcp`, + sibling `mcp.env`)
 *   - `openmausbot` → `~/.openmausbot/config.json`            (`.mcpServers`)
 *   - `generic`     → `$MCP_DISCOVERY_CONFIG`                 (`.mcpServers`)
 *
 * Every adapter reports a `HarnessSourceInfo` plus `HarnessEntry[]`; config
 * problems are reported through the scan result (`error` / `errors`) instead of
 * throwing so one broken harness never breaks a whole scan.
 *
 * SECURITY INVARIANT: adapters expose environment variable and HTTP header
 * NAMES only. Values are never copied into the returned entries, therefore a
 * serialized `HarnessScanResult` can never leak a secret even when the source
 * config contains one.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { HarnessEntry, HarnessScanResult, HarnessSourceInfo, HarnessTransport } from '../core/types.js';

export type HarnessAdapterId = 'claude' | 'opencode' | 'openmausbot' | 'generic';

/** Resolved inputs used to locate harness config files. */
export interface HarnessScanContext {
  /** Home directory used for `~` expansion. */
  homeDir: string;
  /** Environment used for per-adapter path overrides. */
  env: NodeJS.ProcessEnv;
}

/** Result of scanning a single harness adapter. */
export interface HarnessAdapterScan {
  source: HarnessSourceInfo;
  entries: HarnessEntry[];
  /** Present when the config was missing, unreadable or malformed. */
  error?: string;
}

/** A built-in (or injected) local harness config reader. */
export interface HarnessAdapter {
  readonly id: HarnessAdapterId;
  readonly label: string;
  /** Default config path. `~/…` is expanded against the scan context's homeDir. */
  readonly defaultPath: string;
  /** Environment variable that overrides the config path. */
  readonly pathEnvVar: string;
  scan(context?: Partial<HarnessScanContext>): HarnessAdapterScan;
}

export interface ScanAllOptions {
  /** Restrict the scan to these harness ids (unknown ids are reported as errors). */
  harnessIds?: string[];
  /** Test/injection hook: defaults to `os.homedir()`. */
  homeDir?: string;
  /** Test/injection hook: defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test/injection hook: replace the built-in adapter list. */
  adapters?: readonly HarnessAdapter[];
}

export interface NormalizeEntryOptions {
  /** Harness id embedded in the entry id; adapter-specific defaults apply. */
  harness?: string;
  /** Env file this harness loads (values stay on disk). */
  envFile?: string | null;
  /** Explicit enabled flag; defaults per adapter. */
  enabled?: boolean;
}

const HARNESS_TRANSPORTS: readonly HarnessTransport[] = ['stdio', 'http', 'sse', 'websocket'];
const OPENCODE_ENV_FILE_NAME = 'mcp.env';
const OPENCODE_ENV_FILE_ENV_VAR = 'MCP_DISCOVERY_OPENCODE_ENV_FILE';

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHarnessTransport(value: string): value is HarnessTransport {
  return (HARNESS_TRANSPORTS as readonly string[]).includes(value);
}

/** Expands a leading `~` using the injected home directory (never `process.env`). */
export function expandHome(path: string, homeDir: string): string {
  if (path === '~') return homeDir;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homeDir, path.slice(2));
  return path;
}

function normalizeScanContext(context: Partial<HarnessScanContext> = {}): HarnessScanContext {
  return { homeDir: context.homeDir ?? homedir(), env: context.env ?? process.env };
}

function argsOf(raw: Record<string, unknown>): string[] {
  return Array.isArray(raw.args) ? raw.args.map((value) => String(value)) : [];
}

/** Collects env variable NAMES from one or more config fields (never values). */
function envKeysOf(raw: Record<string, unknown>, fieldNames: readonly string[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const field of fieldNames) {
    const value = raw[field];
    if (!isRecord(value)) continue;
    for (const name of Object.keys(value)) {
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** Collects header NAMES only (never values). */
function headerKeysOf(raw: Record<string, unknown>): string[] {
  return isRecord(raw.headers) ? Object.keys(raw.headers) : [];
}

function jsonErrorPosition(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const match = /position\s+(\d+)/i.exec(message);
  return match ? ` (at position ${match[1]})` : '';
}

function systemErrorCode(error: unknown): string {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === 'string' ? code : 'unknown';
}

// ---------------------------------------------------------------------------
// Shared config loader
// ---------------------------------------------------------------------------

interface LoadedHarnessConfig {
  exists: boolean;
  config: unknown;
  error?: string;
}

/**
 * Reads a JSON config, tolerating every failure mode. The JSON parser's own
 * message is deliberately not surfaced because it can quote the file content
 * (which may contain secrets) — only the position is kept.
 */
function loadJsonConfig(configPath: string): LoadedHarnessConfig {
  if (!configPath) {
    return { exists: false, config: null, error: 'Config path is not configured' };
  }
  if (!existsSync(configPath)) {
    return { exists: false, config: null, error: `Config file not found: ${configPath}` };
  }
  try {
    const text = readFileSync(configPath, 'utf8');
    try {
      return { exists: true, config: JSON.parse(text) as unknown };
    } catch (error) {
      return {
        exists: true,
        config: null,
        error: `Config file is not valid JSON: ${configPath}${jsonErrorPosition(error)}`,
      };
    }
  } catch (error) {
    return {
      exists: true,
      config: null,
      error: `Config file could not be read: ${configPath} (${systemErrorCode(error)})`,
    };
  }
}

function resolveConfigPath(adapter: HarnessAdapter, context: HarnessScanContext): string {
  const override = context.env[adapter.pathEnvVar];
  const value = typeof override === 'string' && override.trim() !== '' ? override.trim() : adapter.defaultPath;
  if (!value) return '';
  const expanded = expandHome(value, context.homeDir);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function sourceInfo(
  adapter: Pick<HarnessAdapter, 'id' | 'label'>,
  configPath: string,
  exists: boolean,
  serverCount: number,
): HarnessSourceInfo {
  return { id: adapter.id, label: adapter.label, configPath, exists, serverCount };
}

function failedScan(
  adapter: Pick<HarnessAdapter, 'id' | 'label'>,
  configPath: string,
  exists: boolean,
  error: string,
): HarnessAdapterScan {
  return { source: sourceInfo(adapter, configPath, exists, 0), entries: [], error };
}

/** Validates the common `{ "mcpServers": { … } }` wrapper. */
function mcpServersOf(config: unknown, configPath: string): { servers: Record<string, unknown>; error?: string } {
  if (!isRecord(config)) {
    return { servers: {}, error: `Config file does not contain a JSON object: ${configPath}` };
  }
  const servers = config.mcpServers;
  if (servers === undefined) return { servers: {} };
  if (!isRecord(servers)) return { servers: {}, error: `'mcpServers' in ${configPath} must be an object` };
  return { servers };
}

// ---------------------------------------------------------------------------
// Pure entry normalizers
// ---------------------------------------------------------------------------

interface SharedNormalizeOptions extends NormalizeEntryOptions {
  defaultTransport?: HarnessTransport;
  envFieldNames?: readonly string[];
}

/**
 * Normalizes the shape shared by Claude Code, OpenMausBot and the generic
 * adapter: `{ command?, args?, url?, type?, env?, headers? }`.
 */
function normalizeServerEntry(
  harness: string,
  name: string,
  raw: unknown,
  options: SharedNormalizeOptions = {},
): HarnessEntry | null {
  if (!isRecord(raw)) return null;

  const explicitType = typeof raw.type === 'string' ? raw.type.toLowerCase() : null;
  const command = typeof raw.command === 'string' && raw.command.trim() !== '' ? raw.command : null;
  const url = typeof raw.url === 'string' && raw.url.trim() !== '' ? raw.url : null;

  let transport: HarnessTransport;
  if (explicitType !== null && explicitType !== 'stdio' && isHarnessTransport(explicitType)) {
    transport = explicitType;
  } else if (command) {
    transport = 'stdio';
  } else if (url) {
    transport = options.defaultTransport ?? 'http';
  } else {
    transport = 'stdio';
  }

  const remote = transport !== 'stdio';
  return {
    id: `${harness}:${name}`,
    harness,
    name,
    transport,
    command: remote ? null : command,
    args: remote ? [] : argsOf(raw),
    url: remote ? url : null,
    envKeys: envKeysOf(raw, options.envFieldNames ?? ['env']),
    envFile: options.envFile ?? null,
    headerKeys: remote ? headerKeysOf(raw) : [],
    enabled: options.enabled ?? true,
  };
}

/** Claude Code (`~/.claude.json`) entry normalizer. */
export function normalizeClaudeEntry(name: string, raw: unknown, options: NormalizeEntryOptions = {}): HarnessEntry | null {
  return normalizeServerEntry(options.harness ?? 'claude', name, raw, options);
}

/** OpenMausBot (`~/.openmausbot/config.json`) entry normalizer. */
export function normalizeOpenmausbotEntry(name: string, raw: unknown, options: NormalizeEntryOptions = {}): HarnessEntry | null {
  return normalizeServerEntry(options.harness ?? 'openmausbot', name, raw, options);
}

/** Generic `{ "mcpServers": { … } }` entry normalizer (same shape as Claude). */
export function normalizeGenericEntry(name: string, raw: unknown, options: NormalizeEntryOptions = {}): HarnessEntry | null {
  return normalizeServerEntry(options.harness ?? 'generic', name, raw, options);
}

function opencodeCommandAndArgs(raw: Record<string, unknown>): { command: string | null; args: string[] } {
  const value = raw.command;
  if (Array.isArray(value)) {
    const parts = value.map((part) => String(part));
    if (parts.length === 0) return { command: null, args: [] };
    return { command: parts[0] ?? null, args: parts.slice(1) };
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return { command: value, args: argsOf(raw) };
  }
  return { command: null, args: [] };
}

function opencodeRemoteTransport(raw: Record<string, unknown>): HarnessTransport {
  const explicit = typeof raw.transport === 'string' ? raw.transport.toLowerCase() : null;
  if (explicit !== null && isHarnessTransport(explicit) && explicit !== 'stdio') return explicit;
  return 'http';
}

/**
 * opencode (`~/.config/opencode/opencode.json`) entry normalizer.
 *
 * `local` commands are usually string arrays (`["npx", "-y", "pkg"]`); `remote`
 * entries carry a URL plus headers. `environment` is the documented env field,
 * with `env` accepted as a fallback; names are reported, values never are.
 */
export function normalizeOpencodeEntry(name: string, raw: unknown, options: NormalizeEntryOptions = {}): HarnessEntry | null {
  if (!isRecord(raw)) return null;
  const harness = options.harness ?? 'opencode';
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : null;
  const enabled = options.enabled ?? raw.enabled !== false;
  const envKeys = envKeysOf(raw, ['environment', 'env']);

  if (type === 'local') {
    const { command, args } = opencodeCommandAndArgs(raw);
    return {
      id: `${harness}:${name}`,
      harness,
      name,
      transport: 'stdio',
      command,
      args,
      url: null,
      envKeys,
      envFile: options.envFile ?? null,
      headerKeys: [],
      enabled,
    };
  }

  if (type === 'remote' || (type === null && !raw.command && typeof raw.url === 'string')) {
    const url = typeof raw.url === 'string' && raw.url.trim() !== '' ? raw.url : null;
    return {
      id: `${harness}:${name}`,
      harness,
      name,
      transport: opencodeRemoteTransport(raw),
      command: null,
      args: [],
      url,
      envKeys,
      envFile: options.envFile ?? null,
      headerKeys: headerKeysOf(raw),
      enabled,
    };
  }

  // Unknown/absent `type`: fall back to the shared command/url heuristics.
  const entry = normalizeServerEntry(harness, name, raw, {
    ...options,
    envFieldNames: ['environment', 'env'],
  });
  if (entry) entry.enabled = enabled;
  return entry;
}

// ---------------------------------------------------------------------------
// Adapter implementations
// ---------------------------------------------------------------------------

function scanMcpServersAdapter(
  adapter: Pick<HarnessAdapter, 'id' | 'label' | 'defaultPath' | 'pathEnvVar'>,
  context: HarnessScanContext,
  normalize: (name: string, raw: unknown) => HarnessEntry | null,
  configPathOverride?: string,
): HarnessAdapterScan {
  const configPath = configPathOverride ?? resolveConfigPath(adapter as HarnessAdapter, context);
  const loaded = loadJsonConfig(configPath);
  if (loaded.error) return failedScan(adapter, configPath, loaded.exists, loaded.error);

  const parsed = mcpServersOf(loaded.config, configPath);
  if (parsed.error) return failedScan(adapter, configPath, loaded.exists, parsed.error);

  const entries: HarnessEntry[] = [];
  for (const [name, raw] of Object.entries(parsed.servers)) {
    const entry = normalize(name, raw);
    if (entry) entries.push(entry);
  }
  return { source: sourceInfo(adapter, configPath, true, entries.length), entries };
}

const claudeAdapter: HarnessAdapter = {
  id: 'claude',
  label: 'Claude Code',
  defaultPath: '~/.claude.json',
  pathEnvVar: 'MCP_DISCOVERY_CLAUDE_CONFIG',
  scan(context = {}) {
    return scanMcpServersAdapter(claudeAdapter, normalizeScanContext(context), (name, raw) => normalizeClaudeEntry(name, raw));
  },
};

function opencodeEnvFile(configPath: string, context: HarnessScanContext): string | null {
  if (!configPath) return null;
  const override = context.env[OPENCODE_ENV_FILE_ENV_VAR];
  const candidate =
    typeof override === 'string' && override.trim() !== ''
      ? expandHome(override.trim(), context.homeDir)
      : join(dirname(configPath), OPENCODE_ENV_FILE_NAME);
  const absolute = isAbsolute(candidate) ? candidate : resolve(candidate);
  return existsSync(absolute) ? absolute : null;
}

const opencodeAdapter: HarnessAdapter = {
  id: 'opencode',
  label: 'opencode',
  defaultPath: '~/.config/opencode/opencode.json',
  pathEnvVar: 'MCP_DISCOVERY_OPENCODE_CONFIG',
  scan(context = {}) {
    const ctx = normalizeScanContext(context);
    const configPath = resolveConfigPath(opencodeAdapter, ctx);
    const loaded = loadJsonConfig(configPath);
    if (loaded.error) return failedScan(opencodeAdapter, configPath, loaded.exists, loaded.error);
    if (!isRecord(loaded.config)) {
      return failedScan(opencodeAdapter, configPath, true, `Config file does not contain a JSON object: ${configPath}`);
    }
    const mcp = loaded.config.mcp;
    if (mcp !== undefined && !isRecord(mcp)) {
      return failedScan(opencodeAdapter, configPath, true, `'mcp' in ${configPath} must be an object`);
    }
    const envFile = opencodeEnvFile(configPath, ctx);
    const servers = isRecord(mcp) ? mcp : {};
    const entries: HarnessEntry[] = [];
    for (const [name, raw] of Object.entries(servers)) {
      const entry = normalizeOpencodeEntry(name, raw, { envFile });
      if (entry) entries.push(entry);
    }
    return { source: sourceInfo(opencodeAdapter, configPath, true, entries.length), entries };
  },
};

const openmausbotAdapter: HarnessAdapter = {
  id: 'openmausbot',
  label: 'OpenMausBot',
  defaultPath: '~/.openmausbot/config.json',
  pathEnvVar: 'MCP_DISCOVERY_OPENMAUSBOT_CONFIG',
  scan(context = {}) {
    return scanMcpServersAdapter(openmausbotAdapter, normalizeScanContext(context), (name, raw) =>
      normalizeOpenmausbotEntry(name, raw),
    );
  },
};

const genericAdapter: HarnessAdapter = {
  id: 'generic',
  label: 'Generic JSON config',
  defaultPath: '',
  pathEnvVar: 'MCP_DISCOVERY_CONFIG',
  scan(context = {}) {
    const ctx = normalizeScanContext(context);
    const configPath = resolveConfigPath(genericAdapter, ctx);
    if (!configPath) {
      return failedScan(genericAdapter, '', false, 'MCP_DISCOVERY_CONFIG is not set');
    }
    return scanMcpServersAdapter(genericAdapter, ctx, (name, raw) => normalizeGenericEntry(name, raw), configPath);
  },
};

/** Built-in adapters in presentation order. */
export const HARNESS_ADAPTERS: readonly HarnessAdapter[] = [
  claudeAdapter,
  opencodeAdapter,
  openmausbotAdapter,
  genericAdapter,
];

/** Built-in adapter ids (stable order, for validation/error messages). */
export const HARNESS_ADAPTER_IDS: readonly HarnessAdapterId[] = HARNESS_ADAPTERS.map((adapter) => adapter.id);

// ---------------------------------------------------------------------------
// Scan-all entry point
// ---------------------------------------------------------------------------

/**
 * Scans every built-in adapter (or the requested subset).
 *
 * A failure in one adapter is reported in `errors` and never throws, so a UI can
 * render the working harnesses while showing the broken one.
 */
export function scanAllHarnessesSync(options: ScanAllOptions = {}): HarnessScanResult {
  const context = normalizeScanContext({ homeDir: options.homeDir, env: options.env });
  const adapters = options.adapters ?? HARNESS_ADAPTERS;
  const requested = options.harnessIds?.map((id) => String(id)).filter((id) => id.length > 0);

  const sources: HarnessSourceInfo[] = [];
  const entries: HarnessEntry[] = [];
  const errors: HarnessScanResult['errors'] = [];

  for (const adapter of adapters) {
    if (requested && !requested.includes(adapter.id)) continue;
    const result = adapter.scan(context);
    sources.push(result.source);
    entries.push(...result.entries);
    if (result.error) errors.push({ harness: adapter.id, error: result.error });
  }

  if (requested) {
    const known = new Set(adapters.map((adapter) => adapter.id));
    for (const id of requested) {
      if (!known.has(id as HarnessAdapterId)) errors.push({ harness: id, error: `Unknown harness adapter '${id}'` });
    }
  }

  return { sources, entries, errors };
}

/** Async wrapper around {@link scanAllHarnessesSync} (filesystem reads are local/fast). */
export function scanAllHarnesses(options: ScanAllOptions = {}): Promise<HarnessScanResult> {
  return Promise.resolve(scanAllHarnessesSync(options));
}
