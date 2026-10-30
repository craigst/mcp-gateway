import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { ErrorCodes, GatewayError, accessDenied, asGatewayError, invalidParams } from '../core/errors.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { GatewayConfig } from '../core/config.js';
import type { AuditService, KeyService, Supervisor, UiAuthService } from '../core/ports.js';
import type { AuthApi } from '../auth/http.js';
import { authenticateRequest } from '../auth/request-auth.js';
import type { AuthenticatedKey, JsonRpcRequest, JsonRpcResponse, RequestContext } from '../core/types.js';
import type { AdminApi } from '../admin/router.js';
import { createRequestContext, JsonRpcRouter } from './router.js';

const GATEWAY_VERSION = '0.10.1';
const MAX_BATCH_SIZE = 20;

export interface GatewayServerDeps {
  config: GatewayConfig;
  router: JsonRpcRouter;
  admin: AdminApi;
  keys: KeyService;
  uiAuth: UiAuthService;
  authApi: AuthApi;
  supervisor: Supervisor;
  audit: AuditService;
  logger?: Logger;
}

export interface GatewayAddress {
  host: string;
  port: number;
  url: string;
}

/**
 * HTTP/WebSocket ingress: JSON-RPC 2.0 at /mcp/v1, admin REST under
 * /mcp/v1/admin, health/metrics, and the embedded SPA bundle.
 */
export class GatewayHttpServer {
  private server: Server | null = null;
  private readonly wss: WebSocketServer;
  private readonly startedAt = Date.now();
  private readonly logger: Logger;
  private address: GatewayAddress | null = null;

  constructor(private readonly deps: GatewayServerDeps) {
    this.logger = deps.logger ?? createLogger('gateway');
    this.wss = new WebSocketServer({ noServer: true });
  }

  get httpServer(): Server | null {
    return this.server;
  }

  get port(): number {
    return this.address?.port ?? 0;
  }

