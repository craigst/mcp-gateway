import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCodes } from '../../src/core/errors.js';
import type { AuthenticatedKey } from '../../src/core/types.js';
import { ConfigProfilesApi } from '../../src/admin/config-profiles-api.js';
import { profileEnvSecretName } from '../../src/config_profiles/index.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';
import {
  addEnvServer,
  createHarness,
  jsonBody,
  mockRequest,
  mockResponse,
  serverProfileIds,
  silentLogger,
  type Harness,
  type MockResponse,
} from './support.js';

let harness: Harness;
let keys: SqliteKeyService;
let master: string;
let agent: string;
let api: ConfigProfilesApi;

beforeEach(() => {
  harness = createHarness();
  keys = new SqliteKeyService(harness.db, { logger: silentLogger() });
  master = keys.issue({ name: 'master', keyType: 'master' }).plaintext;
  agent = keys.issue({ name: 'agent', keyType: 'agent' }).plaintext;
  api = new ConfigProfilesApi({
    config: harness.config,
    keys,
    configProfiles: harness.service,
    logger: silentLogger(),
  });
});

afterEach(async () => {
  await harness.close();
});

interface CallOptions {
  headers?: Record<string, string>;
  body?: unknown;
  key?: string | null;
}

interface CallResult {
  handled: boolean;
  res: MockResponse;
  json: () => any;
}

async function call(
  method: string,
  path: string,
  options: CallOptions = {},
  handler: ConfigProfilesApi = api,
): Promise<CallResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const key = options.key === undefined ? master : options.key;
  if (key !== null) headers.authorization = `Bearer ${key}`;
  const request = mockRequest({ method, headers, body: options.body });
  const response = mockResponse();
  const handled = await handler.handle(
    request,
    response.asServerResponse(),
    new URL(`http://localhost:8080${path}`),
  );
  return { handled, res: response, json: () => jsonBody(response) };
}

const BASE = '/mcp/v1/admin/config-profiles';

async function createProfile(body: Record<string, unknown>): Promise<{ id: string }> {
  const result = await call('POST', BASE, { body });
  expect(result.res.statusCode).toBe(201);
  return result.json().profile as { id: string };
}

