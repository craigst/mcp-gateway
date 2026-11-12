/**
 * Instagram session/proxy management for the gateway console.
 *
 * The Instagram MCP server and watcher need a saved instagrapi session file and
 * the UK pi5 egress proxy. This API lets an operator paste a fresh sessionid
 * into the Web UI without touching the container filesystem. The token is
 * passed to the Instagram CLI over stdin and is never returned.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { ErrorCodes, GatewayError, accessDenied, invalidParams } from '../core/errors.js';
import type { GatewayConfig } from '../core/config.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { VaultService } from '../core/ports.js';
import type { AuthenticatedKey, ServerRecord } from '../core/types.js';
import { readJsonBody } from '../gateway/server.js';
import type { AdminSubRouter } from '../admin/types.js';
import { generateTotp, normalizeTotpSecret, totpRemainingSeconds } from './totp.js';

const AREA = 'social';
const AUTO_SETTINGS_KEY = 'instagram:autoRefresh';
const PASSWORD_SECRET = 'INSTAGRAM_PASSWORD';
const TOTP_SECRET = 'INSTAGRAM_TOTP_SECRET';

export interface InstagramApiDeps {
  config: GatewayConfig;
  /** Settings row (`instagram:autoRefresh`) lives in the gateway database. */
  db: DatabaseSync;
  /** Password + 2FA seed live in the encrypted vault, never on disk. */
  vault: VaultService;
  authenticate?: (req: IncomingMessage) => AuthenticatedKey;
  listServers: () => ServerRecord[];
  restartServer: (name: string) => Promise<void>;
  logger?: Logger;
}

