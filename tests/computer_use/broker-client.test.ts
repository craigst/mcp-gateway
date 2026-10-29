/**
 * Computer Broker HTTP client tests against a real local HTTP server: transport,
 * normalisation, auth header propagation and broker error mapping.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BrokerHttpClient, normalizeComputer } from '../../src/computer_use/broker-client.js';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import { createLogger } from '../../src/core/logger.js';

interface Recorded {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

const recorded: Recorded[] = [];
let server: Server;
let baseUrl: string;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? null : JSON.parse(raw);
}

const rawComputer = {
  id: 'cmp_1',
  name: 'agent-desktop',
  template: 'desktop-base',
  provider: 'container',
  state: 'ready',
  viewer: 'rfb',
  error: null,
  created_at: '2026-10-29T22:00:00Z',
  ttl_at: '2026-10-29T23:00:00Z',
  desktop: { viewer: 'rfb', width: 1280, height: 800 },
  connector: { state: 'online', version: '1.0.0', last_seen: '2026-10-29T22:59:00Z' },
  control: { held: false, holder: null, held_since: null, expires_at: null },
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void (async () => {
      const body = req.method === 'POST' ? await readBody(req) : null;
      recorded.push({ method: req.method ?? '', path: url.pathname, authorization: req.headers.authorization, body });
      if (url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true, version: '1.0.0', computers: 1, devices: 0, connectors_online: 1, tls: false });
        return;
      }
      if (url.pathname === '/api/computers') {
        sendJson(res, 200, [rawComputer]);
        return;
      }
      if (url.pathname === '/api/computers/cmp_1') {
        sendJson(res, 200, rawComputer);
        return;
      }
      if (url.pathname === '/api/computers/cmp_1/frame') {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'x-frame-time': '2026-10-29T22:59:30Z' });
        res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        return;
      }
      if (url.pathname === '/api/computers/cmp_1/start' || url.pathname === '/api/computers/cmp_1/stop') {
        sendJson(res, 200, { ...rawComputer, state: url.pathname.endsWith('/start') ? 'ready' : 'stopped' });
        return;
      }
      if (url.pathname === '/mcp') {
        const message = body as { id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } };
        if (message.method === 'tools/list') {
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: [
                { name: 'list_computers', description: 'List', inputSchema: { type: 'object' } },
                { name: 'computer_click', description: 'Click', inputSchema: { type: 'object' } },
              ],
            },
          });
          return;
        }
        if (message.method === 'tools/call') {
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id: message.id,
            result: { content: [{ type: 'text', text: JSON.stringify(message.params) }], isError: false },
          });
          return;
        }
        sendJson(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
        return;
      }
      if (url.pathname === '/api/computers/missing') {
        sendJson(res, 404, { detail: { error: 'unknown_computer', message: 'no such computer' } });
        return;
      }
      sendJson(res, 404, { detail: 'not found' });
    })();
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
});

function client(token: string | null = 'brk_test_token'): BrokerHttpClient {
  return new BrokerHttpClient({ baseUrl, token, logger: createLogger('test', 'silent') });
}

describe('BrokerHttpClient', () => {
  it('reads health and the fleet with the bearer token', async () => {
    const broker = client();
    const health = await broker.health();
    expect(health).toMatchObject({ ok: true, version: '1.0.0', computers: 1, connectorsOnline: 1 });
    expect(health.tls).toBe(false);

    const computers = await broker.listComputers();
    expect(computers).toHaveLength(1);
    expect(computers[0]).toMatchObject({
      id: 'cmp_1',
      name: 'agent-desktop',
      state: 'ready',
      viewer: 'rfb',
      connector: { state: 'online', version: '1.0.0', lastSeen: '2026-10-29T22:59:00Z' },
      control: { held: false, holder: null },
      desktop: { viewer: 'rfb', width: 1280, height: 800 },
    });
    expect(recorded.some((entry) => entry.path === '/api/computers' && entry.authorization === 'Bearer brk_test_token')).toBe(true);
  });

  it('fetches a JPEG frame and its timestamp', async () => {
    const frame = await client().frame('cmp_1', 320);
    expect(frame.contentType).toBe('image/jpeg');
    expect(frame.frameTime).toBe('2026-10-29T22:59:30Z');
    expect(frame.data.equals(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBe(true);
    expect(recorded.find((entry) => entry.path === '/api/computers/cmp_1/frame')).toBeDefined();
  });

  it('starts and stops a computer', async () => {
    const stopped = await client().stopComputer('cmp_1');
    expect(stopped.state).toBe('stopped');
    const started = await client().startComputer('cmp_1');
    expect(started.state).toBe('ready');
  });

  it('speaks JSON-RPC to the MCP endpoint and passes tool errors through', async () => {
    const broker = client();
    const list = (await broker.rpc('tools/list')) as { tools: Array<{ name: string }> };
    expect(list.tools.map((tool) => tool.name)).toEqual(['list_computers', 'computer_click']);

    const call = (await broker.rpc('tools/call', { name: 'list_computers', arguments: {} })) as {
      content: unknown[];
      isError: boolean;
    };
    expect(call.isError).toBe(false);
    expect(call.content).toHaveLength(1);

    await expect(broker.rpc('nope')).rejects.toMatchObject({ code: ErrorCodes.UPSTREAM_ERROR });
  });

  it('maps broker HTTP failures with reason and status', async () => {
    const broker = client();
    await expect(broker.getComputer('missing')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GatewayError);
      const gatewayError = error as GatewayError;
      expect(gatewayError.code).toBe(ErrorCodes.UPSTREAM_ERROR);
      expect(gatewayError.httpStatus).toBe(404);
      expect(gatewayError.data?.reason).toBe('unknown_computer');
      return true;
    });
  });

  it('refuses authenticated calls without a token', async () => {
    await expect(client(null).listComputers()).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
  });

  it('reports an unreachable broker as an upstream error', async () => {
    const unreachable = new BrokerHttpClient({
      baseUrl: 'http://127.0.0.1:1',
      token: 'brk_test_token',
      timeoutMs: 500,
      logger: createLogger('test', 'silent'),
    });
    await expect(unreachable.health()).rejects.toMatchObject({ code: ErrorCodes.UPSTREAM_ERROR, httpStatus: 502 });
  });
});

describe('normalizeComputer', () => {
  it('tolerates missing optional fields', () => {
    const computer = normalizeComputer({ id: 'cmp_x', name: 'bare' });
    expect(computer).toMatchObject({
      id: 'cmp_x',
      name: 'bare',
      template: 'unknown',
      provider: 'container',
      state: 'unknown',
      viewer: 'rfb',
      connector: null,
      control: { held: false },
    });
  });
});
