import { Readable, Transform } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthenticatedKey } from '../core/types.js';
import { ErrorCodes, GatewayError, accessDenied, invalidParams } from '../core/errors.js';
import type { AdminSubRouter } from './types.js';

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10 * 60_000;

export interface KnowledgeApiDeps {
  url: string | null;
  token: () => string | null;
  authenticate: (req: IncomingMessage) => AuthenticatedKey;
  fetch?: typeof fetch;
}

type Category = { name: string; sensitive: boolean };

/** Master-only bridge to the configured managed brain; agents use scoped MCP tools. */
export class KnowledgeApi implements AdminSubRouter {
  constructor(private readonly deps: KnowledgeApiDeps) {}

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const parts = url.pathname.replace(/^\/mcp\/v1\/admin\/?/, '').split('/').filter(Boolean);
    if (parts[0] !== 'knowledge') return false;
    try {
      const principal = this.deps.authenticate(req);
      if (principal.keyType !== 'master') throw accessDenied('Master privileges are required for knowledge administration.', { reason: 'SCOPE_RESTRICTION' });
      if (parts.length === 1 && req.method === 'GET') {
        if (!this.deps.url || !this.deps.token()) {
          this.send(res, 200, { configured: false, categories: [] });
          return true;
        }
        const categories = await this.categories();
        this.send(res, 200, { configured: true, categories, maxUploadBytes: MAX_UPLOAD_BYTES });
        return true;
      }
      if (parts.length === 2 && parts[1] === 'documents' && req.method === 'GET') {
        const categories = await this.categories();
        const category = url.searchParams.get('category');
        const offset = url.searchParams.get('offset') ?? '0';
        if (!/^\d{1,7}$/u.test(offset) || Number(offset) > 1_000_000) throw invalidParams('Invalid document page.');
        if (category && !categories.some((item) => item.name === category)) throw invalidParams('Choose an available category.');
        const target = this.target('/knowledge/documents');
        target.searchParams.set('limit', '25');
        target.searchParams.set('offset', offset);
        if (category) target.searchParams.set('category', category);
        const response = await (this.deps.fetch ?? fetch)(target, { headers: { authorization: `Bearer ${this.token()}`, 'x-brain-allowed-categories': categories.map((item) => item.name).join(',') }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new GatewayError(ErrorCodes.INTERNAL_ERROR, 'Could not load documents.', { httpStatus: 502 });
        this.send(res, 200, await response.json());
        return true;
      }
      if (parts.length === 4 && parts[1] === 'documents' && /^\d+$/u.test(parts[2] ?? '') && parts[3] === 'retry' && req.method === 'POST') {
        const id = Number(parts[2]);
        if (!Number.isSafeInteger(id) || id < 1) throw invalidParams('Invalid document ID.');
        const categories = await this.categories();
        const response = await (this.deps.fetch ?? fetch)(this.target('/knowledge/retry'), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { authorization: `Bearer ${this.token()}`, 'content-type': 'application/json', 'x-brain-actor': principal.name, 'x-brain-allowed-categories': categories.map((item) => item.name).join(',') }, body: JSON.stringify({ document_id: id }) });
        if (!response.ok) throw new GatewayError(ErrorCodes.INTERNAL_ERROR, 'Could not repair this document index.', { httpStatus: 502 });
        this.send(res, 200, await response.json());
        return true;
      }
      if (parts.length === 2 && parts[1] === 'upload' && req.method === 'POST') {
        await this.upload(req, res, url, principal);
        return true;
      }
      throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Unknown knowledge endpoint', { httpStatus: 404 });
    } catch (error) {
      const gatewayError = error instanceof GatewayError ? error : new GatewayError(ErrorCodes.INTERNAL_ERROR, 'The knowledge service is unavailable.', { httpStatus: 502 });
      if (!res.headersSent) this.send(res, gatewayError.httpStatus, { error: gatewayError.toJSONRpcError() });
      return true;
    }
  }

