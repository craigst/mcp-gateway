import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeApi } from '../../src/admin/knowledge-api.js';
import { sessionPrincipal } from '../../src/auth/request-auth.js';

describe('managed knowledge upload', () => {
  let upstream: Server;
  let gateway: Server;
  let upstreamUrl: string;
  let gatewayUrl: string;
  let uploads: Array<{ data: string; category: string | undefined; actor: string | undefined }> = [];
  let documentsHeader = '';
  let retryBody = '';
  let readOnly = false;

  beforeAll(async () => {
    upstream = createServer(async (req, res) => {
      if (req.url === '/categories') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ readOnly, categories: [{ name: 'homelab', sensitive: false }, { name: 'financial', sensitive: true }] })); return; }
      if (req.url?.startsWith('/knowledge/documents')) { documentsHeader = String(req.headers['x-brain-allowed-categories']); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ documents: [{ id: 42, filename: 'notes.txt', category: 'homelab', index_state: 'ready' }], has_more: false })); return; }
      if (req.url === '/knowledge/retry') { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); retryBody = Buffer.concat(chunks).toString(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ repaired: true })); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      uploads.push({ data: Buffer.concat(chunks).toString(), category: req.headers['x-brain-allowed-categories'] as string, actor: req.headers['x-brain-actor'] as string });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, document_id: 42 }));
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as import('node:net').AddressInfo).port}`;
    const api = new KnowledgeApi({ url: upstreamUrl, token: () => 'test-backend-key', authenticate: (req) => ({ ...sessionPrincipal('operator'), keyType: req.headers['x-test-agent'] ? 'agent' : 'master' }) });
    gateway = createServer((req, res) => { void api.handle(req, res, new URL(req.url ?? '/', 'http://localhost')); });
    gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
    gatewayUrl = `http://127.0.0.1:${(gateway.address() as import('node:net').AddressInfo).port}`;
  });
  beforeEach(() => { uploads = []; readOnly = false; });
  afterAll(async () => { gateway.close(); upstream.close(); await Promise.all([once(gateway, 'close'), once(upstream, 'close')]); });

  it('streams a document with only the explicitly selected category', async () => {
    const response = await fetch(`${gatewayUrl}/mcp/v1/admin/knowledge/upload?filename=notes.txt&category=homelab`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'sample document' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ document_id: 42 });
    expect(uploads).toEqual([{ data: 'sample document', category: 'homelab', actor: 'operator' }]);
  });

  it('refuses an agent, unknown category and path traversal before forwarding a file', async () => {
    const path = `${gatewayUrl}/mcp/v1/admin/knowledge/upload?filename=notes.txt&category=homelab`;
    expect((await fetch(path, { method: 'POST', headers: { 'x-test-agent': '1', 'content-type': 'application/octet-stream' }, body: 'sample' })).status).toBe(403);
    expect((await fetch(`${gatewayUrl}/mcp/v1/admin/knowledge/upload?filename=notes.txt&category=unknown`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'sample' })).status).toBe(400);
    expect((await fetch(`${gatewayUrl}/mcp/v1/admin/knowledge/upload?filename=..%2Fsecret&category=homelab`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'sample' })).status).toBe(400);
    expect(uploads).toEqual([]);
  });
  it('lists documents and retries an index only for an administrator', async () => {
    const path = `${gatewayUrl}/mcp/v1/admin/knowledge/documents`;
    const list = await fetch(`${path}?category=homelab&offset=0`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ documents: [{ filename: 'notes.txt' }] });
    expect(documentsHeader).toBe('homelab,financial');
    expect((await fetch(`${path}?category=unknown`)).status).toBe(400);
    expect((await fetch(path, { headers: { 'x-test-agent': '1' } })).status).toBe(403);
    expect((await fetch(`${path}/42/retry`, { method: 'POST', headers: { 'x-test-agent': '1' } })).status).toBe(403);
    expect((await fetch(`${path}/42/retry`, { method: 'POST' })).status).toBe(200);
    expect(JSON.parse(retryBody)).toEqual({ document_id: 42 });
  });

  it('refuses uploads and index retries when the backend is staged read-only', async () => {
    readOnly = true;
    const status = await fetch(`${gatewayUrl}/mcp/v1/admin/knowledge`);
    expect(await status.json()).toMatchObject({ configured: true, readOnly: true });
    const upload = await fetch(`${gatewayUrl}/mcp/v1/admin/knowledge/upload?filename=notes.txt&category=homelab`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'sample' });
    expect(upload.status).toBe(503);
    expect((await fetch(`${gatewayUrl}/mcp/v1/admin/knowledge/documents/42/retry`, { method: 'POST' })).status).toBe(503);
    expect(uploads).toEqual([]);
  });

});