interface AutoRefreshSettings {
  enabled: boolean;
  username: string;
  /** Floor between attempts, so a dead session cannot cause a login loop. */
  minIntervalHours: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

interface AutoRefreshStatus extends AutoRefreshSettings {
  hasPassword: boolean;
  hasTotp: boolean;
  vaultEnabled: boolean;
  /** When another automatic attempt becomes possible. */
  nextEligibleAt: string | null;
  /** Seconds left on the current TOTP step, for the console hint. */
  totpSecondsRemaining: number;
}

const DEFAULT_AUTO_REFRESH: AutoRefreshSettings = {
  enabled: false,
  username: '',
  minIntervalHours: 12,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastErrorAt: null,
};

interface SessionInfo {
  sessionFile: string;
  configured: boolean;
  bytes: number;
  modifiedAt: string | null;
  proxyConfigured: boolean;
  proxyHost: string | null;
  /**
   * Whether the saved session still works. The Instagram connector keeps
   * `last_ok_at` / `last_error_at` in its state file on every call, so a stale
   * session shows as `expired` even though the file is still on disk.
   */
  status: 'valid' | 'expired' | 'unknown';
  lastError: string | null;
  lastErrorAt: string | null;
  lastOkAt: string | null;
  lastLoginAt: string | null;
  username: string | null;
  /** Set only when a live check ran (`GET ?verify=1`). */
  verifiedAt: string | null;
  verifyError: string | null;
}

function envPath(dataDir: string, name: string): string {
  return join(dataDir, 'secrets', name);
}

function readEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

function writeEnvValue(path: string, key: string, value: string): void {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  const filtered = lines.filter((line) => !line.startsWith(`${key}=`));
  filtered.push(`${key}=${value}`);
  writeFileSync(path, `${filtered.filter((line) => line !== '').join('\n')}\n`, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Parse an ISO instant; anything unparseable is treated as absent. */
function instant(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function readState(dataDir: string): Record<string, unknown> {
  const path = join(dataDir, 'secrets', 'instagram', 'state.json');
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The connector's own verdict: an error newer than the last success is expired. */
function statusFromState(state: Record<string, unknown>): 'valid' | 'expired' | 'unknown' {
  const okAt = instant(stringOrNull(state.last_ok_at));
  const errorAt = instant(stringOrNull(state.last_error_at));
  if (errorAt !== null && (okAt === null || errorAt >= okAt)) return 'expired';
  if (okAt !== null) return 'valid';
  return 'unknown';
}

/** The Instagram CLI pretty-prints JSON; tolerate stray log lines around it. */
function parseCliJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const candidates = [trimmed];
  const start = trimmed.indexOf('{');
  if (start > 0) candidates.push(trimmed.slice(start));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
    } catch { /* try the next candidate */ }
  }
  return null;
}

function sessionInfo(dataDir: string): SessionInfo {
  const sessionFile = join(dataDir, 'secrets', 'instagram', 'session.json');
  const env = readEnv(envPath(dataDir, 'instagram.env'));
  const proxy = env.IG_PROXY ?? '';
  const state = readState(dataDir);
  const status = statusFromState(state);
  const stateFields = {
    status,
    lastError: stringOrNull(state.last_error),
    lastErrorAt: stringOrNull(state.last_error_at),
    lastOkAt: stringOrNull(state.last_ok_at),
    lastLoginAt: stringOrNull(state.last_login_at),
    username: stringOrNull(state.username),
    verifiedAt: null,
    verifyError: null,
  };
  let proxyHost: string | null = null;
  try {
    const parsed = new URL(proxy);
    proxyHost = `${parsed.hostname}:${parsed.port || '1080'}`;
  } catch { /* not configured */ }
  if (!existsSync(sessionFile)) {
    return {
      sessionFile,
      configured: false,
      bytes: 0,
      modifiedAt: null,
      proxyConfigured: proxy.length > 0,
      proxyHost,
      ...stateFields,
      // A session file that is gone outranks any remembered success.
      status: 'unknown',
    };
  }
  const stat = statSync(sessionFile);
  return {
    sessionFile,
    configured: stat.size > 200,
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    proxyConfigured: proxy.length > 0,
    proxyHost,
    ...stateFields,
  };
}


export class InstagramApi implements AdminSubRouter {
  private readonly logger: Logger;
  private autoRunning = false;
  private refreshRunning = false;
  private autoTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: InstagramApiDeps) {
    this.logger = deps.logger ?? createLogger('admin.instagram');
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const segments = url.pathname.replace(/^\/mcp\/v1\/admin\/?/, '').split('/').filter(Boolean);
    if (segments[0] !== AREA || segments[1] !== 'instagram') return false;
    const rest = segments.slice(2);
    const method = (req.method ?? 'GET').toUpperCase();
    try {
      this.requireMaster(req);
      if (rest.length === 0 && method === 'GET') {
        const before = sessionInfo(this.deps.config.dataDir);
        // Cheap by default (state file). `?verify=1` asks Instagram directly —
        // that takes a few seconds, so the console only does it on Refresh.
        if (url.searchParams.get('verify') === '1') {
          const live = await this.verify();
          // The CLI writes its own last_ok/last_error, so re-read afterwards.
          this.sendJson(res, 200, {
            session: { ...sessionInfo(this.deps.config.dataDir), ...live },
            autoRefresh: this.autoStatus(),
          });
          return true;
        }
        this.sendJson(res, 200, { session: before, autoRefresh: this.autoStatus() });
        return true;
      }
      if (rest.length === 1 && rest[0] === 'session' && method === 'POST') {
        const body = (await readJsonBody(req, this.deps.config.requestBodyLimitBytes)) as Record<string, unknown>;
        const sessionid = typeof body.sessionid === 'string' ? body.sessionid.trim() : '';
        const userId = typeof body.userId === 'string' ? body.userId.trim() : '268219632';
        if (sessionid.length < 20) throw invalidParams('sessionid is required');
        if (!/^\d+$/.test(userId)) throw invalidParams('userId must be numeric');
        const result = await this.login(sessionid, userId);
        if (!result.ok) throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, result.message, { httpStatus: 400, data: { status: 'INSTAGRAM_LOGIN_FAILED' } });
        await this.restart('instagram');
        await this.restart('social-watchers');
        this.sendJson(res, 200, {
          ok: true,
          session: sessionInfo(this.deps.config.dataDir),
          autoRefresh: this.autoStatus(),
        });
        return true;
      }
      if (rest.length === 1 && rest[0] === 'proxy' && method === 'POST') {
        const body = (await readJsonBody(req, this.deps.config.requestBodyLimitBytes)) as Record<string, unknown>;
        const proxy = typeof body.proxy === 'string' ? body.proxy.trim() : '';
        if (!/^(socks5h?|https?):\/\//i.test(proxy)) throw invalidParams('proxy must be a socks5h:// or http(s):// URL');
        const instagramEnv = envPath(this.deps.config.dataDir, 'instagram.env');
        const watcherEnv = envPath(this.deps.config.dataDir, 'remy-watchers.env');
        writeEnvValue(instagramEnv, 'IG_PROXY', proxy);
        writeEnvValue(watcherEnv, 'IG_PROXY', proxy);
        await this.restart('instagram');
        await this.restart('social-watchers');
        this.sendJson(res, 200, {
          ok: true,
          session: sessionInfo(this.deps.config.dataDir),
          autoRefresh: this.autoStatus(),
        });
        return true;
      }
      if (rest.length === 1 && rest[0] === 'autorefresh' && method === 'POST') {
        const body = (await readJsonBody(req, this.deps.config.requestBodyLimitBytes)) as Record<string, unknown>;
        const patch: Partial<AutoRefreshSettings> = {};
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
        if (typeof body.username === 'string') patch.username = body.username.trim().replace(/^@/, '');
        if (typeof body.minIntervalHours === 'number' && Number.isFinite(body.minIntervalHours)) {
          patch.minIntervalHours = Math.min(168, Math.max(1, Math.round(body.minIntervalHours)));
        }
        const wantsSecret =
          body.password !== undefined || body.totpSecret !== undefined ||
          body.clearPassword === true || body.clearTotp === true;
        const wasEnabled = this.readAuto().enabled;
        let secretsChanged = false;
        if (wantsSecret && !this.vaultEnabled()) {
          throw invalidParams('The gateway vault is not configured, so credentials cannot be stored.');
        }
        if (body.clearPassword === true) {
          this.deps.vault.deleteSecret(PASSWORD_SECRET);
          secretsChanged = true;
        } else if (typeof body.password === 'string' && body.password.length > 0) {
          this.deps.vault.setSecret(PASSWORD_SECRET, body.password);
          secretsChanged = true;
        }
        if (body.clearTotp === true) {
          this.deps.vault.deleteSecret(TOTP_SECRET);
          secretsChanged = true;
        } else if (typeof body.totpSecret === 'string' && body.totpSecret.length > 0) {
          const normalized = normalizeTotpSecret(body.totpSecret);
          if (!/^[A-Z2-7]{8,}$/.test(normalized)) {
            throw invalidParams('2FA secret must be the base32 authenticator key (e.g. JBSWY3DPEHPK3PXP).');
          }
          this.deps.vault.setSecret(TOTP_SECRET, normalized);
          secretsChanged = true;
        }
        const enabling = body.enabled === true && !wasEnabled;
        if (enabling || secretsChanged) patch.lastAttemptAt = null;
        const saved = this.writeAuto(patch);
        this.logger.info('instagram auto-refresh settings saved', {
          enabled: saved.enabled,
          username: saved.username,
          minIntervalHours: saved.minIntervalHours,
        });
        this.sendJson(res, 200, {
          ok: true,
          autoRefresh: this.autoStatus(),
          session: sessionInfo(this.deps.config.dataDir),
        });
        return true;
      }
      if (rest.length === 1 && rest[0] === 'login' && method === 'POST') {
        const body = (await readJsonBody(req, this.deps.config.requestBodyLimitBytes)) as Record<string, unknown>;
        const overrides: { username?: string; password?: string; totpSecret?: string } = {};
        if (typeof body.username === 'string' && body.username.trim() !== '') {
          overrides.username = body.username.trim().replace(/^@/, '');
        }
        if (typeof body.password === 'string' && body.password !== '') overrides.password = body.password;
        if (typeof body.totpSecret === 'string' && body.totpSecret !== '') overrides.totpSecret = body.totpSecret;
        const result = await this.refreshSession(overrides);
        if (!result.ok) {
          throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, result.message, {
            httpStatus: 400,
            data: { status: 'INSTAGRAM_LOGIN_FAILED' },
          });
        }
        this.sendJson(res, 200, {
          ok: true,
          username: result.username,
          autoRefresh: this.autoStatus(),
          session: sessionInfo(this.deps.config.dataDir),
        });
        return true;
      }
      throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Unknown Instagram endpoint', { httpStatus: 404 });
    } catch (error) {
      const gatewayError = error instanceof GatewayError
        ? error
        : new GatewayError(ErrorCodes.INTERNAL_ERROR, error instanceof Error ? error.message : String(error), { httpStatus: 500 });
      this.logger.debug('instagram request failed', { path: url.pathname, code: gatewayError.code });
      this.sendJson(res, gatewayError.httpStatus, { error: gatewayError.toJSONRpcError() });
      return true;
    }
  }

