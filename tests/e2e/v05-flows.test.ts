/**
 * v0.5 end-to-end over HTTP:
 *   - prompts/resources discovery + JSON-RPC proxying
 *   - inspector overview: tools/prompts/resources/config/instructions
 *   - per-server activity: ok / error / denied requests, key attribution, filters
 *   - audited encrypted-configuration reveal
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createContainer, type GatewayContainer } from '../../src/container.js';
import type { GatewayConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import type { ServerRecord } from '../../src/core/types.js';

const FULL_FIXTURE = resolve('tests/fixtures/mcp-full-server.mjs');
const ECHO_FIXTURE = resolve('tests/fixtures/mcp-echo-server.mjs');

interface JsonResponse {
  status: number;
  body: any;
}

describe('v0.5 server inspector (HTTP)', () => {
  let container: GatewayContainer;
  let baseUrl: string;
  let masterKey: string;
  let fullServer: ServerRecord;
  let echoServer: ServerRecord;
  let agentKey: string;
  const rootDir = join(process.cwd(), '.test-data', `v05-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);

  const admin = async (method: string, path: string, body?: unknown): Promise<JsonResponse> => {
    const response = await fetch(`${baseUrl}/mcp/v1/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${masterKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const rpc = async (method: string, params?: unknown, key = masterKey): Promise<JsonResponse> => {
    const response = await fetch(`${baseUrl}/mcp/v1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'v05', method, params }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  beforeAll(async () => {
    mkdirSync(rootDir, { recursive: true });
    const config: GatewayConfig = {
      host: '127.0.0.1',
      port: 0,
      dataDir: rootDir,
      dbPath: join(rootDir, 'gateway.db'),
      uiDistDir: join(rootDir, 'ui'),
      vaultSecret: 'v05-vault-secret-0123456789abcdefgh',
      bootstrapMasterKey: `mcp_master_${'i'.repeat(48)}`,
      delegationMaxDepth: 3,
      gitImportAllowedPrefixes: [],
      reposDir: join(rootDir, 'repos'),
      logLevel: 'silent',
      requestBodyLimitBytes: 1_048_576,
      defaultToolTimeoutMs: 15_000,
      keyPepper: null,
      publicBaseUrl: 'http://127.0.0.1',
    };
    container = createContainer({ config, logger: createLogger('e2e-v05', 'silent') });
    baseUrl = (await container.start()).url;
    masterKey = config.bootstrapMasterKey as string;

    const full = await admin('POST', '/servers', {
      name: 'full-fixture',
      runtime: 'node',
      transport: 'stdio',
      command: process.execPath,
      args: [FULL_FIXTURE],
      env: { DEMO_SECRET: 'super-secret-value', DEMO_URL: 'http://demo.local:9000' },
      headers: { 'X-Demo-Key': 'header-secret-value' },
    });
    expect(full.status).toBe(201);
    fullServer = full.body.server;
    expect((await admin('POST', `/servers/${fullServer.id}/start`)).status).toBe(200);

    const echo = await admin('POST', '/servers', {
      name: 'echo',
      runtime: 'node',
      transport: 'stdio',
      command: process.execPath,
      args: [ECHO_FIXTURE],
      highPrivilegeTools: ['danger_delete'],
    });
    echoServer = echo.body.server;
    expect((await admin('POST', `/servers/${echoServer.id}/start`)).status).toBe(200);

    const key = await admin('POST', '/keys/create', {
      name: 'inspector-agent',
      keyType: 'agent',
      serverGrants: [{ serverId: echoServer.id, tools: ['echo', 'fail'] }],
      escalationAllowed: true,
    });
    agentKey = key.body.plaintext as string;
  });

  afterAll(async () => {
    if (container) {
      const dataDir = container.config.dataDir;
      await container.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('discovers and proxies prompts/resources for a permitted server', async () => {
    const prompts = await rpc('prompts/list', { serverId: fullServer.id });
    expect(prompts.body.result.total).toBe(2);
    expect(prompts.body.result.prompts.map((prompt: { name: string }) => prompt.name).sort()).toEqual([
      'review_code',
      'summarize',
    ]);
    const summarize = prompts.body.result.prompts.find((prompt: { name: string }) => prompt.name === 'summarize');
    expect(summarize.arguments[0]).toMatchObject({ name: 'topic', required: true });

    const got = await rpc('prompts/get', {
      name: 'summarize',
      arguments: { topic: 'release notes' },
      serverId: fullServer.id,
    });
    expect(got.body.result).toBeDefined();

    const resources = await rpc('resources/list', { serverId: fullServer.id });
    expect(resources.body.result.total).toBe(2);
    expect(resources.body.result.resources[0]).toMatchObject({ server_id: fullServer.id });

    const read = await rpc('resources/read', { uri: 'demo://readme', serverId: fullServer.id });
    expect(read.body.result).toBeDefined();

    const templates = await rpc('resources/templates/list', { serverId: fullServer.id });
    expect(templates.body.result.resourceTemplates.length).toBe(1);

    // An agent with no grant on this server cannot see its prompts.
    const agentPrompts = await rpc('prompts/list', { serverId: fullServer.id }, agentKey);
    expect(agentPrompts.body.error.code).toBe(-32002);
  });

  it('returns the full inspector overview with discovered capabilities', async () => {
    const overview = await admin('GET', `/servers/${fullServer.id}/inspector`);
    expect(overview.status).toBe(200);
    const body = overview.body;

    expect(body.server.name).toBe('full-fixture');
    expect(body.server.capabilities.prompts).toBeDefined();
    expect(typeof body.server.instructions).toBe('string');
    expect(body.tools.map((tool: { name: string }) => tool.name)).toContain('echo');
    expect(body.prompts.length).toBe(2);
    expect(body.resources.length).toBe(2);

    const secretEntry = body.config.env.find((entry: { key: string }) => entry.key === 'DEMO_SECRET');
    expect(secretEntry).toMatchObject({ masked: true, value: null });
    const urlEntry = body.config.env.find((entry: { key: string }) => entry.key === 'DEMO_URL');
    expect(urlEntry).toMatchObject({ masked: false, value: 'http://demo.local:9000' });
    expect(body.config.headers.find((entry: { key: string }) => entry.key === 'X-Demo-Key')).toMatchObject({
      masked: true,
    });
    expect(body.stats.total).toBe(0);
    expect(Array.isArray(body.keysUsed)).toBe(true);
  });

  it('reveals server env/header values with an audit trail', async () => {
    const revealed = await admin('POST', `/servers/${fullServer.id}/reveal`, {
      kind: 'env',
      key: 'DEMO_SECRET',
    });
    expect(revealed.status).toBe(200);
    expect(revealed.body).toEqual({ key: 'DEMO_SECRET', value: 'super-secret-value' });

    const header = await admin('POST', `/servers/${fullServer.id}/reveal`, {
      kind: 'header',
      key: 'X-Demo-Key',
    });
    expect(header.body.value).toBe('header-secret-value');

    const audit = await admin('GET', '/audit?method=admin.reveal&limit=10');
    expect(audit.body.total).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audit.body)).not.toContain('super-secret-value');
  });

  it('reveals an attached encrypted profile entry and lists it in the overview', async () => {
    const created = await admin('POST', '/config-profiles', {
      name: 'Inspector profile',
      entries: [{ key: 'PROFILE_TOKEN', value: 'profile-secret-value' }],
    });
    const profileId = created.body.profile.id as string;
    await admin('POST', `/config-profiles/${profileId}/apply`, {
      serverIds: [fullServer.id],
      restart: true,
      test: false,
    });

    const overview = await admin('GET', `/servers/${fullServer.id}/inspector`);
    const profile = overview.body.config.profiles.find((entry: { id: string }) => entry.id === profileId);
    expect(profile.entries).toEqual([{ key: 'PROFILE_TOKEN', source: 'encrypted', ref: null }]);
    expect(JSON.stringify(overview.body)).not.toContain('profile-secret-value');

    const revealed = await admin('POST', `/servers/${fullServer.id}/reveal`, {
      kind: 'profile',
      profileId,
      key: 'PROFILE_TOKEN',
    });
    expect(revealed.body.value).toBe('profile-secret-value');
  });

  it('tracks ok, failed and denied requests per server with key attribution', async () => {
    const ok = await rpc('tools/call', { name: 'echo', arguments: { text: 'hello' }, serverId: echoServer.id }, agentKey);
    expect(ok.body.result.content[0].text).toBe('hello');

    const failed = await rpc('tools/call', { name: 'does_not_exist', arguments: {}, serverId: echoServer.id }, agentKey);
    expect(failed.body.error.code).toBe(-32002);

    const denied = await rpc('tools/call', { name: 'danger_delete', arguments: { target: 'prod' }, serverId: echoServer.id }, agentKey);
    expect(denied.body.error.code).toBe(-32001);

    const overview = await admin('GET', `/servers/${echoServer.id}/inspector`);
    const stats = overview.body.stats;
    expect(stats.total).toBeGreaterThanOrEqual(3);
    expect(stats.ok).toBeGreaterThanOrEqual(1);
    expect(stats.error).toBeGreaterThanOrEqual(1);
    expect(stats.denied).toBeGreaterThanOrEqual(1);
    expect(stats.errorRate).toBeGreaterThan(0);
    expect(stats.lastUsedAt).toBeTruthy();
    expect(overview.body.keysUsed.length).toBeGreaterThanOrEqual(1);
    expect(overview.body.keysUsed[0].keyName).toBe('inspector-agent');
    expect(overview.body.keysUsed[0].keyPrefix.length).toBeGreaterThan(0);

    const deniedOnly = await admin('GET', `/servers/${echoServer.id}/activity?status=denied&limit=10`);
    expect(deniedOnly.status).toBe(200);
    expect(deniedOnly.body.entries.every((entry: { status: string }) => entry.status === 'denied')).toBe(true);
    expect(deniedOnly.body.summary.denied).toBeGreaterThanOrEqual(1);

    const keyed = await admin(`GET`, `/servers/${echoServer.id}/activity?keyId=${overview.body.keysUsed[0].keyId}`);
    expect(keyed.body.entries.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects inspector access for non-master keys and unknown servers', async () => {
    const response = await fetch(`${baseUrl}/mcp/v1/admin/servers/${echoServer.id}/inspector`, {
      headers: { authorization: `Bearer ${agentKey}` },
    });
    expect(response.status).toBe(403);

    const missing = await admin('GET', '/servers/srv_missing/inspector');
    expect(missing.status).toBe(404);
  });
});
