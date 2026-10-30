/**
 * Computer Broker HTTP client tests against a real local HTTP server: transport,
 * normalisation, auth header propagation and broker error mapping.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BrokerHttpClient, normalizeComputer, normalizeDevice, normalizeEnrollment } from '../../src/computer_use/broker-client.js';
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

const rawDevices = [
  {
    id: 'dev_1',
    name: 'builder',
    state: 'online',
    location: 'office',
    tags: ['linux', 'ubuntu'],
    capabilities: ['exec.argv', 'term.open', 'term.send', 'term.read', 'term.close'],
    meta: { hostname: 'builder', platform: 'linux' },
    last_seen: '2026-10-29T23:58:00Z',
  },
  { id: 'dev_2', name: 'files' },
];

const rawEnrollments = [
  { id: 'enr_1', kind: 'device', expires_at: '2026-10-30T00:30:00Z', created_at: '2026-10-29T23:30:00Z' },
  { id: 'enr_2', kind: 'computer', expires_at: '2026-10-30T00:40:00Z' },
];

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
      if (url.pathname === '/api/devices') {
        sendJson(res, 200, rawDevices);
        return;
      }
      if (url.pathname === '/api/enrollments') {
        if (req.method === 'POST') {
          sendJson(res, 200, {
            id: 'enr_new',
            kind: 'computer',
            token: 'tok_abc123',
            expires_at: '2026-10-30T01:00:00Z',
            created_at: '2026-10-30T00:00:00Z',
          });
          return;
        }
        sendJson(res, 200, rawEnrollments);
        return;
      }
      if (url.pathname === '/api/enrollments/enr_1' && req.method === 'DELETE') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (url.pathname === '/api/devices/dev_1/call') {
        const call = (body ?? {}) as { op?: string; args?: unknown };
        if (call.op === 'term.fail') {
          sendJson(res, 200, {
            ok: false,
            detail: { error: 'unknown_session', message: 'no such terminal session' },
          });
          return;
        }
        sendJson(res, 200, { ok: true, data: { session: 'sess_9', op: call.op, args: call.args } });
        return;
      }
      if (url.pathname === '/api/devices/missing/call') {
        sendJson(res, 404, { detail: { error: 'unknown_device', message: 'no such device' } });
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

  it('lists devices and normalises snake_case connector JSON', async () => {
    const devices = await client().devices();
    expect(devices).toHaveLength(2);
    expect(devices[0]).toMatchObject({
      id: 'dev_1',
      name: 'builder',
      state: 'online',
      location: 'office',
      tags: ['linux', 'ubuntu'],
      capabilities: ['exec.argv', 'term.open', 'term.send', 'term.read', 'term.close'],
      meta: { hostname: 'builder', platform: 'linux' },
      lastSeen: '2026-10-29T23:58:00Z',
    });
    expect(devices[1]).toMatchObject({
      id: 'dev_2',
      name: 'files',
      state: 'unknown',
      location: null,
      tags: [],
      capabilities: [],
      meta: null,
      lastSeen: null,
    });
    expect(
      recorded.some((entry) => entry.path === '/api/devices' && entry.authorization === 'Bearer brk_test_token'),
    ).toBe(true);
  });

  it('lists and creates pairing enrollments', async () => {
    const broker = client();
    const enrollments = await broker.enrollments();
    expect(enrollments).toEqual([
      {
        id: 'enr_1',
        kind: 'device',
        expiresAt: '2026-10-30T00:30:00Z',
        createdAt: '2026-10-29T23:30:00Z',
      },
      { id: 'enr_2', kind: 'computer', expiresAt: '2026-10-30T00:40:00Z', createdAt: null },
    ]);

    const created = await broker.createEnrollment({ kind: 'computer', ttlSeconds: 900 });
    expect(created).toEqual({
      id: 'enr_new',
      kind: 'computer',
      token: 'tok_abc123',
      expiresAt: '2026-10-30T01:00:00Z',
      createdAt: '2026-10-30T00:00:00Z',
    });
    expect(recorded.find((entry) => entry.method === 'POST' && entry.path === '/api/enrollments')?.body).toEqual({
      kind: 'computer',
      ttl_s: 900,
    });
  });

  it('revokes a pairing enrollment', async () => {
    await client().revokeEnrollment('enr_1');
    expect(recorded.some((entry) => entry.method === 'DELETE' && entry.path === '/api/enrollments/enr_1')).toBe(true);
  });

  it('calls a device operation and unwraps the broker envelope', async () => {
    const data = await client().deviceCall('dev_1', 'term.open', { rows: 30 });
    expect(data).toEqual({ session: 'sess_9', op: 'term.open', args: { rows: 30 } });
    expect(recorded.find((entry) => entry.path === '/api/devices/dev_1/call')?.body).toEqual({
      op: 'term.open',
      args: { rows: 30 },
    });
  });

  it('maps a failed device operation and a device HTTP error to upstream errors', async () => {
    const broker = client();
    await expect(broker.deviceCall('dev_1', 'term.fail')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GatewayError);
      const gatewayError = error as GatewayError;
      expect(gatewayError.code).toBe(ErrorCodes.UPSTREAM_ERROR);
      expect(gatewayError.data?.reason).toBe('unknown_session');
      expect(gatewayError.message).toContain('no such terminal session');
      return true;
    });

    await expect(broker.deviceCall('missing', 'term.open')).rejects.toMatchObject({
      code: ErrorCodes.UPSTREAM_ERROR,
      httpStatus: 404,
    });
  });

  it('refuses the connector API without a token', async () => {
    await expect(client(null).devices()).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
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

describe('normalizeDevice / normalizeEnrollment', () => {
  it('tolerates missing optional connector fields', () => {
    expect(normalizeDevice({ id: 'dev_x' })).toEqual({
      id: 'dev_x',
      name: 'unnamed',
      state: 'unknown',
      location: null,
      tags: [],
      capabilities: [],
      meta: null,
      lastSeen: null,
    });
  });

  it('normalises enrollment kinds and dates', () => {
    expect(normalizeEnrollment({ id: 'enr_x', kind: 'computer', expires_at: '2026-10-30T00:30:00Z' })).toEqual({
      id: 'enr_x',
      kind: 'computer',
      expiresAt: '2026-10-30T00:30:00Z',
      createdAt: null,
    });
    expect(normalizeEnrollment({ id: 'enr_y', kind: 'weird' })).toMatchObject({ id: 'enr_y', kind: 'device', createdAt: null });
  });
});
