import { resolve } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error', 'silent'];

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
  };
}