  private target(path: string): URL {
    if (!this.deps.url) throw new GatewayError(ErrorCodes.NOT_IMPLEMENTED, 'The built-in knowledge service is not configured.', { httpStatus: 503 });
    let base: URL;
    try { base = new URL(this.deps.url); } catch { throw invalidParams('The configured knowledge service URL is invalid.'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw invalidParams('The configured knowledge service URL is invalid.');
    return new URL(`${base.pathname.replace(/\/$/u, '')}${path}`, base.origin);
  }

  private token(): string {
    const token = this.deps.token();
    if (!token) throw new GatewayError(ErrorCodes.NOT_IMPLEMENTED, 'The built-in knowledge service key is not configured.', { httpStatus: 503 });
    return token;
  }

  private async categories(): Promise<Category[]> {
    const response = await (this.deps.fetch ?? fetch)(this.target('/categories'), {
      headers: { authorization: `Bearer ${this.token()}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new GatewayError(ErrorCodes.INTERNAL_ERROR, 'Could not load knowledge categories.', { httpStatus: 502 });
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('categories' in body) || !Array.isArray(body.categories)) throw new Error('invalid categories');
    return body.categories.filter((entry: unknown): entry is Category => Boolean(entry && typeof entry === 'object' && 'name' in entry && typeof entry.name === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(entry.name) && 'sensitive' in entry && typeof entry.sensitive === 'boolean'));
  }

  private async upload(req: IncomingMessage, res: ServerResponse, url: URL, principal: AuthenticatedKey): Promise<void> {
    const filename = url.searchParams.get('filename') ?? '';
    const category = url.searchParams.get('category') ?? '';
    if (!filename || filename.length > 200 || filename === '.' || filename === '..' || /[/\\]/u.test(filename) || [...filename].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw invalidParams('Choose a valid filename.');
    if (!(await this.categories()).some((item) => item.name === category)) throw invalidParams('Choose an available category.');
    if ((req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() !== 'application/octet-stream') throw invalidParams('Expected a file upload.');
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > MAX_UPLOAD_BYTES)) throw new GatewayError(ErrorCodes.INVALID_REQUEST, 'File exceeds the upload limit.', { httpStatus: 413 });
    const target = this.target('/knowledge/upload');
    target.searchParams.set('filename', filename);
    target.searchParams.set('category', category);
    let bytes = 0;
    let tooLarge = false;
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) { tooLarge = true; callback(new Error('upload limit exceeded')); return; }
      callback(null, chunk);
    } });
    const onAborted = (): void => { limiter.destroy(new Error('upload disconnected')); };
    if (req.aborted) throw new GatewayError(ErrorCodes.INVALID_REQUEST, 'Upload disconnected.', { httpStatus: 400 });
    req.once('aborted', onAborted);
    req.pipe(limiter);
    try {
      const response = await (this.deps.fetch ?? fetch)(target, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { authorization: `Bearer ${this.token()}`, 'content-type': 'application/octet-stream', 'x-brain-actor': principal.name, 'x-brain-allowed-categories': category, ...(length ? { 'content-length': length } : {}) },
        body: Readable.toWeb(limiter) as unknown as BodyInit, duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const detail = payload && typeof payload === 'object' && 'detail' in payload && typeof payload.detail === 'string' ? payload.detail : 'Document upload failed.';
        // A backend credential failure is not a gateway session failure.
        const status = response.status === 401 || response.status === 403 ? 502 : response.status;
        throw new GatewayError(ErrorCodes.INTERNAL_ERROR, detail, { httpStatus: status });
      }
      this.send(res, 200, payload);
    } catch (error) {
      if (tooLarge) throw new GatewayError(ErrorCodes.INVALID_REQUEST, 'File exceeds the upload limit.', { httpStatus: 413 });
      throw error;
    } finally {
      req.unpipe(limiter);
      req.off('aborted', onAborted);
      limiter.destroy();
    }
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  }
}