  // -- automatic re-login -------------------------------------------------

  private vaultEnabled(): boolean {
    try {
      return this.deps.vault.isEnabled();
    } catch {
      return false;
    }
  }

  private readAuto(): AutoRefreshSettings {
    const row = this.deps.db.prepare('SELECT value FROM settings WHERE key = ?').get(AUTO_SETTINGS_KEY) as
      | { value?: unknown }
      | undefined;
    if (typeof row?.value !== 'string' || row.value === '') return { ...DEFAULT_AUTO_REFRESH };
    try {
      const saved = JSON.parse(row.value) as Partial<AutoRefreshSettings>;
      return {
        ...DEFAULT_AUTO_REFRESH,
        ...saved,
        username: typeof saved.username === 'string' ? saved.username : '',
        minIntervalHours:
          typeof saved.minIntervalHours === 'number' && Number.isFinite(saved.minIntervalHours)
            ? Math.min(168, Math.max(1, Math.round(saved.minIntervalHours)))
            : DEFAULT_AUTO_REFRESH.minIntervalHours,
      };
    } catch {
      return { ...DEFAULT_AUTO_REFRESH };
    }
  }

  private writeAuto(patch: Partial<AutoRefreshSettings>): AutoRefreshSettings {
    const next = { ...this.readAuto(), ...patch };
    this.deps.db
      .prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(AUTO_SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  private autoStatus(): AutoRefreshStatus {
    const auto = this.readAuto();
    const vaultEnabled = this.vaultEnabled();
    const hasPassword = vaultEnabled && this.deps.vault.getSecret(PASSWORD_SECRET) !== null;
    const hasTotp = vaultEnabled && this.deps.vault.getSecret(TOTP_SECRET) !== null;
    const lastAttempt = auto.lastAttemptAt === null ? null : Date.parse(auto.lastAttemptAt);
    const minMs = Math.max(1, auto.minIntervalHours) * 3_600_000;
    const nextEligibleAt =
      lastAttempt !== null && Number.isFinite(lastAttempt) ? new Date(lastAttempt + minMs).toISOString() : null;
    return {
      ...auto,
      hasPassword,
      hasTotp,
      vaultEnabled,
      nextEligibleAt,
      totpSecondsRemaining: totpRemainingSeconds(),
    };
  }

  private cliEnv(): { python: string; cwd: string; env: Record<string, string | undefined> } {
    const dataDir = this.deps.config.dataDir;
    return {
      python: join(dataDir, 'repos', 'instagram-mcp', '.venv', 'bin', 'python'),
      cwd: join(dataDir, 'repos', 'instagram-mcp'),
      env: {
        ...process.env,
        ...readEnv(envPath(dataDir, 'instagram.env')),
        IG_CONFIG_DIR: join(dataDir, 'secrets', 'instagram'),
      },
    };
  }

  /** Full login from the vault credentials; the password goes in on stdin. */
  private loginWithVault(
    overrides: { username?: string; password?: string; totpSecret?: string } = {},
  ): Promise<{ ok: boolean; message: string; username: string | null }> {
    const auto = this.readAuto();
    const vaultEnabled = this.vaultEnabled();
    const username = (overrides.username ?? auto.username).trim().replace(/^@/, '');
    const password =
      overrides.password ?? (vaultEnabled ? this.deps.vault.getSecret(PASSWORD_SECRET) ?? '' : '');
    const totpSecret =
      overrides.totpSecret ?? (vaultEnabled ? this.deps.vault.getSecret(TOTP_SECRET) ?? '' : '');
    if (!username) return Promise.resolve({ ok: false, message: 'No Instagram username is saved.', username: null });
    if (!password) return Promise.resolve({ ok: false, message: 'No Instagram password is saved.', username });
    if (!totpSecret) return Promise.resolve({ ok: false, message: 'No 2FA secret is saved.', username });

    // Validate the seed locally so a bad paste fails clearly. The CLI then
    // generates the real code at the moment Instagram asks for it: the CAA
    // login flow takes minutes, so a code made here would be stale.
    try {
      generateTotp(totpSecret);
    } catch (error) {
      return Promise.resolve({
        ok: false,
        message: error instanceof Error ? error.message : '2FA secret is invalid.',
        username,
      });
    }

    const { python, cwd, env } = this.cliEnv();
    const childEnv = { ...env, IG_TOTP_SECRET: totpSecret };
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: { ok: boolean; message: string; username: string | null }): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const child = spawn(
        python,
        ['-m', 'instagram_mcp.cli', '--json', 'login', '--username', username, '--password-stdin'],
        { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      // The CAA login flow makes ~10 requests and Instagram answers each in
      // ~30s through the UK proxy; 2FA is generated at submission time, so a
      // long budget is safe and the refresh runs in the background.
      const timer = setTimeout(() => child.kill('SIGKILL'), 600_000);
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', (error) => {
        clearTimeout(timer);
        finish({ ok: false, message: `could not start the Instagram CLI: ${error.message}`, username });
      });
      child.on('exit', (exitCode) => {
        clearTimeout(timer);
        const parsed = parseCliJson(stdout);
        if (exitCode === 0 && parsed?.ok === true) {
          // The CLI also writes a plaintext credentials file. The vault is the
          // single home for the password, so drop that copy.
          const credFile = join(this.deps.config.dataDir, 'secrets', 'instagram', 'credentials.json');
          try {
            if (existsSync(credFile)) unlinkSync(credFile);
          } catch { /* best effort */ }
          finish({ ok: true, message: 'ok', username: stringOrNull(parsed.username) ?? username });
          return;
        }
        const message =
          stringOrNull(parsed?.message) ??
          stringOrNull(parsed?.error) ??
          stderr.trim().split('\n').filter(Boolean).pop() ??
          `login exited ${String(exitCode)}`;
        finish({ ok: false, message: message.slice(0, 300), username });
      });
      child.stdin.end(password);
    });
  }

  /** Attempt a login, record the outcome, and restart the clients that cache the session. */
  private async refreshSession(
    overrides: { username?: string; password?: string; totpSecret?: string } = {},
  ): Promise<{ ok: boolean; message: string; username: string | null }> {
    if (this.refreshRunning) {
      return { ok: false, message: 'Another Instagram login is already running.', username: null };
    }
    this.refreshRunning = true;
    const attemptedAt = new Date().toISOString();
    this.writeAuto({ lastAttemptAt: attemptedAt });
    try {
      const result = await this.loginWithVault(overrides);
      if (result.ok) {
        // The CLI writes the session file but not the connector's "last OK"
        // marker, so run the cheap live check to flip the console to valid
        // immediately instead of waiting for the next tool call.
        await this.verify();
        this.writeAuto({ lastSuccessAt: attemptedAt, lastError: null, lastErrorAt: null });
        await this.restart('instagram');
        await this.restart('social-watchers');
        this.logger.info('instagram session refreshed from stored credentials', { username: result.username });
      } else {
        this.writeAuto({ lastError: result.message, lastErrorAt: attemptedAt });
        this.logger.warn('instagram session refresh failed', { message: result.message });
      }
      return result;
    } finally {
      this.refreshRunning = false;
    }
  }

  /**
   * Check every 15 minutes. A valid session is never touched, and the stored
   * floor (default 12 h) means even a dead session cannot cause a login loop.
   */
  startAutoRefresh(intervalMs = 15 * 60_000): void {
    if (this.autoTimer !== null) return;
    this.autoTimer = setInterval(() => { void this.maybeAutoRefresh(); }, intervalMs);
    this.autoTimer.unref();
    // One early check after a restart, so a dead session does not wait a full tick.
    const first = setTimeout(() => { void this.maybeAutoRefresh(); }, 60_000);
    first.unref();
    this.logger.info('instagram auto-refresh scheduler started', { intervalMs });
  }

  private async maybeAutoRefresh(): Promise<void> {
    if (this.autoRunning) return;
    const auto = this.readAuto();
    if (!auto.enabled || !this.vaultEnabled()) return;
    if (this.deps.vault.getSecret(PASSWORD_SECRET) === null || this.deps.vault.getSecret(TOTP_SECRET) === null) return;
    if (sessionInfo(this.deps.config.dataDir).status === 'valid') return;
    const lastAttempt = auto.lastAttemptAt === null ? null : Date.parse(auto.lastAttemptAt);
    const minMs = Math.max(1, auto.minIntervalHours) * 3_600_000;
    if (lastAttempt !== null && Number.isFinite(lastAttempt) && Date.now() - lastAttempt < minMs) return;
    this.autoRunning = true;
    try {
      await this.refreshSession();
    } finally {
      this.autoRunning = false;
    }
  }

  /**
   * Ask Instagram whether the saved session still works (`status --verify`).
   * Returns only the fields the live check can speak to, so the caller merges
   * it over the state-derived snapshot. Never throws: a CLI/network failure is
   * reported as `verifyError` and leaves the status alone.
   */
  private verify(): Promise<Partial<SessionInfo>> {
    const dataDir = this.deps.config.dataDir;
    const python = join(dataDir, 'repos', 'instagram-mcp', '.venv', 'bin', 'python');
    const cwd = join(dataDir, 'repos', 'instagram-mcp');
    const envFile = readEnv(envPath(dataDir, 'instagram.env'));
    const env = { ...process.env, ...envFile, IG_CONFIG_DIR: join(dataDir, 'secrets', 'instagram') };
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: Partial<SessionInfo>): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const child = spawn(python, ['-m', 'instagram_mcp.cli', '--json', 'status', '--verify'], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', (error) => {
        clearTimeout(timer);
        finish({ verifiedAt: new Date().toISOString(), verifyError: `could not start the Instagram CLI: ${error.message}` });
      });
      child.on('exit', () => {
        clearTimeout(timer);
        const verifiedAt = new Date().toISOString();
        const parsed = parseCliJson(stdout);
        if (parsed === null) {
          const detail = stderr.trim().split('\n').filter(Boolean).pop() ?? 'the Instagram CLI returned no JSON';
          finish({ verifiedAt, verifyError: detail.slice(0, 300) });
          return;
        }
        const live = parsed.live === true && parsed.ok === true;
        const error = stringOrNull(parsed.error);
        const result: Partial<SessionInfo> = {
          verifiedAt,
          username: stringOrNull(parsed.username),
          verifyError: live ? null : (stringOrNull(parsed.message) ?? error),
        };
        if (live) result.status = 'valid';
        else if (error === 'login_required') result.status = 'expired';
        finish(result);
      });
    });
  }

  private login(sessionid: string, userId: string): Promise<{ ok: boolean; message: string }> {
    const python = join(this.deps.config.dataDir, 'repos', 'instagram-mcp', '.venv', 'bin', 'python');
    const cwd = join(this.deps.config.dataDir, 'repos', 'instagram-mcp');
    const envFile = readEnv(envPath(this.deps.config.dataDir, 'instagram.env'));
    const env = { ...process.env, ...envFile, IG_CONFIG_DIR: join(this.deps.config.dataDir, 'secrets', 'instagram') };
    return new Promise((resolve) => {
      const child = spawn(python, ['-m', 'instagram_mcp.cli', 'login', '--sessionid', '-', '--user-id', userId], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, message: `Instagram login failed to start: ${error.message}` }); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        const ok = code === 0 && /\bok:\s*True\b/i.test(stdout);
        resolve({ ok, message: ok ? 'ok' : (stderr.split('\n').filter(Boolean).slice(-2).join(' ') || stdout || `exit ${String(code)}`) });
      });
      child.stdin.end(sessionid);
    });
  }

  private async restart(name: string): Promise<void> {
    try {
      const server = this.deps.listServers().find((candidate) => candidate.name === name);
      if (server) await this.deps.restartServer(name);
    } catch (error) {
      this.logger.warn('server restart after Instagram settings failed', { name, message: error instanceof Error ? error.message : String(error) });
    }
  }

  private requireMaster(req: IncomingMessage): AuthenticatedKey {
    if (!this.deps.authenticate) throw accessDenied('Authentication is not configured.');
    const principal = this.deps.authenticate(req);
    if (principal.keyType !== 'master') throw accessDenied('Master privileges are required for Instagram settings.');
    return principal;
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }
}
