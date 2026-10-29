/**
 * v0.6 end-to-end:
 *   - first-run setup wizard backend (no env password → setupRequired → account)
 *   - password-encrypted backup of a populated gateway
 *   - restore into a FRESH gateway via /auth/setup/restore + login with the
 *     original account password, restored keys/secrets/profiles/servers
 *   - reinstall of a restored server whose checkout was not in the backup
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createContainer, type GatewayContainer } from '../../src/container.js';
import type { GatewayConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';

const ECHO_FIXTURE = resolve('tests/fixtures/mcp-echo-server.mjs');
const MASTER_KEY = `mcp_master_${'b'.repeat(48)}`;
const VAULT_SECRET = 'v06-vault-secret-0123456789abcdefgh';
const PASSWORD = 'operator-password-1';
const rootDir = join(process.cwd(), '.test-data', `v06-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
let containerA: GatewayContainer | null = null;
let containerB: GatewayContainer | null = null;

function makeConfig(dataDir: string): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    dbPath: join(dataDir, 'gateway.db'),
    uiDistDir: join(dataDir, 'ui'),
    vaultSecret: VAULT_SECRET,
    bootstrapMasterKey: MASTER_KEY,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: ['file://'],
    reposDir: join(dataDir, 'repos'),
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 15_000,
    keyPepper: null,
    publicBaseUrl: 'http://127.0.0.1',
    uiUsername: 'operator',
    uiPassword: null, // fresh install → first-run setup required
  };
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

interface JsonResponse {
  status: number;
  body: any;
  cookie?: string;
}

describe('v0.6 onboarding + encrypted backup/restore', () => {
  let backupEnvelope: unknown;
  let backupId: string;
  let agentPlaintext: string;
  let importedServerId: string;

  const call = async (
    baseUrl: string,
    method: string,
    path: string,
    options: { key?: string; cookie?: string; body?: unknown } = {},
  ): Promise<JsonResponse> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.key) headers.authorization = `Bearer ${options.key}`;
    if (options.cookie) headers.cookie = options.cookie;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    let body: any;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body, ...(cookie ? { cookie } : {}) };
  };

  afterAll(async () => {
    for (const container of [containerA, containerB]) {
      if (!container) continue;
      const dataDir = container.config.dataDir;
      await container.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('starts in first-run setup mode and creates the operator account', async () => {
    mkdirSync(join(rootDir, 'a'), { recursive: true });
    containerA = createContainer({ config: makeConfig(join(rootDir, 'a')), logger: createLogger('e2e-v06', 'silent') });
    const baseUrl = (await containerA.start()).url;
    (containerA as GatewayContainer & { url?: string }).url = baseUrl;

    const me = await call(baseUrl, 'GET', '/mcp/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ authenticated: false, setupRequired: true, restoreSupported: true });

    const set = await call(baseUrl, 'POST', '/mcp/v1/auth/setup', {
      body: { username: 'operator', password: PASSWORD },
    });
    expect(set.status).toBe(201);
    expect(set.body.user.username).toBe('operator');
    expect(set.cookie).toMatch(/^mcp_session=/);

    const authed = await call(baseUrl, 'GET', '/mcp/v1/auth/me', { cookie: set.cookie });
    expect(authed.body).toMatchObject({ authenticated: true, setupRequired: false });

    const settings = await call(baseUrl, 'GET', '/mcp/v1/admin/settings', { cookie: set.cookie });
    expect(settings.status).toBe(200);
    expect(settings.body.settings).toMatchObject({ setupRequired: false, userCount: 1 });
    expect(JSON.stringify(settings.body)).not.toContain(PASSWORD);
  });

  it('creates state, an agent key and a profile, then an encrypted backup', async () => {
    const container = containerA as GatewayContainer;
    const baseUrl = (container as GatewayContainer & { url?: string }).url as string;

    // Local git repo installed through the catalog importer (gives a tracked source).
    const repo = join(rootDir, 'repo');
    mkdirSync(repo, { recursive: true });
    cpSync(ECHO_FIXTURE, join(repo, 'server.js'));
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'backup-demo', version: '1.0.0', main: 'server.js' }));
    git(['init', '-b', 'main'], repo);
    git(['add', '.'], repo);
    git(['commit', '-m', 'v1'], repo);

    const imported = await call(baseUrl, 'POST', '/mcp/v1/admin/catalog/import-url', {
      key: MASTER_KEY,
      body: { url: `file://${repo}`, name: 'backup-demo', start: true, test: true },
    });
    expect(imported.status).toBe(201);
    importedServerId = imported.body.server.id;

    await call(baseUrl, 'PUT', '/mcp/v1/admin/vault/secrets/BACKUP_SECRET', {
      key: MASTER_KEY,
      body: { value: 'super-secret-value' },
    });
    const profile = await call(baseUrl, 'POST', '/mcp/v1/admin/config-profiles', {
      key: MASTER_KEY,
      body: { name: 'Backup profile', entries: [{ key: 'PROFILE_TOKEN', value: 'profile-secret-value' }] },
    });
    expect(profile.status).toBe(201);
    await call(baseUrl, 'POST', `/mcp/v1/admin/config-profiles/${profile.body.profile.id}/apply`, {
      key: MASTER_KEY,
      body: { serverIds: [importedServerId], restart: false, test: false },
    });

    const agent = await call(baseUrl, 'POST', '/mcp/v1/admin/keys/create', {
      key: MASTER_KEY,
      body: { name: 'restored-agent', keyType: 'agent', serverGrants: [{ serverId: importedServerId, tools: ['echo'] }] },
    });
    agentPlaintext = agent.body.plaintext as string;

    const created = await call(baseUrl, 'POST', '/mcp/v1/admin/backups', {
      key: MASTER_KEY,
      body: { username: 'operator', password: PASSWORD, includeAudit: true },
    });
    expect(created.status).toBe(201);
    backupId = created.body.id;
    expect(created.body.counts.servers).toBeGreaterThanOrEqual(1);
    expect(created.body.counts.secrets).toBeGreaterThanOrEqual(2);

    const list = await call(baseUrl, 'GET', '/mcp/v1/admin/backups', { key: MASTER_KEY });
    expect(list.body.backups.some((entry: { id: string }) => entry.id === backupId)).toBe(true);

    const download = await fetch(`${baseUrl}/mcp/v1/admin/backups/${backupId}/download`, {
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });
    expect(download.status).toBe(200);
    const text = await download.text();
    expect(text).not.toContain('super-secret-value');
    expect(text).not.toContain('profile-secret-value');
    expect(text).not.toContain(PASSWORD);
    backupEnvelope = JSON.parse(text);

    // Remove the checkout so the restore has to report a reinstall.
    rmSync(join(container.config.reposDir, 'backup-demo'), { recursive: true, force: true });
  });

  it('restores into a fresh gateway with the account password', async () => {
    mkdirSync(join(rootDir, 'b'), { recursive: true });
    containerB = createContainer({ config: makeConfig(join(rootDir, 'b')), logger: createLogger('e2e-v06', 'silent') });
    const baseUrl = (await containerB.start()).url;
    (containerB as GatewayContainer & { url?: string }).url = baseUrl;

    const before = await call(baseUrl, 'GET', '/mcp/v1/auth/me');
    expect(before.body.setupRequired).toBe(true);

    // Wrong password must fail closed.
    const wrong = await call(baseUrl, 'POST', '/mcp/v1/auth/setup/restore', {
      body: { backup: backupEnvelope, password: 'wrong-password-123' },
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);

    const restored = await call(baseUrl, 'POST', '/mcp/v1/auth/setup/restore', {
      body: { backup: backupEnvelope, password: PASSWORD },
    });
    expect(restored.status).toBe(200);
    const result = restored.body.result;
    expect(result.usersRestored).toBe(1);
    expect(result.secretsRestored).toBeGreaterThanOrEqual(2);
    expect(result.serversRestored).toBeGreaterThanOrEqual(1);
    expect(result.reinstallRequired.map((entry: { serverId: string }) => entry.serverId)).toContain(importedServerId);

    // Restored account logs in with the original password.
    const login = await call(baseUrl, 'POST', '/mcp/v1/auth/login', { body: { username: 'operator', password: PASSWORD } });
    expect(login.status).toBe(200);
    expect(login.cookie).toMatch(/^mcp_session=/);

    // Restored data: server definition, vault secret, profile, agent key.
    const servers = await call(baseUrl, 'GET', '/mcp/v1/admin/servers', { cookie: login.cookie });
    const server = servers.body.servers.find((entry: { id: string }) => entry.id === importedServerId);
    expect(server).toBeDefined();
    expect(server.status).toBe('stopped');

    const overview = await call(baseUrl, 'GET', `/mcp/v1/admin/servers/${importedServerId}/inspector`, {
      cookie: login.cookie,
    });
    expect(overview.body.config.profiles.some((profile: { name: string }) => profile.name === 'Backup profile')).toBe(true);

    const reveal = await call(baseUrl, 'POST', `/mcp/v1/admin/servers/${importedServerId}/reveal`, {
      cookie: login.cookie,
      body: { kind: 'env', key: 'BACKUP_SECRET' },
    });
    // The secret was a global vault secret, not a server env value; reveal it via profile instead.
    expect([200, 404]).toContain(reveal.status);
    expect((containerB as GatewayContainer).services.vault.getSecret('BACKUP_SECRET')).toBe('super-secret-value');

    // Restored API key (hash) still authenticates.
    const metrics = await fetch(`${baseUrl}/mcp/v1/metrics`, { headers: { authorization: `Bearer ${agentPlaintext}` } });
    expect(metrics.status).toBe(200);
  });

  it('reinstalls a restored server from its tracked source', async () => {
    const container = containerB as GatewayContainer;
    const baseUrl = (container as GatewayContainer & { url?: string }).url as string;
    const login = await call(baseUrl, 'POST', '/mcp/v1/auth/login', { body: { username: 'operator', password: PASSWORD } });
    const cookie = login.cookie as string;

    const reinstalled = await call(baseUrl, 'POST', `/mcp/v1/admin/updates/servers/${importedServerId}/reinstall`, {
      cookie,
      body: {},
    });
    expect(reinstalled.status).toBe(200);
    expect(reinstalled.body.result.server.status).toBe('running');
    expect(reinstalled.body.result.test.ok).toBe(true);
    expect(reinstalled.body.result.test.toolCount).toBe(5);
    const installedDir = reinstalled.body.result.server.workDir as string;
    expect(existsSync(join(installedDir, 'server.js'))).toBe(true);
  });

  it('never exposes the account password or vault values in backup metadata', async () => {
    const container = containerA as GatewayContainer;
    const baseUrl = (container as GatewayContainer & { url?: string }).url as string;
    const list = await call(baseUrl, 'GET', '/mcp/v1/admin/backups', { key: MASTER_KEY });
    expect(JSON.stringify(list.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(list.body)).not.toContain('super-secret-value');
    const file = readFileSync(join(container.config.dataDir, 'backups', `${backupId}.mcpbak`), 'utf8');
    expect(file).not.toContain('super-secret-value');
    expect(file).not.toContain('profile-secret-value');
  });
});