describe('ConfigProfilesApi auth and routing', () => {
  it('returns false for non-config-profile admin paths', async () => {
    const result = await call('GET', '/mcp/v1/admin/servers');
    expect(result.handled).toBe(false);
    expect(result.res.payload).toBe('');
  });

  it('requires a master credential', async () => {
    const anonymous = await call('GET', BASE, { key: null });
    expect(anonymous.res.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe(ErrorCodes.KEY_INVALID);

    const withAgent = await call('GET', BASE, { key: agent });
    expect(withAgent.res.statusCode).toBe(403);
    expect(withAgent.json().error.data.reason).toBe('SCOPE_RESTRICTION');
  });

  it('accepts an injected session authenticator', async () => {
    const masterPrincipal: AuthenticatedKey = keys.authenticate(master);
    const sessionApi = new ConfigProfilesApi({
      config: harness.config,
      keys,
      configProfiles: harness.service,
      logger: silentLogger(),
      authenticate: () => masterPrincipal,
    });
    const ok = await call('GET', BASE, { key: null }, sessionApi);
    expect(ok.res.statusCode).toBe(200);
    expect(ok.json()).toEqual({ profiles: [] });

    const agentPrincipal: AuthenticatedKey = keys.authenticate(agent);
    const deniedApi = new ConfigProfilesApi({
      config: harness.config,
      keys,
      configProfiles: harness.service,
      logger: silentLogger(),
      authenticate: () => agentPrincipal,
    });
    const denied = await call('GET', BASE, { key: null }, deniedApi);
    expect(denied.res.statusCode).toBe(403);
  });

  it('returns 405 for unsupported methods and 404 for unknown endpoints', async () => {
    expect((await call('PUT', BASE, { body: {} })).res.statusCode).toBe(405);
    expect((await call('GET', `${BASE}/some-id/apply`)).res.statusCode).toBe(405);
    const unknown = await call('GET', `${BASE}/some-id/unknown`);
    expect(unknown.res.statusCode).toBe(404);
    expect(unknown.handled).toBe(true);
  });
});

describe('ConfigProfilesApi CRUD', () => {
  it('creates, lists and reads profiles without exposing values', async () => {
    harness.vault.setSecret('EXISTING_TOKEN', 'existing-vault-value');
    const created = await call('POST', BASE, {
      body: {
        name: 'Internal services',
        description: 'Shared upstream config',
        entries: [
          { key: 'API_URL', value: 'http://10.1.2.3:5678' },
          { key: 'API_TOKEN', secretRef: 'EXISTING_TOKEN' },
        ],
        headers: [{ key: 'X-Api-Key', value: 'header-secret-value' }],
      },
    });

    expect(created.res.statusCode).toBe(201);
    const profile = created.json().profile;
    expect(profile.id).toMatch(/^cfg_/);
    expect(profile.attachedServerIds).toEqual([]);
    expect(profile.entries).toEqual([
      { key: 'API_URL', source: 'encrypted', ref: null },
      { key: 'API_TOKEN', source: 'vault-ref', ref: 'EXISTING_TOKEN' },
    ]);
    expect(profile.headers).toEqual([{ key: 'X-Api-Key', source: 'encrypted', ref: null }]);
    for (const secret of ['http://10.1.2.3:5678', 'header-secret-value']) {
      expect(created.res.payload).not.toContain(secret);
    }

    const listed = await call('GET', BASE);
    expect(listed.res.statusCode).toBe(200);
    expect(listed.json().profiles).toHaveLength(1);
    expect(listed.res.payload).not.toContain('header-secret-value');

    const fetched = await call('GET', `${BASE}/${profile.id}`);
    expect(fetched.res.statusCode).toBe(200);
    expect(fetched.json().profile.id).toBe(profile.id);
    expect(fetched.res.payload).not.toContain('http://10.1.2.3:5678');
  });

  it('returns 400 for invalid bodies and 404 for missing profiles', async () => {
    expect((await call('POST', BASE, { body: {} })).res.statusCode).toBe(400);
    expect(
      (await call('POST', BASE, { body: { name: 'Bad', entries: [{ key: '1BAD', value: 'v' }] } }))
        .res.statusCode,
    ).toBe(400);
    expect(
      (await call('POST', BASE, { body: { name: 'Bad', entries: [{ key: 'K' }] } })).res.statusCode,
    ).toBe(400);
    expect((await call('GET', `${BASE}/cfg_missing`)).res.statusCode).toBe(404);
    expect((await call('PUT', `${BASE}/cfg_missing`, { body: { name: 'X' } })).res.statusCode).toBe(
      404,
    );
    expect((await call('DELETE', `${BASE}/cfg_missing`)).res.statusCode).toBe(404);
  });

  it('updates (rotates) a profile and deletes it with its vault secrets', async () => {
    const { id } = await createProfile({
      name: 'Rotating',
      entries: [{ key: 'API_TOKEN', value: 'first-value' }],
    });
    const secretName = profileEnvSecretName(id, 'API_TOKEN');
    expect(harness.vault.getSecret(secretName)).toBe('first-value');

    const updated = await call('PUT', `${BASE}/${id}`, {
      body: { name: 'Rotating', entries: [{ key: 'API_TOKEN', value: 'second-value' }] },
    });
    expect(updated.res.statusCode).toBe(200);
    expect(updated.res.payload).not.toContain('second-value');
    expect(harness.vault.getSecret(secretName)).toBe('second-value');

    const deleted = await call('DELETE', `${BASE}/${id}`);
    expect(deleted.res.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });
    expect(harness.vault.getSecret(secretName)).toBeNull();
    expect(harness.service.get(id)).toBeNull();
    expect((await call('GET', `${BASE}/${id}`)).res.statusCode).toBe(404);
  });
});

