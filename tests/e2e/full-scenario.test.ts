/**
 * End-to-end scenario covering Phases 2, 4 and 5 together:
 *
 *   vault secret → git import (clone + manifest build) → sub-server start
 *   → zero-trust catalog → scoped execution → observer delegation
 *   → depth guard → escalation ticket → audit/delegation traces.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createContainer, type GatewayContainer } from '../../src/container.js';
import type { GatewayConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import type { ServerRecord } from '../../src/core/types.js';

const ECHO_FIXTURE = resolve('tests/fixtures/mcp-echo-server.mjs');
const MANIFEST_FIXTURE = resolve('tests/fixtures/manifest-repo');

interface JsonResponse {
  status: number;
  body: any;
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'MCP Gateway Tests',
      GIT_AUTHOR_EMAIL: 'tests@example.invalid',
      GIT_COMMITTER_NAME: 'MCP Gateway Tests',
      GIT_COMMITTER_EMAIL: 'tests@example.invalid',
    },
  });
}

async function startFakeObserver(): Promise<{ url: string; requests: unknown[]; close: () => Promise<void> }> {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'approved',
          verdict: 'payload looks safe',
          approval_token: 'apr_e2e_token',
          output: { reviewed: true },
        }),
      );
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

describe('end-to-end: vault → git import → catalog → delegation', () => {
  let container: GatewayContainer;
  let baseUrl: string;
  let masterKey: string;
  let repoDir: string;
  let observer: Awaited<ReturnType<typeof startFakeObserver>>;
  let importedServer: ServerRecord;

  const rpc = async (
    key: string,
    method: string,
    params?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<JsonResponse> => {
    const response = await fetch(`${baseUrl}/mcp/v1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'e2e', method, params }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const admin = async (method: string, path: string, body?: unknown): Promise<JsonResponse> => {
    const response = await fetch(`${baseUrl}/mcp/v1/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${masterKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  beforeAll(async () => {
    const dataDir = join(process.cwd(), '.test-data', `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    repoDir = join(dataDir, 'local-repo');
    mkdirSync(repoDir, { recursive: true });
    cpSync(MANIFEST_FIXTURE, repoDir, { recursive: true });
    git(['init', '-b', 'main'], repoDir);
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'fixture import repo'], repoDir);

    const config: GatewayConfig = {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      dbPath: join(dataDir, 'gateway.db'),
      uiDistDir: join(dataDir, 'ui'),
      vaultSecret: 'e2e-vault-secret-0123456789abcdefghij',
      bootstrapMasterKey: `mcp_master_${'e'.repeat(48)}`,
      delegationMaxDepth: 3,
      gitImportAllowedPrefixes: ['file://'],
      reposDir: join(dataDir, 'repos'),
      logLevel: 'silent',
      requestBodyLimitBytes: 1_048_576,
      defaultToolTimeoutMs: 15_000,
      keyPepper: null,
      publicBaseUrl: 'http://127.0.0.1',
    };

    container = createContainer({ config, logger: createLogger('e2e', 'silent') });
    baseUrl = (await container.start()).url;
    masterKey = config.bootstrapMasterKey as string;
    observer = await startFakeObserver();
    container.services.delegation.addTarget({
      id: 'observer-bot',
      name: 'Observer Bot',
      url: observer.url,
      protocol: 'http',
      timeoutMs: 5_000,
    });
  });

  afterAll(async () => {
    await observer?.close();
    if (container) {
      const dataDir = container.config.dataDir;
      await container.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('seeds a vault secret required by the imported manifest', async () => {
    const stored = await admin('PUT', '/vault/secrets/FIXTURE_API_TOKEN', { value: 'fixture-token-e2e' });
    expect(stored.status).toBe(200);
  });

  it('imports a git repository, runs the manifest build and starts the sub-server', async () => {
    const imported = await admin('POST', '/servers/import', {
      url: `file://${repoDir}`,
      name: 'fixture-import',
      startAfterBuild: true,
      // Override the manifest's start command with the shared echo fixture so the
      // E2E can exercise catalog + execution against a real stdio process.
      startCommand: `node ${ECHO_FIXTURE}`,
    });

    expect(imported.status).toBe(201);
    importedServer = imported.body.server as ServerRecord;
    expect(importedServer.name).toBe('fixture-import');
    expect(importedServer.status).toBe('running');
    expect(importedServer.runtime).toBe('node');
    expect(importedServer.delegationSupported).toBe(true);
    expect(importedServer.highPrivilegeTools).toContain('danger_delete');

    const builtFile = join(container.config.reposDir, 'fixture-import', 'built.txt');
    expect(existsSync(builtFile)).toBe(true);
    const buildArtifact = JSON.parse(readFileSync(builtFile, 'utf8')) as { built: boolean; hasToken: boolean };
    expect(buildArtifact.built).toBe(true);
    expect(buildArtifact.hasToken).toBe(true);
  });

  it('rejects a clone URL outside the allowlist', async () => {
    const rejected = await admin('POST', '/servers/import', { url: 'https://example.com/evil/repo.git' });
    expect(rejected.status).toBe(403);
    expect(rejected.body.error.data.reason).toBe('GIT_IMPORT_URL_NOT_ALLOWED');
  });

  it('exposes imported tools to the master key and marks the high-privilege one', async () => {
    const listed = await rpc(masterKey, 'tools/list', { serverId: importedServer.id });
    const tools = listed.body.result.tools as Array<{ name: string; tool_id: string }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual(['add', 'danger_delete', 'echo', 'fail', 'slow']);
    const highPrivilege = listed.body.result.tools.find((tool: { name: string }) => tool.name === 'danger_delete');
    expect(highPrivilege).toBeDefined();
  });

  it('enforces scoped access on the imported server', async () => {
    const created = await admin('POST', '/keys/create', {
      name: 'e2e-agent',
      keyType: 'agent',
      serverGrants: [{ serverId: importedServer.id, tools: ['echo'] }],
      escalationAllowed: true,
      delegationAllowed: true,
    });
    const agentKey = created.body.plaintext as string;

    const initialized = await rpc(agentKey, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    expect(initialized.body.result.serverInfo.name).toBe('mcp-gateway');
    await rpc(agentKey, 'tools/search', { query: 'echo', limit: 5 });

    const visible = await rpc(agentKey, 'tools/list');
    expect((visible.body.result.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(['echo']);

    const executed = await rpc(agentKey, 'tools/call', { name: 'echo', arguments: { text: 'imported!' } });
    expect(executed.body.result.content[0].text).toBe('imported!');

    const denied = await rpc(agentKey, 'tools/call', { name: 'danger_delete', arguments: { target: 'prod' } });
    expect(denied.body.error.code).toBe(-32001);
    expect(denied.body.error.data.ticket_id).toBeTruthy();

    // Keep the key for the delegation test.
    (globalThis as Record<string, unknown>).__e2eAgentKey = agentKey;
  });

  it('delegates to a remote observer harness and records the trace', async () => {
    const agentKey = (globalThis as Record<string, unknown>).__e2eAgentKey as string;
    const delegated = await rpc(agentKey, 'agents/delegate', {
      targetId: 'observer-bot',
      payload: { action: 'deploy', target: 'staging' },
      mode: 'observe_and_verify',
    });

    expect(delegated.body.result.status).toBe('approved');
    expect(delegated.body.result.verdict).toBe('payload looks safe');
    expect(delegated.body.result.approval_token).toBe('apr_e2e_token');
    expect(delegated.body.result.depth).toBe(1);

    expect(observer.requests.length).toBeGreaterThan(0);
    const forwarded = observer.requests[0] as { headers: Record<string, string>; body: any };
    expect(forwarded.headers['x-mcp-delegation-depth']).toBe('1');
    expect(forwarded.body.payload).toEqual({ action: 'deploy', target: 'staging' });

    const traces = await admin('GET', '/delegations');
    expect(traces.body.traces.length).toBeGreaterThan(0);
    expect(traces.body.traces[0]).toEqual(expect.objectContaining({ target: 'observer-bot', status: 'approved' }));
  });

  it('hard-caps delegation recursion at depth 3', async () => {
    const agentKey = (globalThis as Record<string, unknown>).__e2eAgentKey as string;
    const blocked = await rpc(
      agentKey,
      'agents/delegate',
      { targetId: 'observer-bot', payload: { loop: true } },
      { 'x-mcp-delegation-depth': '3' },
    );
    expect(blocked.body.error.code).toBe(-32003);
    expect(blocked.body.error.data.reason).toBe('DELEGATION_DEPTH_EXCEEDED');
  });

  it('creates an escalation ticket an agent can request explicitly', async () => {
    const agentKey = (globalThis as Record<string, unknown>).__e2eAgentKey as string;
    const requested = await rpc(agentKey, 'escalations/request', {
      toolId: 'danger_delete',
      reason: 'HIGH_PRIVILEGE_RESTRICTION',
      requestPayload: { target: 'prod' },
    });
    expect(requested.body.result.status).toBe('pending');
    expect(requested.body.result.ticket_id).toMatch(/^esc-/);

    const listed = await admin('GET', '/escalations?status=pending');
    expect(listed.body.escalations.length).toBeGreaterThanOrEqual(1);
  });

  it('has a complete audit trail across discovery, execution, denial and delegation', async () => {
    const audit = await admin('GET', '/audit?limit=200');
    const methods = (audit.body.entries as Array<{ method: string }>).map((entry) => entry.method);
    expect(methods).toEqual(
      expect.arrayContaining(['initialize', 'tools/list', 'tools/search', 'tools/call', 'agents/delegate']),
    );
  });
});
