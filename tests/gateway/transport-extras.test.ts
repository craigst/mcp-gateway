import type { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { GatewayConfig } from '../../src/core/config.js';
import { openDatabase } from '../../src/core/db.js';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import { createLogger } from '../../src/core/logger.js';
import type { ServerRecord } from '../../src/core/types.js';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';
import { DefaultSupervisor } from '../../src/gateway/supervisor.js';
import { HttpMcpClient } from '../../src/gateway/transport/http.js';
import { StdioMcpClient } from '../../src/gateway/transport/stdio.js';

// @ts-expect-error -- plain-JavaScript test fixture without type declarations (intentional).
import { FIXTURE_INSTRUCTIONS, startHttpServer } from '../fixtures/mcp-full-server.mjs';

const FULL_FIXTURE_PATH = fileURLToPath(new URL('../fixtures/mcp-full-server.mjs', import.meta.url));
const ECHO_FIXTURE_PATH = fileURLToPath(new URL('../fixtures/mcp-echo-server.mjs', import.meta.url));
const fixtureInstructions = FIXTURE_INSTRUCTIONS as string;

interface FixtureHttpServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const startFullHttpServer = startHttpServer as (
  host?: string,
  port?: number,
) => Promise<FixtureHttpServer>;

const silent = createLogger('test', 'silent');
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const dispose = cleanup.pop();
    if (!dispose) continue;
    try {
      await dispose();
    } catch {
      // Best-effort teardown; a fixture that already died must not fail the test.
    }
  }
});

function makeConfig(): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir: '/tmp/mcp-gateway-transport-extras-test',
    dbPath: ':memory:',
    uiDistDir: 'ui/dist',
    vaultSecret: null,
    bootstrapMasterKey: null,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: [],
    reposDir: '/tmp/mcp-gateway-transport-extras-test-repos',
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 10_000,
    keyPepper: null,
    publicBaseUrl: 'http://localhost:8080',
  };
}

let clientCounter = 0;

async function startStdioClient(options: {
  fixturePath?: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
} = {}): Promise<StdioMcpClient> {
  clientCounter += 1;
  const client = new StdioMcpClient({
    serverId: `fixture-${clientCounter}`,
    command: process.execPath,
    args: [options.fixturePath ?? FULL_FIXTURE_PATH],
    env: options.env,
    requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
    logger: silent,
  });
  await client.start();
  cleanup.push(() => client.close());
  return client;
}

async function startHttpClient(): Promise<{ client: HttpMcpClient; server: FixtureHttpServer }> {
  const server = await startFullHttpServer();
  cleanup.push(() => server.close());
  clientCounter += 1;
  const client = new HttpMcpClient({
    serverId: `fixture-http-${clientCounter}`,
    url: server.url,
    requestTimeoutMs: 5_000,
    logger: silent,
  });
  cleanup.push(() => client.close());
  return { client, server };
}

interface CustomHttpServer {
  url: string;
}

