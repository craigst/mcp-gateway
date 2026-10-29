import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCodes } from '../../src/core/errors.js';
import type { AuthenticatedKey } from '../../src/core/types.js';
import { CredentialsApi, type CredentialsApiDeps } from '../../src/admin/credentials-api.js';
import {
  VAULTWARDEN_SAMPLE_VALUES,
  createCredentialsHarness,
  makeRoot,
  removeRoot,
  type CredentialsHarness,
} from './support.js';

const harnesses: CredentialsHarness[] = [];
const roots: string[] = [];

beforeEach(() => {
  roots.push(makeRoot('credentials-api-'));
});

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.dispose();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) removeRoot(root);
  }
});

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

function makeRequest(method: string, headers: Record<string, string> = {}, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const req = Readable.from(chunks) as unknown as IncomingMessage;
  const mutable = req as unknown as { method: string; url: string; headers: Record<string, string> };
  mutable.method = method;
  mutable.url = '/mcp/v1/admin/credentials';
  mutable.headers = {
    ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(JSON.stringify(body))) }),
    ...headers,
  };
  return req;
}

function makeResponse(): { res: ServerResponse; done: Promise<ApiResponse> } {
  let status = 0;
  let resolveDone: (value: ApiResponse) => void = () => {};
  const done = new Promise<ApiResponse>((resolve) => {
    resolveDone = resolve;
  });
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (chunk?: string) => {
      resolveDone({ status, body: chunk ? (JSON.parse(chunk) as Record<string, unknown>) : {} });
    },
  } as unknown as ServerResponse;
  return { res, done };
}

async function call(
  api: CredentialsApi,
  method: string,
  path: string,
  options: { key?: string; body?: unknown } = {},
): Promise<{ handled: boolean; response: ApiResponse }> {
  const headers: Record<string, string> = {};
  if (options.key !== undefined) headers.authorization = `Bearer ${options.key}`;
  const req = makeRequest(method, headers, options.body);
  const { res, done } = makeResponse();
  const handled = await api.handle(req, res, new URL(`http://localhost${path}`));
  if (!handled) return { handled, response: { status: 0, body: {} } };
  return { handled, response: await done };
}

interface ApiSetup {
  harness: CredentialsHarness;
  api: CredentialsApi;
  masterKey: string;
  agentKey: string;
}

function setup(): ApiSetup {
  const root = roots[roots.length - 1] as string;
  const harness = createCredentialsHarness(root);
  harnesses.push(harness);
  harness.registerVaultwardenServer();
  const masterKey = harness.keys.issue({ name: 'master-key', keyType: 'master' }).plaintext;
  const agentKey = harness.keys.issue({ name: 'agent-key', keyType: 'agent' }).plaintext;
  const api = new CredentialsApi({
    config: harness.config,
    keys: harness.keys,
    credentials: harness.credentials,
    audit: harness.audit,
  });
  return { harness, api, masterKey, agentKey };
}

