#!/usr/bin/env node
/**
 * Fixture MCP server used by configuration-profile tests.
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio transport) and
 * exposes one tool:
 *
 *   env_report { keys?: string[] } -> JSON text of the requested environment keys
 *                                     and their values (missing keys are null)
 *
 * It never reports unrelated process env, so tests only observe what the profile
 * resolver actually injected.
 */
import { createInterface } from 'node:readline';

const TOOLS = [
  {
    name: 'env_report',
    description: 'Report selected environment variables visible to this process',
    inputSchema: {
      type: 'object',
      properties: { keys: { type: 'array', items: { type: 'string' } } },
      required: [],
    },
  },
];

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function textContent(text) {
  return { content: [{ type: 'text', text }] };
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'env-fixture', version: '1.0.0' },
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
      if (name !== 'env_report') {
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } });
        return;
      }
      const keys = Array.isArray(args.keys) ? args.keys.map(String) : [];
      const report = {};
      for (const key of keys) {
        report[key] = process.env[key] ?? null;
      }
      respond(id, textContent(JSON.stringify(report)));
      return;
    }

    default:
      if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
