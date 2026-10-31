import { resolve } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error', 'silent'];

/** Approval-gated computer-use tools unless MCP_COMPUTER_APPROVAL_REQUIRED_TOOLS overrides. */
const DEFAULT_COMPUTER_APPROVAL_TOOLS: readonly string[] = ['destroy_computer', 'device_exec'];

/**
 * Computer Broker (computer use) configuration.
 *
 * The broker is an external, self-hosted service (`broker/mcp.py` exposes
 * Streamable-HTTP MCP at `/mcp`). The gateway fronts it as a managed MCP
 * server named `computer-use`; the operator token is never persisted with the
 * server row — it comes from this env config or the encrypted vault.
 */
export interface ComputerUseConfig {
  /** Master switch (MCP_COMPUTER_USE_ENABLED, default true). */
  enabled: boolean;
  /** Server-side broker base URL, e.g. https://127.0.0.1:7443. */
  brokerUrl: string | null;
  /** Optional bearer token for the broker agent API (env bootstrap). */
  brokerToken: string | null;
  /** Browser-facing broker base URL for "open live desktop" links. */
  publicBrokerUrl: string | null;
  /** Optional PEM CA bundle for the broker's self-signed certificate. */
  caFile: string | null;
  /**
   * Base URL baked into one-line host installers (MCP_COMPUTER_INSTALL_BASE_URL).
   * This is the address the new PC must use to reach the broker — typically the
   * gateway/broker's future LAN address, e.g. https://10.10.1.4:7443. Falls back
   * to the public broker URL when unset.
   */
  installBaseUrl: string | null;
  /**
   * Computer-use tools that additionally require a supervisor approval ticket
   * (MCP_COMPUTER_APPROVAL_REQUIRED_TOOLS, comma-separated). Defaults to
   * `destroy_computer,device_exec`; an explicitly empty value disables all
   * per-call approvals. The managed server row is rebuilt from this on every
   * boot/sync, so changing it in SQLite alone does not survive.
   */
  approvalRequiredTools?: string[];
}

export interface GatewayConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  /** Directory served as the compiled Web UI bundle. */
  uiDistDir: string;
  /** Vault master secret (32+ chars) used to derive the AES-256-GCM key. */
  vaultSecret: string | null;
  /** Optional bootstrap master key created on first boot when no keys exist. */
  bootstrapMasterKey: string | null;
  /** Max delegation recursion depth (spec default: 3). */
  delegationMaxDepth: number;
  /** Allowed prefixes for git import clone URLs; empty array disables imports. */
  gitImportAllowedPrefixes: string[];
  /** Directory where imported sub-server repositories are cloned. */
  reposDir: string;
  logLevel: LogLevel;
  requestBodyLimitBytes: number;
  defaultToolTimeoutMs: number;
  /** Optional HMAC pepper mixed into API key hashes. */
  keyPepper: string | null;
  /** Servers to start with the gateway: 'all' or a comma-separated name list. */
  autostart?: string;
  /** Built-in Web UI login (defaults resolved by loadConfig). */
  uiUsername?: string;
  uiPassword?: string | null;
  uiSessionTtlMs?: number;
  /** Set Secure on the session cookie when served over HTTPS. */
  uiCookieSecure?: boolean;
  publicBaseUrl: string;
  /** Computer use (Computer Broker integration); absent means disabled/unconfigured. */
  computerUse?: ComputerUseConfig;
}

function intFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const dataDir = resolve(env.MCP_DATA_DIR ?? 'data');
  const port = intFromEnv(env.MCP_PORT ?? env.PORT, 8080);
  const host = env.MCP_HOST ?? '0.0.0.0';

  const rawLevel = (env.MCP_LOG_LEVEL ?? 'info').toLowerCase();
  const logLevel: LogLevel = (LOG_LEVELS.includes(rawLevel) ? rawLevel : 'info') as LogLevel;

  const allowedPrefixes = boolList(env.MCP_GIT_IMPORT_ALLOWED_PREFIXES);
  // Sensible secure default: only GitHub HTTPS clone URLs. Empty config keeps imports off.
  const gitImportAllowedPrefixes =
    allowedPrefixes.length > 0
      ? allowedPrefixes
      : env.MCP_ENABLE_GIT_IMPORT === 'true'
        ? ['https://github.com/']
        : [];

  return {
    host,
    port,
    dataDir,
    dbPath: resolve(env.MCP_DB_PATH ?? `${dataDir}/gateway.db`),
    uiDistDir: resolve(env.MCP_UI_DIST ?? 'ui/dist'),
    vaultSecret: env.MCP_VAULT_SECRET ?? null,
    bootstrapMasterKey: env.MCP_MASTER_KEY ?? null,
    delegationMaxDepth: intFromEnv(env.MCP_DELEGATION_MAX_DEPTH, 3),
    gitImportAllowedPrefixes,
    reposDir: resolve(env.MCP_REPOS_DIR ?? `${dataDir}/repos`),
    logLevel,
    requestBodyLimitBytes: intFromEnv(env.MCP_BODY_LIMIT_BYTES, 1_048_576),
    defaultToolTimeoutMs: intFromEnv(env.MCP_TOOL_TIMEOUT_MS, 60_000),
    keyPepper: env.MCP_KEY_PEPPER ?? null,
    autostart: env.MCP_AUTOSTART ?? '',
    uiUsername: env.MCP_UI_USERNAME ?? 'admin',
    uiPassword: env.MCP_UI_PASSWORD ?? null,
    uiSessionTtlMs: intFromEnv(env.MCP_UI_SESSION_TTL_MS, 12 * 60 * 60 * 1000),
    uiCookieSecure: env.MCP_UI_COOKIE_SECURE === 'true',
    publicBaseUrl: env.MCP_PUBLIC_BASE_URL ?? `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`,
    computerUse: loadComputerUse(env),
  };
}

/**
 * Reads the MCP_COMPUTER_* block. `enabled` defaults to true so that a broker
 * URL (plus token) is enough to switch the feature on. Setting
 * MCP_COMPUTER_USE_ENABLED=false (or disabling it in the console) removes the
 * managed `computer-use` server row entirely, so its tools disappear from
 * discovery and cannot be called.
 */
function loadComputerUse(env: NodeJS.ProcessEnv): ComputerUseConfig {
  const brokerUrl = trimOrNull(env.MCP_COMPUTER_BROKER_URL);
  const publicBrokerUrl = trimOrNull(env.MCP_COMPUTER_BROKER_PUBLIC_URL) ?? brokerUrl;
  return {
    enabled: env.MCP_COMPUTER_USE_ENABLED !== 'false',
    brokerUrl,
    brokerToken: trimOrNull(env.MCP_COMPUTER_BROKER_TOKEN),
    publicBrokerUrl,
    caFile: trimOrNull(env.MCP_COMPUTER_BROKER_CA),
    installBaseUrl: httpBaseUrlOrNull(env.MCP_COMPUTER_INSTALL_BASE_URL, 'MCP_COMPUTER_INSTALL_BASE_URL'),
    approvalRequiredTools:
      env.MCP_COMPUTER_APPROVAL_REQUIRED_TOOLS === undefined
        ? [...DEFAULT_COMPUTER_APPROVAL_TOOLS]
        : boolList(env.MCP_COMPUTER_APPROVAL_REQUIRED_TOOLS),
  };
}

/** Optional base URL: trimmed, validated as absolute http(s), trailing slashes removed. */
function httpBaseUrlOrNull(value: string | undefined, name: string): string | null {
  const trimmed = trimOrNull(value);
  if (trimmed === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`);
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`${name} must be a base URL without a path, query or fragment`);
  }
  return trimmed.replace(/\/+$/, '');
}

function trimOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