describe('CredentialsApi (admin REST)', () => {
  it('requires a master key', async () => {
    const { api, agentKey } = setup();
    const anonymous = await call(api, 'GET', '/credentials/providers');
    expect(anonymous.response.status).toBe(401);
    expect(anonymous.response.body.error).toMatchObject({ code: ErrorCodes.KEY_INVALID });

    const agent = await call(api, 'GET', '/credentials/providers', { key: agentKey });
    expect(agent.response.status).toBe(403);
    expect(agent.response.body.error).toMatchObject({ code: ErrorCodes.ACCESS_DENIED });
  });

  it('serves provider statuses, descriptors and the default provider', async () => {
    const { api, masterKey } = setup();
    const { response } = await call(api, 'GET', '/credentials/providers', { key: masterKey });
    expect(response.status).toBe(200);
    const providers = response.body.providers as Array<Record<string, unknown>>;
    expect(providers.map((provider) => provider.id)).toEqual(['vaultwarden', 'onepassword', 'gateway']);
    expect(response.body.descriptors).toHaveLength(3);
    expect(response.body.defaultProvider).toBe('vaultwarden');
  });

  it('configures, tests and clears the Vaultwarden provider', async () => {
    const { api, harness, masterKey } = setup();

    const configured = await call(api, 'PUT', '/credentials/providers/vaultwarden', {
      key: masterKey,
      body: { values: VAULTWARDEN_SAMPLE_VALUES },
    });
    expect(configured.response.status).toBe(200);
    expect(configured.response.body.provider).toMatchObject({ configured: true, state: 'connected' });
    expect(configured.response.body.descriptor).toMatchObject({ id: 'vaultwarden' });
    expect(harness.vault.getSecret('CRED_VAULTWARDEN_BW_PASSWORD')).toBe('master-password-fixture-value');

    const tested = await call(api, 'POST', '/credentials/providers/vaultwarden/test', { key: masterKey });
    expect(tested.response.status).toBe(200);
    expect(tested.response.body.provider).toMatchObject({ state: 'connected' });

    const cleared = await call(api, 'DELETE', '/credentials/providers/vaultwarden', { key: masterKey });
    expect(cleared.response.status).toBe(200);
    expect(cleared.response.body.provider).toMatchObject({ configured: false, state: 'not-configured' });
  });

  it('persists the default provider', async () => {
    const { api, masterKey } = setup();
    const set = await call(api, 'POST', '/credentials/default', {
      key: masterKey,
      body: { providerId: 'gateway' },
    });
    expect(set.response.status).toBe(200);
    expect(set.response.body).toEqual({ defaultProvider: 'gateway' });

    const read = await call(api, 'GET', '/credentials/providers', { key: masterKey });
    expect(read.response.body.defaultProvider).toBe('gateway');

    const invalid = await call(api, 'POST', '/credentials/default', {
      key: masterKey,
      body: { providerId: 'nope' },
    });
    expect(invalid.response.status).toBe(400);
  });

  it('lists items (default provider) and reveals with an audit row that never contains the value', async () => {
    const { api, harness, masterKey } = setup();
    harness.vault.setSecret('API_TOKEN', 'gateway-secret-value');
    await harness.credentials.setDefault('gateway');

    const items = await call(api, 'GET', '/credentials/items?search=api&limit=5', { key: masterKey });
    expect(items.response.status).toBe(200);
    const listed = items.response.body.items as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: 'API_TOKEN', provider: 'gateway' });

    const revealed = await call(api, 'POST', '/credentials/reveal', {
      key: masterKey,
      body: { provider: 'gateway', itemId: 'API_TOKEN' },
    });
    expect(revealed.response.status).toBe(200);
    expect(revealed.response.body.reveal).toEqual({
      provider: 'gateway',
      itemId: 'API_TOKEN',
      field: 'value',
      value: 'gateway-secret-value',
    });

    const masterRecord = harness.keys.authenticate(masterKey);
    const audits = harness.audit.query({ method: 'admin.credential.reveal' });
    expect(audits.total).toBe(1);
    expect(audits.entries[0]).toMatchObject({
      keyId: masterRecord.id,
      method: 'admin.credential.reveal',
      status: 'ok',
    });
    expect(audits.entries[0]?.payload).toMatchObject({ provider: 'gateway', itemId: 'API_TOKEN' });
    expect(JSON.stringify(audits.entries)).not.toContain('gateway-secret-value');
  });

  it('validates bodies and unknown providers', async () => {
    const { api, masterKey } = setup();

    const badProvider = await call(api, 'PUT', '/credentials/providers/nope', {
      key: masterKey,
      body: { values: {} },
    });
    expect(badProvider.response.status).toBe(400);

    const badValues = await call(api, 'PUT', '/credentials/providers/vaultwarden', {
      key: masterKey,
      body: { values: 'not-an-object' },
    });
    expect(badValues.response.status).toBe(400);

    const missingValues = await call(api, 'PUT', '/credentials/providers/vaultwarden', {
      key: masterKey,
      body: { values: { VAULTWARDEN_URL: 'https://vault.example.internal' } },
    });
    expect(missingValues.response.status).toBe(400);

    const missingItem = await call(api, 'POST', '/credentials/reveal', {
      key: masterKey,
      body: { provider: 'gateway' },
    });
    expect(missingItem.response.status).toBe(400);

    const badQueryProvider = await call(api, 'GET', '/credentials/items?provider=nope', { key: masterKey });
    expect(badQueryProvider.response.status).toBe(400);
  });

  it('supports an injected session authenticator and audits the session principal', async () => {
    const { harness, masterKey } = setup();
    harness.vault.setSecret('API_TOKEN', 'gateway-secret-value');
    const authenticate = (req: IncomingMessage): AuthenticatedKey => {
      const isMaster = req.headers.authorization === 'Bearer session-master';
      return {
        id: isMaster ? 'ui:admin' : 'ui:guest',
        name: isMaster ? 'ui-admin' : 'ui-guest',
        keyType: isMaster ? 'master' : 'agent',
        keyPrefix: 'ui',
        serverGrants: [],
        delegationAllowed: false,
        escalationAllowed: false,
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        metadata: {},
      };
    };
    const api = new CredentialsApi({
      config: harness.config,
      keys: { authenticate: () => { throw new Error('unused'); } } as unknown as CredentialsApiDeps['keys'],
      credentials: harness.credentials,
      audit: harness.audit,
      authenticate,
    });

    expect((await call(api, 'GET', '/credentials/providers', { key: 'session-guest' })).response.status).toBe(403);
    expect((await call(api, 'GET', '/credentials/providers', { key: 'session-master' })).response.status).toBe(200);

    const revealed = await call(api, 'POST', '/credentials/reveal', {
      key: 'session-master',
      body: { provider: 'gateway', itemId: 'API_TOKEN' },
    });
    expect(revealed.response.status).toBe(200);
    const audits = harness.audit.query({ method: 'admin.credential.reveal' });
    expect(audits.entries[0]?.keyId).toBe('ui:admin');
    expect(masterKey.startsWith('mcp_master_')).toBe(true);
  });

  it('returns false for non-credential routes', async () => {
    const { api, masterKey } = setup();
    expect((await call(api, 'GET', '/servers', { key: masterKey })).handled).toBe(false);
    expect((await call(api, 'GET', '/credentials/nope', { key: masterKey })).handled).toBe(false);
    expect((await call(api, 'POST', '/credentials/providers/vaultwarden', { key: masterKey })).handled).toBe(false);
  });
});