/** Minimal JSON-RPC-over-POST server for defensive shape/error tests. */
async function startCustomHttp(
  handler: (message: { id?: unknown; method?: string }) => unknown,
): Promise<CustomHttpServer> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const message = JSON.parse(raw) as { id?: unknown; method?: string };
      const result = handler(message);
      if (result === null) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}` };
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

describe('StdioMcpClient prompts/resources', () => {
  it('initializes with capabilities and instructions', async () => {
    const client = await startStdioClient();
    const info = await client.initialize();

    expect(info.serverInfo).toEqual({ name: 'full-fixture', version: '1.0.0' });
    expect(info.capabilities).toMatchObject({
      prompts: expect.any(Object),
      resources: expect.any(Object),
    });
    expect(info.instructions).toBe(fixtureInstructions);
    expect(await client.listTools()).toEqual([
      {
        name: 'echo',
        description: 'Echo the supplied text back to the caller',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    ]);
  });

  it('lists prompts with argument metadata', async () => {
    const client = await startStdioClient();
    await client.initialize();

    const prompts = await client.listPrompts();
    expect(prompts).toHaveLength(2);
    expect(prompts.find((prompt) => prompt.name === 'summarize')).toEqual({
      name: 'summarize',
      description: 'Summarize a body of text',
      arguments: [{ name: 'topic', description: 'What to summarize', required: true }],
    });

    const review = prompts.find((prompt) => prompt.name === 'review_code');
    expect(review?.arguments).toEqual([
      { name: 'language', description: 'Programming language', required: false },
      { name: 'code', description: 'Code to review', required: true },
    ]);
  });

  it('gets a prompt with arguments and passes the upstream result through', async () => {
    const client = await startStdioClient();
    await client.initialize();

    const result = (await client.getPrompt('summarize', { topic: 'release notes' })) as {
      description: string;
      messages: Array<{ role: string; content: { type: string; text: string } }>;
    };
    expect(result.description).toBe('Summarize a body of text');
    expect(result.messages[0]?.role).toBe('user');
    expect(result.messages[0]?.content.type).toBe('text');
    expect(result.messages[0]?.content.text).toContain('summarize');
    expect(result.messages[0]?.content.text).toContain('release notes');
  });

  it('lists resources and templates and reads a resource', async () => {
    const client = await startStdioClient();
    await client.initialize();

    expect(await client.listResources()).toEqual([
      {
        uri: 'demo://readme',
        name: 'README',
        description: 'Demo readme document',
        mimeType: 'text/markdown',
      },
      {
        uri: 'demo://config',
        name: 'Config',
        description: 'Demo JSON configuration',
        mimeType: 'application/json',
      },
    ]);
    expect(await client.listResourceTemplates()).toEqual([
      {
        uriTemplate: 'demo://items/{id}',
        name: 'Item',
        description: 'A demo item by id',
        mimeType: 'text/plain',
      },
    ]);
    const read = (await client.readResource('demo://readme')) as {
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    };
    expect(read.contents[0]).toEqual({
      uri: 'demo://readme',
      mimeType: 'text/markdown',
      text: 'content of demo://readme',
    });
  });

  it('maps unknown prompt/resource errors to UPSTREAM_ERROR', async () => {
    const client = await startStdioClient();
    await client.initialize();

    const promptError = await expectUpstreamError(client.getPrompt('does_not_exist', {}));
    expect(promptError.message).toContain('Unknown prompt');
    expect(promptError.data?.reason).toBe('prompts/get');

    const resourceError = await expectUpstreamError(client.readResource('demo://missing'));
    expect(resourceError.message).toContain('Unknown resource');
    expect(resourceError.data?.reason).toBe('resources/read');
  });

  it('rejects extras gracefully on a server that does not implement them', async () => {
    const client = await startStdioClient({ fixturePath: ECHO_FIXTURE_PATH });
    await client.initialize();
    expect((await client.listTools()).map((tool) => tool.name)).toContain('echo');

    const error = await expectUpstreamError(client.listPrompts());
    expect(error.message.toLowerCase()).toContain('method not found');
    expect(error.data?.reason).toBe('prompts/list');
  });

  it('maps request timeouts to UPSTREAM_ERROR', async () => {
    // Deliberately generous margins: this suite runs alongside many other files in
    // parallel, so only the prompts/list request (delayed by the fixture) may time out.
    const client = await startStdioClient({
      env: { FULL_FIXTURE_PROMPTS_DELAY_MS: '5000' },
      requestTimeoutMs: 2_000,
    });
    await client.initialize();

    const error = await expectUpstreamError(client.listPrompts());
    expect(error.message).toContain('timed out');
    expect(error.data?.status).toBe('TIMEOUT');
  });
});

describe('HttpMcpClient prompts/resources', () => {
  it('initializes and exercises all five extras methods over HTTP', async () => {
    const { client } = await startHttpClient();
    const info = await client.initialize();
    expect(info.serverInfo).toEqual({ name: 'full-fixture', version: '1.0.0' });
    expect(info.instructions).toBe(fixtureInstructions);

    const prompts = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual(['summarize', 'review_code']);

    const promptResult = (await client.getPrompt('review_code', {
      language: 'typescript',
      code: 'const x = 1;',
    })) as { messages: Array<{ content: { text: string } }> };
    expect(promptResult.messages[0]?.content.text).toContain('typescript');

    expect(await client.listResources()).toHaveLength(2);
    expect((await client.listResources())[0]).toMatchObject({
      uri: 'demo://readme',
      mimeType: 'text/markdown',
    });
    expect(await client.listResourceTemplates()).toEqual([
      {
        uriTemplate: 'demo://items/{id}',
        name: 'Item',
        description: 'A demo item by id',
        mimeType: 'text/plain',
      },
    ]);
    expect((await client.readResource('demo://config')) as { contents: unknown[] }).toHaveProperty(
      'contents',
    );
  });

  it('maps HTTP JSON-RPC errors to UPSTREAM_ERROR', async () => {
    const { client } = await startHttpClient();
    await client.initialize();

    const error = await expectUpstreamError(client.getPrompt('missing_prompt', {}));
    expect(error.message).toContain('Unknown prompt');
    expect(error.data?.reason).toBe('prompts/get');
  });

  it('defensively maps malformed upstream shapes to typed defaults', async () => {
    const custom = await startCustomHttp((message) => {
      switch (message.method) {
        case 'initialize':
          return {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'custom', version: '1.0.0' },
          };
        case 'notifications/initialized':
          return null;
        case 'prompts/list':
          return { prompts: [{ name: 'bare' }, 'not-an-object', { description: 'no name' }] };
        case 'resources/list':
          return { resources: [{ uri: 'x://a' }] };
        case 'resources/templates/list':
          return { resourceTemplates: 'not-an-array' };
        case 'resources/read':
          return { contents: [] };
        case 'prompts/get':
          return { messages: [] };
        default:
          return null;
      }
    });

    clientCounter += 1;
    const client = new HttpMcpClient({
      serverId: `fixture-custom-${clientCounter}`,
      url: custom.url,
      requestTimeoutMs: 5_000,
      logger: silent,
    });
    cleanup.push(() => client.close());
    await client.initialize();

    expect(await client.listPrompts()).toEqual([
      { name: 'bare', description: '', arguments: [] },
      { name: '', description: 'no name', arguments: [] },
    ]);
    expect(await client.listResources()).toEqual([
      { uri: 'x://a', name: '', description: '', mimeType: null },
    ]);
    expect(await client.listResourceTemplates()).toEqual([]);
    expect(await client.readResource('x://a')).toEqual({ contents: [] });
    expect(await client.getPrompt('any', {})).toEqual({ messages: [] });
  });
});

describe('Supervisor discovery of prompts/resources', () => {
  it('persists prompts, resources, capabilities and instructions from initialize', async () => {
    const db: DatabaseSync = openDatabase(':memory:');
    const repository = new SqliteCatalogRepository(db);
    const supervisor = new DefaultSupervisor({
      repository,
      config: makeConfig(),
      logger: silent,
    });
    cleanup.push(async () => {
      await supervisor.shutdown();
      db.close();
    });

    const server: ServerRecord = {
      id: 'srv_full_fixture',
      name: 'full-fixture',
      runtime: 'node',
      transport: 'stdio',
      status: 'stopped',
      command: process.execPath,
      args: [FULL_FIXTURE_PATH],
      url: null,
      env: {},
      headers: {},
      manifest: null,
      highPrivilegeTools: [],
      delegationSupported: false,
      sourceUrl: null,
      workDir: null,
      envFile: null,
      approvalRequiredTools: [],
      lastError: null,
      pid: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    repository.upsertServer(server);

    const started = await supervisor.start(server.id);
    expect(started.status).toBe('running');

    const record = repository.getServer(server.id);
    expect(record?.prompts?.map((prompt) => prompt.name)).toEqual(['summarize', 'review_code']);
    expect(record?.resources?.map((resource) => resource.uri)).toEqual([
      'demo://readme',
      'demo://config',
    ]);
    expect(record?.capabilities).toMatchObject({
      tools: expect.any(Object),
      prompts: expect.any(Object),
      resources: expect.any(Object),
    });
    expect(record?.instructions).toBe(fixtureInstructions);

    const client = supervisor.client(server.id);
    expect(typeof client?.listResourceTemplates).toBe('function');
    expect(await client!.listResourceTemplates!()).toHaveLength(1);
  });
});
