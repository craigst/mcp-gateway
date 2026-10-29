#!/usr/bin/env node
/**
 * Fixture MCP server used by gateway integration/E2E tests.
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio transport).
 * Exposes:
 *   echo          { text }                → echoes text
 *   add           { a, b }                → sum
 *   danger_delete { target }              → HIGH PRIVILEGE tool
 *   fail          {}                      → returns isError:true
 *   slow          { ms }                  → sleeps then returns
 *
 * Env:
 *   ECHO_SERVER_FAIL_START=1  → exits(1) after 100ms (start failure test)
 *   ECHO_SERVER_STDERR=1      → emits stderr chatter
 */
import { createInterface } from 'node:readline';

if (process.env.ECHO_SERVER_FAIL_START === '1') {
  console.error('echo-fixture: simulated fatal start failure');
  setTimeout(() => process.exit(1), 100);
}

if (process.env.ECHO_SERVER_STDERR === '1') console.error('echo-fixture: stderr channel active');

const TOOLS = [
  {
    name: 'update_marker',
    description: 'Tool added by the v2 update fixture',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'echo',
    description: 'Echo the supplied text back to the caller',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'add',
    description: 'Add two numbers together',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'danger_delete',
    description: 'Destructive operation used to test high-privilege masking',
    inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
  },
  {
    name: 'fail',
    description: 'Always fails; used to test isError propagation',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'slow',
    description: 'Sleep then respond; used to test timeouts',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] },
  },
];

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

function textContent(text) {
  return { content: [{ type: 'text', text }] };
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    fail(null, -32700, 'Parse error');
    return;
  }

  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'echo-fixture', version: '1.0.0' },
      });
      return;

    case 'notifications/initialized':
      return;

    case 'ping':
      respond(id, {});
      return;

    case 'tools/list':
      respond(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      switch (name) {
        case 'update_marker':
          respond(id, textContent('v2-marker'));
          return;
        case 'echo':
          respond(id, textContent(String(args.text ?? '')));
          return;
        case 'add':
          respond(id, textContent(String(Number(args.a) + Number(args.b))));
          return;
        case 'danger_delete':
          respond(id, textContent(`deleted:${args.target ?? 'unknown'}`));
          return;
        case 'fail':
          respond(id, { content: [{ type: 'text', text: 'intentional failure' }], isError: true });
          return;
        case 'slow':
          await new Promise((resolve) => setTimeout(resolve, Number(args.ms ?? 1000)));
          respond(id, textContent('slow-done'));
          return;
        default:
          fail(id, -32602, `Unknown tool: ${name}`);
          return;
      }
    }

    default:
      if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
