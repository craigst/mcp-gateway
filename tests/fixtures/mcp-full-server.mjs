#!/usr/bin/env node
/**
 * Full-featured MCP fixture for v0.5 transport tests.
 *
 * Exposes tools, prompts, resources and resource templates:
 *   tools:             echo
 *   prompts:           summarize (required arg topic), review_code (language, code)
 *   resources:         demo://readme (text/markdown), demo://config (application/json)
 *   resourceTemplates: demo://items/{id}
 *
 * It speaks newline-delimited JSON-RPC 2.0 over stdio when executed directly, and
 * also exports `startHttpServer()` — a plain JSON-RPC-over-POST HTTP server (no SSE)
 * for exercising the streamable-HTTP transport in-process.
 *
 * Env (stdio mode only):
 *   FULL_FIXTURE_PROMPTS_DELAY_MS=N  -> delay prompts/list by N ms (timeout tests)
 */
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const FIXTURE_NAME = 'full-fixture';
export const FIXTURE_VERSION = '1.0.0';
export const FIXTURE_INSTRUCTIONS =
  'Full fixture instructions: echo input, summarize text, review code, read demo resources.';

const CAPABILITIES = {
  tools: { listChanged: false },
  prompts: { listChanged: false },
  resources: { subscribe: false, listChanged: false },
};

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the supplied text back to the caller',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

const PROMPTS = [
  {
    name: 'summarize',
    description: 'Summarize a body of text',
    arguments: [
      { name: 'topic', description: 'What to summarize', required: true },
    ],
  },
  {
    name: 'review_code',
    description: 'Review a code snippet',
    arguments: [
      { name: 'language', description: 'Programming language', required: false },
      { name: 'code', description: 'Code to review', required: true },
    ],
  },
];

const RESOURCES = [
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
];

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'demo://items/{id}',
    name: 'Item',
    description: 'A demo item by id',
    mimeType: 'text/plain',
  },
];

function textContent(text) {
  return { content: [{ type: 'text', text }] };
}

function respond(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Dispatch one JSON-RPC message. Returns the response object, or null for
 * notifications (no response should be written).
 */
export async function handleMessage(message, env = process.env) {
  const { id, method, params } = message ?? {};

  switch (method) {
    case 'initialize':
      return respond(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: CAPABILITIES,
        serverInfo: { name: FIXTURE_NAME, version: FIXTURE_VERSION },
        instructions: FIXTURE_INSTRUCTIONS,
      });

    case 'notifications/initialized':
      return null;

    case 'ping':
      return respond(id, {});

    case 'tools/list':
      return respond(id, { tools: TOOLS });

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === 'echo') {
        return respond(id, textContent(String(args.text ?? '')));
      }
      return fail(id, -32602, `Unknown tool: ${name}`);
    }

    case 'prompts/list': {
      const delayMs = Number(env.FULL_FIXTURE_PROMPTS_DELAY_MS ?? 0);
      if (Number.isFinite(delayMs) && delayMs > 0) await delay(delayMs);
      return respond(id, { prompts: PROMPTS });
    }

    case 'prompts/get': {
      const name = params?.name;
      const prompt = PROMPTS.find((entry) => entry.name === name);
      if (!prompt) return fail(id, -32602, `Unknown prompt: ${name}`);
      const args = params?.arguments ?? {};
      return respond(id, {
        description: prompt.description,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `${name}: ${JSON.stringify(args)}`,
            },
          },
        ],
      });
    }

    case 'resources/list':
      return respond(id, { resources: RESOURCES });

    case 'resources/templates/list':
      return respond(id, { resourceTemplates: RESOURCE_TEMPLATES });

    case 'resources/read': {
      const uri = params?.uri;
      const resource = RESOURCES.find((entry) => entry.uri === uri);
      if (!resource) return fail(id, -32602, `Unknown resource: ${uri}`);
      return respond(id, {
        contents: [{ uri, mimeType: resource.mimeType, text: `content of ${uri}` }],
      });
    }

    default:
      if (id === undefined || id === null) return null;
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

/** Start the fixture over HTTP (JSON-RPC POST, no SSE) on an ephemeral port. */
export function startHttpServer(host = '127.0.0.1', port = 0) {
  const server = createServer((req, res) => {
    if (req.method === 'DELETE') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }

      void handleMessage(message).then((response) => {
        if (response === null) {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end();
          return;
        }
        const body = JSON.stringify(response);
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'mcp-session-id': 'fixture-session',
        });
        res.end(body);
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : port;
      resolve({
        url: `http://${host}:${boundPort}`,
        port: boundPort,
        close: () =>
          new Promise((closeResolve) => {
            server.close(() => closeResolve());
          }),
      });
    });
  });
}

/** Serve the fixture over newline-delimited JSON-RPC on stdin/stdout. */
export function startStdio() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
      );
      return;
    }
    void handleMessage(message).then((response) => {
      if (response !== null) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });

  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

const isMain =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startStdio();