describe('ConfigProfilesApi apply / detach', () => {
  it('applies a profile to several servers without restarting when asked', async () => {
    const first = addEnvServer(harness, { id: 'srv_a', name: 'env-fixture-a' });
    const second = addEnvServer(harness, { id: 'srv_b', name: 'env-fixture-b' });
    const { id } = await createProfile({
      name: 'Apply me',
      entries: [{ key: 'API_URL', value: 'http://apply' }],
    });

    const result = await call('POST', `${BASE}/${id}/apply`, {
      body: { serverIds: [first.id, second.id], restart: false, test: false },
    });

    expect(result.res.statusCode).toBe(200);
    const results = result.json().results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    for (const entry of results) {
      expect(entry).toMatchObject({ applied: true, restarted: false, test: null, error: null });
    }
    expect(serverProfileIds(harness, first.id)).toEqual([id]);
    expect(serverProfileIds(harness, second.id)).toEqual([id]);

    const listed = await call('GET', `${BASE}/${id}`);
    expect(listed.json().profile.attachedServerIds.sort()).toEqual(['srv_a', 'srv_b']);
  });

  it('rejects malformed apply bodies', async () => {
    const { id } = await createProfile({ name: 'No servers' });
    expect((await call('POST', `${BASE}/${id}/apply`, { body: {} })).res.statusCode).toBe(400);
    expect(
      (await call('POST', `${BASE}/${id}/apply`, { body: { serverIds: [] } })).res.statusCode,
    ).toBe(400);
    expect(
      (await call('POST', `${BASE}/${id}/apply`, { body: { serverIds: ['srv_a'], restart: 'yes' } }))
        .res.statusCode,
    ).toBe(400);
  });

  it('detaches one server', async () => {
    const first = addEnvServer(harness, { id: 'srv_a', name: 'env-fixture-a' });
    const second = addEnvServer(harness, { id: 'srv_b', name: 'env-fixture-b' });
    const { id } = await createProfile({ name: 'Detach' });
    await call('POST', `${BASE}/${id}/apply`, {
      body: { serverIds: [first.id, second.id], restart: false },
    });

    const detached = await call('DELETE', `${BASE}/${id}/servers/${first.id}`);
    expect(detached.res.statusCode).toBe(200);
    expect(detached.json()).toEqual({ detached: true });
    expect(serverProfileIds(harness, first.id)).toEqual([]);
    expect(serverProfileIds(harness, second.id)).toEqual([id]);
  });
});

describe('ConfigProfilesApi migrate-env-file', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mcp-profile-api-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('migrates a legacy env file into an encrypted attached profile', async () => {
    const envFile = join(tempDir, 'legacy.env');
    writeFileSync(envFile, 'API_URL=http://legacy\nAPI_TOKEN=legacy-secret-token\n');
    const server = addEnvServer(harness, { envFile, name: 'legacy' });

    const result = await call('POST', `${BASE}/migrate-env-file`, {
      body: { serverId: server.id, name: 'Migrated legacy' },
    });

    expect(result.res.statusCode).toBe(201);
    const profile = result.json().profile;
    expect(profile.name).toBe('Migrated legacy');
    expect(profile.attachedServerIds).toEqual([server.id]);
    expect(result.res.payload).not.toContain('legacy-secret-token');
    expect(harness.repository.getServer(server.id)?.envFile).toBeNull();
    expect(harness.vault.getSecret(profileEnvSecretName(profile.id, 'API_TOKEN'))).toBe(
      'legacy-secret-token',
    );

    expect(
      (await call('POST', `${BASE}/migrate-env-file`, { body: {} })).res.statusCode,
    ).toBe(400);
  });
});

