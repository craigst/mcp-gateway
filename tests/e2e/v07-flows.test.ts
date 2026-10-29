/**
 * v0.7 end-to-end: credential providers.
 *   - Vaultwarden (default) configured through the admin API, mcp.env materialised
 *     for the imported connector, listing/reveal via the connector's MCP tools
 *   - 1Password Connect (fake server) configured with an API token, list/reveal
 *   - gateway vault provider (builtin)
 *   - configuration-profile credential reference resolved at server start
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createContainer, type GatewayContainer } from '../../src/container.js';
import type { GatewayConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';

const VAULTWARDEN_FIXTURE = resolve('tests/fixtures/vaultwarden-fake-server.mjs');
const ENV_FIXTURE = resolve('tests/config_profiles/fixtures/env-server.mjs');
const MASTER_KEY = `mcp_master_${'c'.repeat(48)}`;
const VAULT_SECRET = 'v07-vault-secret-0123456789abcdefgh';
const OP_TOKEN = 'op-connect-token-value';
const OP_SECRET = 'op-connect-secret-value';
const rootDir = join(process.cwd(), '.test-data', `v07-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
let container: GatewayContainer | null = null;
let fakeOp: Server | null = null;

function config(): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir: join(rootDir, 'data'),
    dbPath: join(rootDir, 'data', 'gateway.db'),
    uiDistDir: join(rootDir, 'ui'),
    vaultSecret: VAULT_SECRET,
    bootstrapMasterKey: MASTER_KEY,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: [],
    reposDir: join(rootDir, 'repos'),
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 15_000,
    keyPepper: null,
    publicBaseUrl: 'http://127.0.0.1',
  };
}

function sendJson(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function startFakeOnepassword(): Promise<string> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.headers.authorization !== `Bearer ${OP_TOKEN}`) {
      sendJson(res, 401, { message: 'invalid token' });
      return;
    }
    if (url.pathname === '/v1/vaults') {
      sendJson(res, 200, [{ id: 'vault1', name: 'Demo vault' }]);
      return;
    }
    if (/^\/v1\/vaults\/vault1\/items$/.test(url.pathname)) {
      sendJson(res, 200, [{ id: 'item1', title: 'Example API token', category: 'LOGIN', urls: [{ href: 'https://example.internal' }] }]);
      return;
    }
    if (/^\/v1\/vaults\/vault1\/items\/item1$/.test(url.pathname)) {
      sendJson(res, 200, {
        id: 'item1',
        title: 'Example API token',
        category: 'LOGIN',
        urls: [{ href: 'https://example.internal' }],
        fields: [
          { id: 'username', label: 'username', type: 'STRING', value: 'example-user' },
          { id: 'password', label: 'password', type: 'CONCEALED', value: OP_SECRET },
        ],
      });
      return;
    }
    sendJson(res, 404, { message: 'not found' });
  });
  fakeOp = server;
  return new Promise((resolveUrl) => {
    server.listen(0, '127.0.0.1', () => resolveUrl(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

interface JsonResponse {
  status: number;
  body: any;
}

describe('v0.7 credential providers', () => {
  let baseUrl: string;
  let vaultwardenServerId: string;
  let envServerId: string;
  let fakeOpUrl: string;

  const admin = async (method: string, path: string, body?: unknown): Promise<JsonResponse> => {
    const response = await fetch(`${baseUrl}/mcp/v1/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${MASTER_KEY}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const rpc = async (method: string, params?: unknown): Promise<JsonResponse> => {
    const response = await fetch(`${baseUrl}/mcp/v1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${MASTER_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'v07', method, params }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  afterAll(async () => {
    if (fakeOp) await new Promise<void>((done) => fakeOp?.close(() => done()));
    if (container) {
      const dataDir = container.config.dataDir;
      await container.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('registers the connector + profile target and reports providers with Vaultwarden default', async () => {
    mkdirSync(join(rootDir, 'home'), { recursive: true });
    container = createContainer({
      config: config(),
      logger: createLogger('e2e-v07', 'silent'),
      credentialHomeDir: join(rootDir, 'home'),
    });
    baseUrl = (await container.start()).url;

    const vaultwarden = await admin('POST', '/servers', {
      name: 'vaultwarden',
      runtime: 'node',
      transport: 'stdio',
      command: process.execPath,
      args: [VAULTWARDEN_FIXTURE],
    });
    vaultwardenServerId = vaultwarden.body.server.id;
    expect((await admin('POST', `/servers/${vaultwardenServerId}/start`)).status).toBe(200);

    const envServer = await admin('POST', '/servers', {
      name: 'env-report',
      runtime: 'node',
      transport: 'stdio',
      command: process.execPath,
      args: [ENV_FIXTURE],
    });
    envServerId = envServer.body.server.id;
    expect((await admin('POST', `/servers/${envServerId}/start`)).status).toBe(200);

    const providers = await admin('GET', '/credentials/providers');
    expect(providers.status).toBe(200);
    expect(providers.body.defaultProvider).toBe('vaultwarden');
    expect(providers.body.descriptors.map((descriptor: { id: string }) => descriptor.id)).toEqual([
      'vaultwarden',
      'onepassword',
      'gateway',
    ]);
    const vaultwardenStatus = providers.body.providers.find((provider: { id: string }) => provider.id === 'vaultwarden');
    expect(vaultwardenStatus).toMatchObject({ configured: false, isDefault: true, state: 'not-configured' });
  });

  it('lists and reveals built-in gateway vault secrets', async () => {
    await admin('PUT', '/vault/secrets/GATEWAY_API_KEY', { value: 'gateway-vault-value' });
    const items = await admin('GET', '/credentials/items?provider=gateway');
    expect(items.body.items.map((item: { id: string }) => item.id)).toContain('GATEWAY_API_KEY');

    const reveal = await admin('POST', '/credentials/reveal', {
      provider: 'gateway',
      itemId: 'GATEWAY_API_KEY',
    });
    expect(reveal.body.reveal.value).toBe('gateway-vault-value');

    const audit = await admin('GET', '/audit?method=admin.credential.reveal&limit=10');
    expect(audit.body.total).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audit.body)).not.toContain('gateway-vault-value');
  });

  it('configures Vaultwarden, materialises mcp.env and lists/reveals connector items', async () => {
    const configured = await admin('PUT', '/credentials/providers/vaultwarden', {
      values: {
        VAULTWARDEN_URL: 'https://vault.example.internal',
        BW_CLIENTID: 'user.00000000-0000-0000-0000-000000000000',
        BW_CLIENTSECRET: 'client-secret-fixture',
        BW_PASSWORD: 'master-password-fixture',
      },
    });
    expect(configured.status).toBe(200);
    expect(configured.body.provider).toMatchObject({ id: 'vaultwarden', configured: true });

    const envPath = join(rootDir, 'home', '.config', 'vaultwarden', 'mcp.env');
    const envText = readFileSync(envPath, 'utf8');
    expect(envText).toContain('VAULTWARDEN_URL=https://vault.example.internal');
    expect(envText).toContain('BW_PASSWORD=master-password-fixture');
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect((statSync(join(rootDir, 'home', '.config', 'vaultwarden')).mode & 0o777)).toBe(0o700);

    const tested = await admin('POST', '/credentials/providers/vaultwarden/test');
    expect(tested.body.provider).toMatchObject({ state: 'connected' });
    expect(tested.body.provider.message).toContain('vaultwarden: ok');

    const items = await admin('GET', '/credentials/items?provider=vaultwarden');
    expect(items.body.items).toHaveLength(1);
    expect(items.body.items[0]).toMatchObject({ id: 'ui_fixture', name: 'Local UI (fixture)' });

    const reveal = await admin('POST', '/credentials/reveal', {
      provider: 'vaultwarden',
      itemId: 'ui_fixture',
    });
    expect(reveal.body.reveal).toMatchObject({ provider: 'vaultwarden', itemId: 'ui_fixture', field: 'password' });
    expect(reveal.body.reveal.value).toBe('not-a-real-secret');

    // The connector secrets never leak through status or audit payloads.
    const providers = await admin('GET', '/credentials/providers');
    expect(JSON.stringify(providers.body)).not.toContain('master-password-fixture');
    const audit = await admin('GET', '/audit?method=admin.credential.reveal&limit=10');
    expect(JSON.stringify(audit.body)).not.toContain('not-a-real-secret');
  });

  it('configures 1Password as the default provider with an API token', async () => {
    fakeOpUrl = await startFakeOnepassword();
    const configured = await admin('PUT', '/credentials/providers/onepassword', {
      values: { OP_CONNECT_HOST: fakeOpUrl, OP_CONNECT_TOKEN: OP_TOKEN },
    });
    expect(configured.status).toBe(200);
    expect(configured.body.provider).toMatchObject({ configured: true, state: 'connected', isDefault: false });

    const tested = await admin('POST', '/credentials/providers/onepassword/test');
    expect(tested.body.provider.state).toBe('connected');

    const items = await admin('GET', '/credentials/items?provider=onepassword');
    expect(items.body.items).toEqual([
      {
        provider: 'onepassword',
        id: 'vault1/item1',
        name: 'Example API token',
        username: null,
        category: 'LOGIN',
        urls: ['https://example.internal'],
        fields: ['password'],
      },
    ]);

    const reveal = await admin('POST', '/credentials/reveal', {
      provider: 'onepassword',
      itemId: 'vault1/item1',
      field: 'password',
    });
    expect(reveal.body.reveal.value).toBe(OP_SECRET);

    const madeDefault = await admin('POST', '/credentials/default', { providerId: 'onepassword' });
    expect(madeDefault.body.defaultProvider).toBe('onepassword');
    const providers = await admin('GET', '/credentials/providers');
    expect(providers.body.defaultProvider).toBe('onepassword');
    const vaultwardenStatus = providers.body.providers.find((provider: { id: string }) => provider.id === 'vaultwarden');
    expect(vaultwardenStatus.isDefault).toBe(false);
  });

  it('injects a password-manager item into a sub-server via a profile reference', async () => {
    const profile = await admin('POST', '/config-profiles', {
      name: 'Managed by 1Password',
      entries: [
        { key: 'INJECTED_TOKEN', credentialRef: { provider: 'onepassword', itemId: 'vault1/item1', field: 'password' } },
        { key: 'PLAIN_VALUE', value: 'plain-value-here' },
      ],
    });
    expect(profile.status).toBe(201);
    expect(profile.body.profile.entries).toEqual(
      expect.arrayContaining([
        { key: 'INJECTED_TOKEN', source: 'credential-ref', ref: null, provider: 'onepassword', itemId: 'vault1/item1', field: 'password' },
      ]),
    );

    const applied = await admin('POST', `/config-profiles/${profile.body.profile.id}/apply`, {
      serverIds: [envServerId],
      restart: true,
      test: false,
    });
    expect(applied.status).toBe(200);

    const call = await rpc('tools/call', {
      name: 'env_report',
      serverId: envServerId,
      arguments: { keys: ['INJECTED_TOKEN', 'PLAIN_VALUE'] },
    });
    expect(call.status).toBe(200);
    const report = JSON.parse(call.body.result.content[0].text);
    expect(report.INJECTED_TOKEN).toBe(OP_SECRET);
    expect(report.PLAIN_VALUE).toBe('plain-value-here');
  });

  it('rejects agent keys and unknown providers', async () => {
    const agent = await admin('POST', '/keys/create', { name: 'cred-agent', keyType: 'agent' });
    const response = await fetch(`${baseUrl}/mcp/v1/admin/credentials/providers`, {
      headers: { authorization: `Bearer ${agent.body.plaintext}` },
    });
    expect(response.status).toBe(403);

    const unknown = await admin('GET', '/credentials/items?provider=does-not-exist');
    expect(unknown.status).toBeGreaterThanOrEqual(400);
  });
});
