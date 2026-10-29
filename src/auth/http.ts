/**
 * HTTP sub-handler for the built-in Web UI auth endpoints:
 *
 *   POST /mcp/v1/auth/login      {username,password} -> 200 + session cookie
 *   POST /mcp/v1/auth/logout     -> 200 {ok:true} + cleared cookie
 *   GET  /mcp/v1/auth/me         -> 200 {authenticated:true,user} or 401
 *   POST /mcp/v1/auth/password   {currentPassword,newPassword} -> 200 {ok:true}
 *
 * The handler is mounted ahead of JSON-RPC parsing (it consumes the request body
 * itself) and returns `false` for any path outside `/mcp/v1/auth`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GatewayConfig } from '../core/config.js';
import { ErrorCodes, GatewayError, invalidParams } from '../core/errors.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { UiAuthService, UiSession } from '../core/ports.js';
import { clearSessionCookie, readSessionToken, serializeSessionCookie } from './cookies.js';

export const AUTH_PATH_PREFIX = '/mcp/v1/auth';
const MAX_JSON_BODY_BYTES = 64 * 1024;

export interface AuthApiDependencies {
  uiAuth: UiAuthService;
  config: GatewayConfig;
  logger?: Logger;
}

export class AuthApi {
  private readonly uiAuth: UiAuthService;
  private readonly config: GatewayConfig;
  private readonly logger: Logger;

  constructor(deps: AuthApiDependencies) {
    this.uiAuth = deps.uiAuth;
    this.config = deps.config;
    this.logger = deps.logger ?? createLogger('auth');
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const pathname = url.pathname;
    if (pathname !== AUTH_PATH_PREFIX && !pathname.startsWith(`${AUTH_PATH_PREFIX}/`)) {
      return false;
    }
    // Normalise trailing slashes: /mcp/v1/auth/login/ === /mcp/v1/auth/login
    const subPath = pathname.slice(AUTH_PATH_PREFIX.length).replace(/\/+$/, '') || '/';
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      switch (subPath) {
        case '/login':
          return await this.handleLogin(req, res, method);
        case '/logout':
          return await this.handleLogout(req, res, method);
        case '/me':
          return await this.handleMe(req, res, method);
        case '/password':
          return await this.handlePassword(req, res, method);
        default:
          this.sendError(res, 404, ErrorCodes.METHOD_NOT_FOUND, 'Not Found', {
            status: 'NOT_FOUND',
          });
          return true;
      }
    } catch (error) {
      if (error instanceof GatewayError) {
        this.sendJson(res, error.httpStatus, { error: error.toJSONRpcError() });
        return true;
      }
      throw error;
    }
  }

  private async handleLogin(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
  ): Promise<boolean> {
    if (method !== 'POST') return this.methodNotAllowed(res, 'POST');
    const body = await this.readJsonBody(req);
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw invalidParams('Invalid request body: username and password are required.');
    }

    let session: UiSession;
    try {
      session = this.uiAuth.login(username, password);
    } catch (error) {
      if (error instanceof GatewayError && error.code === ErrorCodes.KEY_INVALID) {
        // Deliberately generic: never reveal whether the username exists.
        this.sendError(res, 401, ErrorCodes.KEY_INVALID, 'Invalid username or password.', {
          status: 'UNAUTHORIZED',
        });
        return true;
      }
      throw error;
    }

    res.setHeader('Set-Cookie', serializeSessionCookie(session.token, this.config));
    this.logger.info('Web UI session created', { username: session.user.username });
    this.sendJson(res, 200, {
      user: { username: session.user.username },
      expiresAt: session.expiresAt,
    });
    return true;
  }

  private async handleLogout(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
  ): Promise<boolean> {
    if (method !== 'POST') return this.methodNotAllowed(res, 'POST');
    const token = this.sessionToken(req);
    if (token !== null) {
      this.uiAuth.logout(token);
      this.logger.info('Web UI session revoked');
    }
    res.setHeader('Set-Cookie', clearSessionCookie(this.config));
    this.sendJson(res, 200, { ok: true });
    return true;
  }

  private async handleMe(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
  ): Promise<boolean> {
    if (method !== 'GET') return this.methodNotAllowed(res, 'GET');
    const user = this.currentUser(req);
    if (user === null) {
      this.sendSessionUnauthorized(res);
      return true;
    }
    this.sendJson(res, 200, { authenticated: true, user: { username: user.username } });
    return true;
  }

  private async handlePassword(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
  ): Promise<boolean> {
    if (method !== 'POST') return this.methodNotAllowed(res, 'POST');
    const user = this.currentUser(req);
    if (user === null) {
      this.sendSessionUnauthorized(res);
      return true;
    }

    const body = await this.readJsonBody(req);
    const { currentPassword, newPassword } = body;
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      throw invalidParams(
        'Invalid request body: currentPassword and newPassword are required.',
      );
    }

    // Throws invalidParams (400) for a wrong current password or a too-short new one.
    this.uiAuth.changePassword(user.username, currentPassword, newPassword);
    // changePassword revokes every session (including this one): drop the cookie too.
    res.setHeader('Set-Cookie', clearSessionCookie(this.config));
    this.sendJson(res, 200, { ok: true });
    return true;
  }

  private sessionToken(req: IncomingMessage): string | null {
    return readSessionToken(req.headers.cookie);
  }

  private currentUser(req: IncomingMessage): { username: string } | null {
    const token = this.sessionToken(req);
    if (token === null) return null;
    return this.uiAuth.authenticate(token);
  }

  private async readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(typeof chunk === 'string' ? chunk : String(chunk));
      size += buffer.byteLength;
      if (size > MAX_JSON_BODY_BYTES) throw invalidParams('Request body is too large.');
      chunks.push(buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw === '') throw invalidParams('Request body is required.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalidParams('Request body must be valid JSON.');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw invalidParams('Request body must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  }

  private methodNotAllowed(res: ServerResponse, expected: string): boolean {
    this.sendError(res, 405, ErrorCodes.METHOD_NOT_FOUND, `Method Not Allowed. Expected ${expected}.`, {
      status: 'METHOD_NOT_ALLOWED',
    });
    return true;
  }

  private sendSessionUnauthorized(res: ServerResponse): void {
    this.sendError(res, 401, ErrorCodes.KEY_INVALID, 'Not authenticated.', {
      status: 'UNAUTHORIZED',
    });
  }

  private sendError(
    res: ServerResponse,
    status: number,
    code: number,
    message: string,
    data: Record<string, unknown>,
  ): void {
    this.sendJson(res, status, { error: { code, message, data } });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded || res.headersSent) return;
    const payload = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(payload));
    res.end(payload);
  }
}