describe('ConfigProfilesApi credential references', () => {
  it('accepts credentialRef entries and masks them in responses', async () => {
    harness.vault.setSecret('SHARED_TOKEN', 'shared-value');
    const created = await call('POST', BASE, {
      body: {
        name: 'Mixed credential sources',
        entries: [
          { key: 'API_URL', value: 'https://api.example.test' },
          { key: 'SHARED_TOKEN', secretRef: 'SHARED_TOKEN' },
          {
            key: 'VW_KEY',
            credentialRef: { provider: 'vaultwarden', itemId: 'vw-1', field: 'password' },
          },
        ],
        headers: [
          { key: 'X-Key', credentialRef: { provider: 'onepassword', itemId: 'op-2' } },
        ],
      },
    });

    expect(created.res.statusCode).toBe(201);
    const profile = created.json().profile;
    expect(profile.entries).toEqual([
      { key: 'API_URL', source: 'encrypted', ref: null },
      { key: 'SHARED_TOKEN', source: 'vault-ref', ref: 'SHARED_TOKEN' },
      {
        key: 'VW_KEY',
        source: 'credential-ref',
        ref: null,
        provider: 'vaultwarden',
        itemId: 'vw-1',
        field: 'password',
      },
    ]);
    expect(profile.headers).toEqual([
      {
        key: 'X-Key',
        source: 'credential-ref',
        ref: null,
        provider: 'onepassword',
        itemId: 'op-2',
        field: null,
      },
    ]);

    // Metadata only: no vault entry was created for the external reference, and no
    // configuration value leaks through the API.
    expect(harness.vault.getSecret(profileEnvSecretName(profile.id, 'VW_KEY'))).toBeNull();
    expect(created.res.payload).not.toContain('shared-value');
    expect(created.res.payload).not.toContain('https://api.example.test');

    const listed = await call('GET', BASE);
    expect(listed.json().profiles).toHaveLength(1);
    expect(listed.json().profiles[0].headers[0]).toMatchObject({
      source: 'credential-ref',
      provider: 'onepassword',
      itemId: 'op-2',
    });
  });

  it('keeps credential provider metadata for key-only update rows', async () => {
    const created = await call('POST', BASE, {
      body: {
        name: 'Keep ref',
        entries: [
          {
            key: 'VW_KEY',
            credentialRef: { provider: 'vaultwarden', itemId: 'vw-1', field: 'password' },
          },
        ],
      },
    });
    const profileId = created.json().profile.id as string;

    const updated = await call('PUT', `${BASE}/${profileId}`, {
      body: { name: 'Keep ref', entries: [{ key: 'VW_KEY' }] },
    });
    expect(updated.res.statusCode).toBe(200);
    expect(updated.json().profile.entries).toEqual([
      {
        key: 'VW_KEY',
        source: 'credential-ref',
        ref: null,
        provider: 'vaultwarden',
        itemId: 'vw-1',
        field: 'password',
      },
    ]);
  });

  it('validates credential references at the API boundary', async () => {
    const badRefs: unknown[] = [
      { provider: 'bitwarden', itemId: 'x' },
      { provider: 'vaultwarden', itemId: '' },
      { provider: 'vaultwarden' },
      { provider: 'gateway', itemId: 'x', field: 42 },
      'vaultwarden:x',
    ];
    for (const credentialRef of badRefs) {
      const result = await call('POST', BASE, {
        body: { name: 'Bad ref', entries: [{ key: 'API_KEY', credentialRef }] },
      });
      expect(result.res.statusCode).toBe(400);
      expect(result.json().error.code).toBe(ErrorCodes.INVALID_PARAMS);
    }
  });

  it('resolves credential refs for an applied server', async () => {
    const server = addEnvServer(harness);
    const created = await call('POST', BASE, {
      body: {
        name: 'Applied ref',
        entries: [
          { key: 'EXTERNAL_TOKEN', credentialRef: { provider: 'gateway', itemId: 'gw-1' } },
        ],
      },
    });
    const profileId = created.json().profile.id as string;

    const applied = await call('POST', `${BASE}/${profileId}/apply`, {
      body: { serverIds: [server.id], restart: false },
    });
    expect(applied.res.statusCode).toBe(200);
    expect(applied.json().results[0]).toMatchObject({ applied: true, error: null });
    expect(serverProfileIds(harness, server.id)).toEqual([profileId]);
    expect(harness.service.resolveForServer(server.id).credentialRefs).toEqual([
      { key: 'EXTERNAL_TOKEN', target: 'env', provider: 'gateway', itemId: 'gw-1', field: null },
    ]);
  });
});
