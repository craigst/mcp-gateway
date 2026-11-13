import type { AddressInfo } from 'node:net';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import { createLogger } from '../../src/core/logger.js';
import { HttpMcpClient } from '../../src/gateway/transport/http.js';

const silent = createLogger('test', 'silent');

interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
}

interface JsonRpcMessage {
  id?: number | string | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

/**
 * Streamable-HTTP fixture that behaves like `mcp-proxy`: every non-initialize
 * message must carry a live `mcp-session-id`, otherwise it answers HTTP 404 with
 * `{"error":{"code":-32001,"message":"Session not found"}}` before dispatching.
 */
class SessionFixture {
  readonly sessions = new Set<string>();
  initializeCount = 0;
  initializedNotifications = 0;
  calls: RecordedCall[] = [];
  /** Simulate a proxy that drops every session immediately after handshake. */
  dropSessionsAfterInitialize = false;
  /** Tools that answer HTTP 500 instead of a JSON-RPC result. */
  failingTools = new Set<string>();

  private server = createServer((req, res) => this.handle(req, res));
  url = '';

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()));
    const address = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  expireAll(): void {
    this.sessions.clear();
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === 'DELETE') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const message = JSON.parse(raw) as JsonRpcMessage;
      if (message.method === 'initialize') {
        this.initializeCount += 1;
        const sessionId = `session-${this.initializeCount}`;
        this.sessions.add(sessionId);
        if (this.dropSessionsAfterInitialize) this.sessions.delete(sessionId);
        this.json(res, 200, message.id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'session-fixture', version: '1.0.0' },
        }, sessionId);
        return;
      }
      if (message.method === 'notifications/initialized') {
        this.initializedNotifications += 1;
        res.writeHead(202);
        res.end();
        return;
      }

      const sessionId = req.headers['mcp-session-id'];
      if (typeof sessionId !== 'string' || !this.sessions.has(sessionId)) {
        this.json(res, 404, null, undefined, undefined, {
          code: -32001,
          message: 'Session not found',
        });
        return;
      }

      switch (message.method) {
        case 'tools/list':
          this.json(res, 200, message.id, {
            tools: [
              {
                name: 'echo',
                description: 'Echo text',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
              },
              {
                name: 'post_status',
                description: 'Pretend to publish a post',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
              },
            ],
          }, sessionId);
          return;
        case 'prompts/list':
          this.json(res, 200, message.id, { prompts: [] }, sessionId);
          return;
        case 'tools/call': {
          const name = String(message.params?.name ?? '');
          this.calls.push({ name, args: message.params?.arguments ?? {} });
          if (this.failingTools.has(name)) {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end('upstream exploded');
            return;
          }
          this.json(res, 200, message.id, {
            content: [{ type: 'text', text: `ok:${name}` }],
          }, sessionId);
          return;
        }
        default:
          this.json(res, 200, message.id, {}, sessionId);
      }
    });
  }

  private json(
    res: ServerResponse,
    status: number,
    id: JsonRpcMessage['id'],
    result?: unknown,
    sessionId?: string,
    error?: { code: number; message: string },
  ): void {
    const body = JSON.stringify(
      error ? { jsonrpc: '2.0', id: id ?? null, error } : { jsonrpc: '2.0', id: id ?? null, result },
    );
    const headers: Record<string, string | number> = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    res.writeHead(status, headers);
    res.end(body);
  }
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const dispose = cleanup.pop();
    if (!dispose) continue;
    try {
      await dispose();
    } catch {
      // Best-effort teardown.
    }
  }
});

async function startFixture(): Promise<{ fixture: SessionFixture; client: HttpMcpClient }> {
  const fixture = new SessionFixture();
  await fixture.start();
  cleanup.push(() => fixture.close());
  const client = new HttpMcpClient({
    serverId: 'session-fixture',
    url: fixture.url,
    requestTimeoutMs: 5_000,
    logger: silent,
  });
  cleanup.push(() => client.close());
  return { fixture, client };
}

async function expectUpstreamError(promise: Promise<unknown>): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    const gatewayError = error as GatewayError;
    expect(gatewayError.code).toBe(ErrorCodes.UPSTREAM_ERROR);
    return gatewayError;
  }
  throw new Error('Expected the transport call to reject with a GatewayError');
}

describe('HttpMcpClient expired-session recovery', () => {
  it('re-initializes once and retries a tool call after the remote drops the session', async () => {
    const { fixture, client } = await startFixture();
    await client.initialize();
    expect(fixture.initializeCount).toBe(1);

    fixture.expireAll();
    const result = await client.callTool('echo', { text: 'hi' });

    expect(result.content).toEqual([{ type: 'text', text: 'ok:echo' }]);
    expect(fixture.initializeCount).toBe(2);
    // The rejected attempt was never dispatched, so the tool ran exactly once.
    expect(fixture.calls).toEqual([{ name: 'echo', args: { text: 'hi' } }]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fixture.initializedNotifications).toBeGreaterThanOrEqual(2);
  });

  it('does not dispatch a write twice when the session expired', async () => {
    const { fixture, client } = await startFixture();
    await client.initialize();

    fixture.expireAll();
    const result = await client.callTool('post_status', { text: 'hello' });

    expect(result.content).toEqual([{ type: 'text', text: 'ok:post_status' }]);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toEqual({ name: 'post_status', args: { text: 'hello' } });
  });

  it('recovers discovery calls (tools/list, prompts/list) after expiry', async () => {
    const { fixture, client } = await startFixture();
    await client.initialize();

    fixture.expireAll();
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'post_status']);

    fixture.expireAll();
    expect(await client.listPrompts()).toEqual([]);
    expect(fixture.initializeCount).toBe(3);
  });

  it('performs a single recovery handshake for concurrent calls', async () => {
    const { fixture, client } = await startFixture();
    await client.initialize();

    fixture.expireAll();
    const results = await Promise.all([
      client.callTool('echo', { text: 'one' }),
      client.callTool('echo', { text: 'two' }),
      client.callTool('echo', { text: 'three' }),
    ]);

    expect(results).toHaveLength(3);
    expect(fixture.initializeCount).toBe(2);
    expect(fixture.calls.map((call) => call.args.text)).toEqual(['one', 'two', 'three']);
  });

  it('surfaces a plain upstream error and does not re-initialize on HTTP 500', async () => {
    const { fixture, client } = await startFixture();
    await client.initialize();
    fixture.failingTools.add('boom');

    const error = await expectUpstreamError(client.callTool('boom', {}));

    expect(error.message).toContain('HTTP 500');
    expect(fixture.initializeCount).toBe(1);
    expect(fixture.calls).toHaveLength(1);
  });

  it('stops after one retry when the new session is rejected too', async () => {
    const { fixture, client } = await startFixture();
    await client.initialize();
    fixture.dropSessionsAfterInitialize = true;
    fixture.expireAll();

    const error = await expectUpstreamError(client.callTool('echo', { text: 'hi' }));

    expect(error.message).toContain('rejected');
    expect(fixture.initializeCount).toBe(2);
    // Neither attempt reached the tool: both were rejected at session validation.
    expect(fixture.calls).toHaveLength(0);
  });

  it('does not treat a 404 without a session id as an expired session', async () => {
    const { fixture, client } = await startFixture();

    const error = await expectUpstreamError(client.listTools());

    expect(error.message).toContain('HTTP 404');
    expect(fixture.initializeCount).toBe(0);
  });
});
