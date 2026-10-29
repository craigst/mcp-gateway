#!/usr/bin/env node
/**
 * Fixture MCP server emulating `vaultwarden-mcp` for approval-gating tests.
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio transport).
 * Exposes:
 *   vault_status               {}                  → read-only status
 *   vault_list_local_ui        {}                  → read-only local UI list
 *   vault_get_metadata         {}                  → read-only metadata
 *   vault_deliver_credential   { dir?, fail? }     → writes a 0600 temp file and
 *                                                    returns ONLY its path
 *   vault_create_api_key       { fail? }           → mutating (fake key id)
 *   vault_rotate_webui_login   { fail? }           → mutating (fake rotation)
 *
 * Arguments:
 *   dir   directory for the delivered credential file (default: mkdtemp)
 *   fail  respond with a JSON-RPC error (simulates execution failure)
 *
 * The fixture contains no real secrets: the delivered file only holds a marker
 * string so tests can prove that results carry a path and never a secret value.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

const TOOLS = [
  {
    name: 'vault_status',
    description: 'Read-only Vaultwarden connection status',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'vault_list_local_ui',
    description: 'Read-only list of local Vaultwarden UI credentials',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'vault_get_metadata',
    description: 'Read-only metadata for a vault item',
    inputSchema: { type: 'object', properties: { item: { type: 'string' } } },
  },
  {
    name: 'vault_deliver_credential',
    description: 'Deliver a credential to a short-lived 0600 file; returns only the path',
    inputSchema: {
      type: 'object',
      properties: { item: { type: 'string' }, dir: { type: 'string' }, fail: { type: 'boolean' } },
    },
  },
  {
    name: 'vault_create_api_key',
    description: 'Create an API key in the vault (mutating)',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, fail: { type: 'boolean' } } },
  },
  {
    name: 'vault_rotate_webui_login',
    description: 'Rotate a WebUI login (mutating)',
    inputSchema: { type: 'object', properties: { item: { type: 'string' }, fail: { type: 'boolean' } } },
  },
];

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, message, data) {
  send({ jsonrpc: '2.0', id, error: { code: -32000, message, ...(data ? { data } : {}) } });
}

function textContent(text, extra = {}) {
  return { content: [{ type: 'text', text }], ...extra };
}

/** Write a marker file with 0600 permissions and return its absolute path. */
function deliverCredential(args) {
  const baseDir = typeof args.dir === 'string' && args.dir !== '' ? args.dir : mkdtempSync(join(tmpdir(), 'vaultwarden-fixture-'));
  mkdirSync(baseDir, { recursive: true });
  const filePath = join(baseDir, `credential-${randomBytes(4).toString('hex')}.env`);
  // Deliberately NOT a real secret: proves the tool result is a path, not a value.
  writeFileSync(filePath, 'FIXTURE_ONLY=not-a-real-secret\n', { mode: 0o600 });
  return filePath;
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    fail(null, 'Parse error');
    return;
  }

  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'vaultwarden-fixture', version: '1.0.0' },
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
      if (args.fail === true) {
        fail(id, `fixture: simulated execution failure for '${String(name)}'`);
        return;
      }
      switch (name) {
        case 'vault_status':
          respond(id, textContent('vaultwarden: ok'));
          return;
        case 'vault_list_local_ui':
          respond(id, textContent(JSON.stringify([{ id: 'ui_fixture', label: 'Local UI (fixture)' }])));
          return;
        case 'vault_get_metadata':
          respond(id, textContent(JSON.stringify({ item: String(args.item ?? 'fixture-item'), fields: ['username'] })));
          return;
        case 'vault_deliver_credential': {
          if (args.failResult === true) {
            respond(id, textContent('fixture: delivery failed', { isError: true }));
            return;
          }
          const filePath = deliverCredential(args);
          respond(id, textContent(filePath));
          return;
        }
        case 'vault_create_api_key':
          respond(id, textContent(JSON.stringify({ created: true, keyId: 'key_fixture', secret: null })));
          return;
        case 'vault_rotate_webui_login':
          respond(id, textContent(JSON.stringify({ rotated: true, item: String(args.item ?? 'fixture-item'), secret: null })));
          return;
        default:
          fail(id, `Unknown tool '${String(name)}'`);
          return;
      }
    }

    default:
      // Ignore unknown notifications; answer unknown requests with an error.
      if (id !== undefined && id !== null) fail(id, `Method not found: ${String(method)}`);
      return;
  }
});
