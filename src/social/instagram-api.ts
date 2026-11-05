/**
 * Instagram session/proxy management for the gateway console.
 *
 * The Instagram MCP server and watcher need a saved instagrapi session file and
 * the UK pi5 egress proxy. This API lets an operator paste a fresh sessionid
 * into the Web UI without touching the container filesystem. The token is
 * passed to the Instagram CLI over stdin and is never returned.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

import { ErrorCodes, GatewayError, accessDenied, invalidParams } from '../core/errors.js';
import type { GatewayConfig } from '../core/config.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { AuthenticatedKey, ServerRecord } from '../core/types.js';
import { readJsonBody } from '../gateway/server.js';
import type { AdminSubRouter } from '../admin/types.js';

const AREA = 'social';

export interface InstagramApiDeps {
  config: GatewayConfig;
  authenticate?: (req: IncomingMessage) => AuthenticatedKey;
  listServers: () => ServerRecord[];
  restartServer: (name: string) => Promise<void>;
  logger?: Logger;
}

interface SessionInfo {
  sessionFile: string;
  configured: boolean;
  bytes: number;
  modifiedAt: string | null;
  proxyConfigured: boolean;
  proxyHost: string | null;
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

function sessionInfo(dataDir: string): SessionInfo {
  const sessionFile = join(dataDir, 'secrets', 'instagram', 'session.json');
  const env = readEnv(envPath(dataDir, 'instagram.env'));
  const proxy = env.IG_PROXY ?? '';
  let proxyHost: string | null = null;
  try {
    const parsed = new URL(proxy);
    proxyHost = `${parsed.hostname}:${parsed.port || '1080'}`;
  } catch { /* not configured */ }
  if (!existsSync(sessionFile)) {
    return { sessionFile, configured: false, bytes: 0, modifiedAt: null, proxyConfigured: proxy.length > 0, proxyHost };
  }
  const stat = statSync(sessionFile);
  return {
    sessionFile,
    configured: stat.size > 200,
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    proxyConfigured: proxy.length > 0,
    proxyHost,
  };
}

export class InstagramApi implements AdminSubRouter {
  private readonly logger: Logger;

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
        this.sendJson(res, 200, { session: sessionInfo(this.deps.config.dataDir) });
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
        this.sendJson(res, 200, { ok: true, session: sessionInfo(this.deps.config.dataDir) });
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
        this.sendJson(res, 200, { ok: true, session: sessionInfo(this.deps.config.dataDir) });
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