  async start(): Promise<GatewayAddress> {
    if (this.server) throw new Error('Gateway already started');
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as Socket, head));

    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(this.deps.config.port, this.deps.config.host, () => {
        server.removeListener('error', reject);
        resolvePromise();
      });
    });

    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Failed to bind gateway port');
    const host = this.deps.config.host === '0.0.0.0' ? '127.0.0.1' : this.deps.config.host;
    this.address = { host: this.deps.config.host, port: address.port, url: `http://${host}:${address.port}` };
    this.logger.info('gateway listening', { ...this.address });
    return this.address;
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.close(1001, 'gateway shutting down');
    this.wss.close();
    const server = this.server;
    this.server = null;
    this.address = null;
    if (!server) return;
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    // Terminate any lingering keep-alive sockets.
    server.closeAllConnections?.();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    this.applySecurityHeaders(res);

    try {
      if (url.pathname === '/mcp/v1/auth' || url.pathname.startsWith('/mcp/v1/auth/')) {
        const handled = await this.deps.authApi.handle(req, res, url);
        if (!handled) {
          this.sendError(res, 404, new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Unknown auth endpoint'));
        }
        return;
      }
      if (url.pathname === '/mcp/v1' || url.pathname === '/mcp/v1/') {
        await this.handleRpc(req, res);
        return;
      }
      if (url.pathname === '/mcp/v1/health' && req.method === 'GET') {
        this.sendJson(res, 200, { status: 'ok', version: GATEWAY_VERSION, uptimeMs: Date.now() - this.startedAt });
        return;
      }
      if (url.pathname === '/mcp/v1/metrics') {
        const key = this.authenticate(req);
        void key;
        this.sendJson(res, 200, this.deps.audit.metrics());
        return;
      }
      if (url.pathname.startsWith('/mcp/v1/admin/')) {
        const handled = await this.deps.admin.handle(req, res, url);
        if (!handled) this.sendError(res, 404, new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Unknown admin endpoint'));
        return;
      }
      if (url.pathname.startsWith('/mcp/v1/')) {
        this.sendError(res, 404, new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Unknown endpoint'));
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        await this.serveStatic(url.pathname, req, res);
        return;
      }
      this.sendError(res, 404, new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Not found'));
    } catch (error) {
      const gatewayError = asGatewayError(error);
      this.logger.debug('ingress error', { path: url.pathname, code: gatewayError.code, message: gatewayError.message });
      this.sendError(res, gatewayError.httpStatus, gatewayError);
    }
  }

  // -------------------------------------------------------------------------
  // JSON-RPC
  // -------------------------------------------------------------------------

  private async handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.sendError(res, 405, new GatewayError(ErrorCodes.INVALID_REQUEST, 'Use POST for JSON-RPC'));
      return;
    }
    const contentType = String(req.headers['content-type'] ?? '');
    if (!contentType.includes('application/json')) {
      this.sendError(res, 415, new GatewayError(ErrorCodes.INVALID_REQUEST, 'Content-Type must be application/json'));
      return;
    }

    let key: AuthenticatedKey;
    try {
      key = this.authenticate(req);
    } catch (error) {
      this.sendJsonRpcHttpError(res, 401, asGatewayError(error));
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req, this.deps.config.requestBodyLimitBytes);
    } catch (error) {
      this.sendJsonRpcHttpError(res, 400, asGatewayError(error));
      return;
    }

    const headers = normalizeHeaders(req);
    const clientIp = req.socket.remoteAddress ?? null;

    if (Array.isArray(body)) {
      if (body.length === 0) {
        this.sendJsonRpcHttpError(res, 400, new GatewayError(ErrorCodes.INVALID_REQUEST, 'Empty batch'));
        return;
      }
      if (body.length > MAX_BATCH_SIZE) {
        this.sendJsonRpcHttpError(res, 400, new GatewayError(ErrorCodes.INVALID_REQUEST, `Batch limit is ${MAX_BATCH_SIZE}`));
        return;
      }
      const responses: JsonRpcResponse[] = [];
      for (const item of body) {
        const response = await this.executeRpc(key, headers, clientIp, item);
        if (response) responses.push(response);
      }
      if (responses.length === 0) {
        res.writeHead(204).end();
        return;
      }
      this.sendJson(res, 200, responses);
      return;
    }

    const response = await this.executeRpc(key, headers, clientIp, body);
    if (!response) {
      res.writeHead(204).end();
      return;
    }
    this.sendJson(res, 200, response);
  }

  private async executeRpc(
    key: AuthenticatedKey,
    headers: Record<string, string>,
    clientIp: string | null,
    raw: unknown,
  ): Promise<JsonRpcResponse | null> {
    const ctx: RequestContext = createRequestContext(key, headers, clientIp);
    if (!isJsonRpcRequest(raw)) {
      return {
        jsonrpc: '2.0',
        id: isRecord(raw) && isId(raw.id) ? raw.id : null,
        error: { code: ErrorCodes.INVALID_REQUEST, message: 'Invalid JSON-RPC 2.0 request' },
      };
    }

    const request = raw as JsonRpcRequest;
    const isNotification = request.id === undefined || request.id === null;
    try {
      const result = await this.deps.router.handle(ctx, request);
      if (isNotification) return null;
      return { jsonrpc: '2.0', id: request.id as string | number | null, result };
    } catch (error) {
      const gatewayError = asGatewayError(error);
      if (isNotification) return null;
      return {
        jsonrpc: '2.0',
        id: request.id as string | number | null,
        error: gatewayError.toJSONRpcError(),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  private authenticate(req: IncomingMessage): AuthenticatedKey {
    // Bearer API key (AI/external clients) OR the browser's session cookie.
    return authenticateRequest(req, this.deps.keys, this.deps.uiAuth);
  }

  // -------------------------------------------------------------------------
  // WebSocket live logs
  // -------------------------------------------------------------------------

  private handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/mcp/v1/admin/ws/logs') {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      // Authenticate AFTER the upgrade so browsers observe the documented
      // close code 4401 (they cannot read an HTTP 401 on a failed upgrade).
      let key: AuthenticatedKey;
      try {
        const apiKey = url.searchParams.get('api_key');
        key = apiKey ? this.deps.keys.authenticate(apiKey) : this.authenticate(req);
        if (key.keyType !== 'master' && key.keyType !== 'sup') {
          throw accessDenied('Access Denied: supervisor or master key required for live logs.', {
            reason: 'SCOPE_RESTRICTION',
          });
        }
      } catch {
        ws.close(4401, 'Unauthorized');
        return;
      }

      const serverId = url.searchParams.get('serverId');
      const unsubscribe = this.deps.supervisor.subscribeLogs(serverId, (line) => {
        sendWs(ws, { type: 'log', ...line });
      });
      sendWs(ws, { type: 'hello', serverId, ts: new Date().toISOString() });
      ws.on('close', unsubscribe);
      ws.on('error', unsubscribe);
    });
  }

  // -------------------------------------------------------------------------
  // Static SPA
  // -------------------------------------------------------------------------

  private async serveStatic(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const root = resolve(this.deps.config.uiDistDir);
    const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    let filePath = resolve(join(root, relative === '/' ? 'index.html' : relative));

    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      this.sendError(res, 403, new GatewayError(ErrorCodes.ACCESS_DENIED, 'Forbidden'));
      return;
    }

    let exists = await fileExists(filePath);
    if (!exists || (await isDirectory(filePath))) {
      // SPA fallback: unknown routes render the app shell.
      filePath = join(root, 'index.html');
      exists = await fileExists(filePath);
    }

    if (!exists) {
      const html = fallbackHtml();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(req.method === 'HEAD' ? undefined : html);
      return;
    }

    const content = await readFile(filePath);
    const ext = extname(filePath);
    const cacheControl = pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'content-length': content.byteLength,
      'cache-control': cacheControl,
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private applySecurityHeaders(res: ServerResponse): void {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=()');
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  private sendError(res: ServerResponse, status: number, error: GatewayError): void {
    this.sendJson(res, status, { error: error.toJSONRpcError() });
  }

  private sendJsonRpcHttpError(res: ServerResponse, status: number, error: GatewayError): void {
    this.sendJson(res, status, { jsonrpc: '2.0', id: null, error: error.toJSONRpcError() });
  }
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string | number | null {
  return value === null || typeof value === 'string' || typeof value === 'number';
}

function isJsonRpcRequest(value: unknown): boolean {
  return isRecord(value) && value.jsonrpc === '2.0' && typeof value.method === 'string' && value.method.length > 0;
}

export function normalizeHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers[name.toLowerCase()] = value;
    else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(', ');
  }
  return headers;
}

export async function readJsonBody(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limitBytes) {
      throw new GatewayError(ErrorCodes.INVALID_REQUEST, `Request body exceeds ${limitBytes} bytes`, { httpStatus: 413 });
    }
    chunks.push(buffer);
  }
  if (size === 0) throw invalidParams('Request body is empty');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new GatewayError(ErrorCodes.PARSE_ERROR, 'Parse error: invalid JSON', { httpStatus: 400 });
  }
}

function rejectUpgrade(socket: Socket, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function sendWs(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function fallbackHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>MCP Gateway</title>
<style>body{font-family:ui-sans-serif,system-ui;margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0}main{max-width:36rem;padding:2rem;background:#1e293b;border-radius:1rem}code{background:#0f172a;padding:.15rem .4rem;border-radius:.25rem}</style>
</head><body><main><h1>MCP Gateway is running</h1>
<p>The Web UI bundle has not been built. Run <code>npm run build:ui</code> or use the API directly.</p>
<p>JSON-RPC endpoint: <code>POST /mcp/v1</code> · Health: <code>GET /mcp/v1/health</code></p></main></body></html>`;
}
