/**
 * v0.4 end-to-end over HTTP:
 *   - install from a local git repo, detect an update on a newer commit,
 *     update in place (restart + probe) with config preserved
 *   - encrypted configuration profiles: create with inline-encrypted and
 *     vault-reference values, apply to a live MCP server, verify injection,
 *     detach and legacy env-file migration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createContainer, type GatewayContainer } from '../../src/container.js';
import type { GatewayConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import type { ServerRecord } from '../../src/core/types.js';

const ECHO_FIXTURE = resolve('tests/fixtures/mcp-echo-server.mjs');
const ENV_FIXTURE = resolve('tests/config_profiles/fixtures/env-server.mjs');

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

interface JsonResponse {
  status: number;
  body: any;
}

describe('v0.4 update manager + encrypted profiles (HTTP)', () => {
  let container: GatewayContainer;
  let baseUrl: string;
  let masterKey: string;
  let repoDir: string;
  let installedServer: ServerRecord;
  const rootDir = join(process.cwd(), '.test-data', `v04-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);

  const admin = async (method: string, path: string, body?: unknown): Promise<JsonResponse> => {
    const response = await fetch(`${baseUrl}/mcp/v1/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${masterKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const rpc = async (method: string, params?: unknown): Promise<JsonResponse> => {
    const response = await fetch(`${baseUrl}/mcp/v1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${masterKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'v04', method, params }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  beforeAll(async () => {
    mkdirSync(rootDir, { recursive: true });
    repoDir = join(rootDir, 'local-mcp-repo');
    mkdirSync(repoDir, { recursive: true });
    cpSync(ECHO_FIXTURE, join(repoDir, 'server.js'));
    writeFileSync(
      join(repoDir, 'package.json'),
      JSON.stringify({ name: 'update-fixture', version: '1.0.0', main: 'server.js' }, null, 2),
    );
    git(['init', '-b', 'main'], repoDir);
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'v1.0.0'], repoDir);

    const config: GatewayConfig = {
      host: '127.0.0.1',
      port: 0,
      dataDir: rootDir,
      dbPath: join(rootDir, 'gateway.db'),
      uiDistDir: join(rootDir, 'ui'),
      vaultSecret: 'v04-vault-secret-0123456789abcdefgh',
      bootstrapMasterKey: `mcp_master_${'u'.repeat(48)}`,
      delegationMaxDepth: 3,
      gitImportAllowedPrefixes: ['file://'],
      reposDir: join(rootDir, 'repos'),
      logLevel: 'silent',
      requestBodyLimitBytes: 1_048_576,
      defaultToolTimeoutMs: 15_000,
      keyPepper: null,
      publicBaseUrl: 'http://127.0.0.1',
    };
    container = createContainer({ config, logger: createLogger('e2e-v04', 'silent') });
    baseUrl = (await container.start()).url;
    masterKey = config.bootstrapMasterKey as string;
  });

  afterAll(async () => {
    if (container) {
      const dataDir = container.config.dataDir;
      await container.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('installs a repo and records its upstream source', async () => {
    const imported = await admin('POST', '/catalog/import-url', {
      url: `file://${repoDir}`,
      name: 'update-demo',
      start: true,
      test: true,
    });
    expect(imported.status).toBe(201);
    installedServer = imported.body.server as ServerRecord;
    expect(imported.body.test.ok).toBe(true);

    const updates = await admin('GET', '/updates');
    expect(updates.status).toBe(200);
    const source = updates.body.sources.find((entry: { serverId: string }) => entry.serverId === installedServer.id);
    expect(source).toBeDefined();
    expect(source.installedVersion).toBe('1.0.0');
    expect(source.installedCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('detects a newer commit upstream', async () => {
    writeFileSync(
      join(repoDir, 'package.json'),
      JSON.stringify({ name: 'update-fixture', version: '1.1.0', main: 'server.js' }, null, 2),
    );
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'v1.1.0'], repoDir);

    const checked = await admin('POST', '/updates/check', { serverIds: [installedServer.id] });
    expect(checked.status).toBe(200);
    const result = checked.body.results[0];
    expect(result.updateAvailable).toBe(true);
    expect(result.fromVersion).toBe('1.0.0');
    expect(result.toCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.fromCommit).not.toBe(result.toCommit);
  });

  it('updates the server in place: staged, restarted and probe-tested', async () => {
    const updated = await admin('POST', `/updates/servers/${installedServer.id}/update`, {
      restart: true,
      test: true,
    });
    expect(updated.status).toBe(200);
    const result = updated.body.result;
    expect(result.changed).toBe(true);
    expect(result.before.version).toBe('1.0.0');
    expect(result.after.version).toBe('1.1.0');
    expect(result.after.commit).not.toBe(result.before.commit);
    expect(result.server.status).toBe('running');
    expect(result.test.ok).toBe(true);
    expect(result.test.toolCount).toBe(5);

    const updates = await admin('GET', '/updates');
    const source = updates.body.sources.find((entry: { serverId: string }) => entry.serverId === installedServer.id);
    expect(source.updateAvailable).toBe(false);
    expect(source.installedVersion).toBe('1.1.0');

    // Tools still execute after the update.
    const listed = await rpc('tools/list', { serverId: installedServer.id });
    expect((listed.body.result.tools as Array<{ name: string }>).length).toBe(5);
  });

  it('creates an encrypted profile and applies it to a live server', async () => {
    await admin('PUT', '/vault/secrets/SHARED_DEMO_TOKEN', { value: 'vault-ref-value' });

    const created = await admin('POST', '/config-profiles', {
      name: 'Demo service wiring',
      description: 'Encrypted values and a vault reference',
      entries: [
        { key: 'DEMO_URL', value: 'http://demo.internal:1234' },
        { key: 'DEMO_TOKEN', secretRef: 'SHARED_DEMO_TOKEN' },
      ],
    });
    expect(created.status).toBe(201);
    const profile = created.body.profile;
    expect(profile.entries).toEqual([
      { key: 'DEMO_URL', source: 'encrypted', ref: null },
      { key: 'DEMO_TOKEN', source: 'vault-ref', ref: 'SHARED_DEMO_TOKEN' },
    ]);
    expect(JSON.stringify(created.body)).not.toContain('http://demo.internal:1234');
    expect(JSON.stringify(created.body)).not.toContain('vault-ref-value');

    // A server whose tool reports its environment proves the injection.
    const server = await admin('POST', '/servers', {
      name: 'env-report',
      runtime: 'node',
      transport: 'stdio',
      command: process.execPath,
      args: [ENV_FIXTURE],
    });
    expect(server.status).toBe(201);
    const serverId = server.body.server.id as string;

    const applied = await admin('POST', `/config-profiles/${profile.id}/apply`, {
      serverIds: [serverId],
      restart: true,
      test: true,
    });
    expect(applied.status).toBe(200);
    expect(applied.body.results[0].test.ok).toBe(true);

    const rpcServer = await rpc('tools/call', {
      name: 'env_report',
      arguments: { keys: ['DEMO_URL', 'DEMO_TOKEN'] },
      serverId,
    });
    const injected = JSON.parse(rpcServer.body.result.content[0].text);
    expect(injected.DEMO_URL).toBe('http://demo.internal:1234');
    expect(injected.DEMO_TOKEN).toBe('vault-ref-value');

    // Listing never returns values.
    const listed = await admin('GET', '/config-profiles');
    expect(JSON.stringify(listed.body)).not.toContain('vault-ref-value');
    expect(JSON.stringify(listed.body)).not.toContain('http://demo.internal:1234');
  });

  it('keeps values when a profile is edited with blank rows', async () => {
    const listed = await admin('GET', '/config-profiles');
    const profile = listed.body.profiles[0];
    const updated = await admin('PUT', `/config-profiles/${profile.id}`, {
      name: profile.name,
      description: profile.description,
      entries: [{ key: 'DEMO_URL' }, { key: 'DEMO_TOKEN', secretRef: 'SHARED_DEMO_TOKEN' }],
    });
    expect(updated.status).toBe(200);

    const serverList = await admin('GET', '/servers');
    const server = serverList.body.servers.find((entry: ServerRecord) => entry.name === 'env-report');
    await admin('POST', `/config-profiles/${profile.id}/apply`, {
      serverIds: [server.id],
      restart: true,
      test: false,
    });
    const rpcCall = await rpc('tools/call', {
      name: 'env_report',
      arguments: { keys: ['DEMO_URL'] },
      serverId: server.id,
    });
    expect(JSON.parse(rpcCall.body.result.content[0].text).DEMO_URL).toBe('http://demo.internal:1234');
  });

  it('migrates a legacy env file into an encrypted profile and clears it', async () => {
    const envFile = join(rootDir, 'legacy.env');
    writeFileSync(envFile, 'LEGACY_URL=http://legacy.example\nLEGACY_TOKEN=legacy-secret\n');

    const created = await admin('POST', '/servers', {
      name: 'legacy-env',
      runtime: 'node',
      transport: 'stdio',
      command: process.execPath,
      args: [ENV_FIXTURE],
      envFile,
    });
    const serverId = created.body.server.id as string;

    const migrated = await admin('POST', '/config-profiles/migrate-env-file', {
      serverId,
      name: 'Legacy env migrated',
    });
    expect(migrated.status).toBe(201);
    expect(migrated.body.profile.entries.length).toBe(2);
    expect(JSON.stringify(migrated.body)).not.toContain('legacy-secret');

    const servers = await admin('GET', '/servers');
    expect(servers.body.servers.find((entry: ServerRecord) => entry.id === serverId).envFile).toBeNull();

    const applied = await admin('POST', `/config-profiles/${migrated.body.profile.id}/apply`, {
      serverIds: [serverId],
      restart: true,
      test: false,
    });
    expect(applied.status).toBe(200);
    const rpcCall = await rpc('tools/call', {
      name: 'env_report',
      arguments: { keys: ['LEGACY_URL', 'LEGACY_TOKEN'] },
      serverId,
    });
    const env = JSON.parse(rpcCall.body.result.content[0].text);
    expect(env.LEGACY_URL).toBe('http://legacy.example');
    expect(env.LEGACY_TOKEN).toBe('legacy-secret');
    expect(existsSync(envFile)).toBe(true); // the original file is untouched
  });
});
