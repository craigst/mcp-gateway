import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import { credentialSecretName } from '../../src/credentials/index.js';
import {
  VAULTWARDEN_SAMPLE_VALUES,
  createCredentialsHarness,
  gatewaySecretNameFor,
  makeRoot,
  removeRoot,
  vaultwardenEnvPath,
  type CredentialsHarness,
} from './support.js';

const harnesses: CredentialsHarness[] = [];
const roots: string[] = [];

beforeEach(() => {
  roots.push(makeRoot('credentials-vaultwarden-'));
});

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.dispose();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) removeRoot(root);
  }
});

function setup(withServer = true): CredentialsHarness {
  const root = roots[roots.length - 1] as string;
  const harness = createCredentialsHarness(root);
  harnesses.push(harness);
  if (withServer) harness.registerVaultwardenServer();
  return harness;
}

describe('vaultwarden credential provider', () => {
  it('stores credentials encrypted, writes a 0600 mcp.env and reports connected', async () => {
    const harness = setup();
    const status = await harness.credentials.configure('vaultwarden', VAULTWARDEN_SAMPLE_VALUES);

    expect(status).toMatchObject({
      id: 'vaultwarden',
      kind: 'password-manager',
      configured: true,
      available: true,
      state: 'connected',
      isDefault: true,
    });
    // Status messages/details never contain the secret values.
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('client-secret-fixture-value');
    expect(serialized).not.toContain('master-password-fixture-value');

    // Values are encrypted in the gateway vault, never in SQLite/SQLite-visible JSON.
    expect(harness.vault.getSecret(credentialSecretName('vaultwarden', 'BW_CLIENTSECRET'))).toBe(
      'client-secret-fixture-value',
    );
    expect(harness.vault.getSecret(credentialSecretName('vaultwarden', 'BW_PASSWORD'))).toBe(
      'master-password-fixture-value',
    );
    expect(harness.vault.getSecret(gatewaySecretNameFor('vaultwarden', 'VAULTWARDEN_URL'))).toBe(
      'https://vault.example.internal',
    );
    const dbDump = JSON.stringify(
      harness.db
        .prepare("SELECT * FROM settings UNION ALL SELECT '' AS key, '' AS value")
        .all(),
    );
    expect(dbDump).not.toContain('master-password-fixture-value');

    // mcp.env is materialised with restrictive permissions.
    const envPath = vaultwardenEnvPath(harness);
    expect(existsSync(envPath)).toBe(true);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(statSync(`${harness.homeDir}/.config/vaultwarden`).mode & 0o777).toBe(0o700);
    const env = readFileSync(envPath, 'utf8');
    expect(env).toContain('VAULTWARDEN_URL=https://vault.example.internal');
    expect(env).toContain('BW_CLIENTSECRET=client-secret-fixture-value');
    expect(env).toContain('VAULT_ORG_ID=org-fixture');
    expect(env).not.toContain('VAULT_COLLECTION_ID=');

    // The server record points at the env file so a restart picks it up.
    expect(harness.repository.getServerByName('vaultwarden')?.envFile).toBe(envPath);
  });

  it('tests the connection through vault_status and starts the server', async () => {
    const harness = setup();
    await harness.credentials.configure('vaultwarden', VAULTWARDEN_SAMPLE_VALUES);

    const tested = await harness.credentials.test('vaultwarden');
    expect(tested.state).toBe('connected');
    expect(tested.message).toContain('vaultwarden: ok');
    expect(harness.supervisor.status('srv_vaultwarden0001')).toBe('running');
  });

  it('falls back to vault_list_local_ui for listing and filters client-side', async () => {
    const harness = setup();
    await harness.credentials.configure('vaultwarden', VAULTWARDEN_SAMPLE_VALUES);

    const items = await harness.credentials.listItems('vaultwarden');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      provider: 'vaultwarden',
      id: 'ui_fixture',
      name: 'Local UI (fixture)',
      username: null,
      fields: ['password'],
    });

    expect(await harness.credentials.listItems('vaultwarden', { search: 'local ui' })).toHaveLength(1);
    expect(await harness.credentials.listItems('vaultwarden', { search: 'does-not-exist' })).toHaveLength(0);
    expect(await harness.credentials.listItems('vaultwarden', { limit: 0 })).toHaveLength(1);
  });

  it('reveals through vault_deliver_credential, reading and deleting the delivery file', async () => {
    const harness = setup();
    await harness.credentials.configure('vaultwarden', VAULTWARDEN_SAMPLE_VALUES);

    const revealed = await harness.credentials.reveal('vaultwarden', 'ui_fixture');
    expect(revealed).toEqual({
      provider: 'vaultwarden',
      itemId: 'ui_fixture',
      field: 'password',
      value: 'not-a-real-secret',
    });

    // Requesting the delivered key by name also works.
    const byField = await harness.credentials.reveal('vaultwarden', 'ui_fixture', 'FIXTURE_ONLY');
    expect(byField.value).toBe('not-a-real-secret');
    expect(JSON.stringify(byField)).not.toContain('master-password-fixture-value');
  });

  it('clears configuration, removing vault keys and the mcp.env file', async () => {
    const harness = setup();
    await harness.credentials.configure('vaultwarden', VAULTWARDEN_SAMPLE_VALUES);
    const envPath = vaultwardenEnvPath(harness);
    expect(existsSync(envPath)).toBe(true);

    const cleared = await harness.credentials.clear('vaultwarden');
    expect(cleared).toMatchObject({ configured: false, state: 'not-configured' });
    expect(existsSync(envPath)).toBe(false);
    expect(harness.vault.getSecret(credentialSecretName('vaultwarden', 'BW_PASSWORD'))).toBeNull();
    await expect(harness.credentials.listItems('vaultwarden')).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
    });
    await expect(harness.credentials.reveal('vaultwarden', 'ui_fixture')).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
    });
  });

  it('validates required fields and rejects unsafe values', async () => {
    const harness = setup();
    await expect(
      harness.credentials.configure('vaultwarden', { VAULTWARDEN_URL: 'https://vault.example.internal' }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
    await expect(
      harness.credentials.configure('vaultwarden', {
        ...VAULTWARDEN_SAMPLE_VALUES,
        BW_PASSWORD: 'line1\nline2',
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
    expect(harness.vault.getSecret(credentialSecretName('vaultwarden', 'BW_PASSWORD'))).toBeNull();
  });

  it('reports unavailable when the vaultwarden server is not installed', async () => {
    const harness = setup(false);
    const configured = await harness.credentials.configure('vaultwarden', VAULTWARDEN_SAMPLE_VALUES);
    expect(configured).toMatchObject({ configured: true, available: false, state: 'unavailable' });

    try {
      await harness.credentials.listItems('vaultwarden');
      throw new Error('expected listItems to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe(ErrorCodes.TOOL_NOT_FOUND);
      expect((error as GatewayError).message).toContain('not installed');
    }
  });

  it('initialize() rewrites the mcp.env after a container restart', async () => {
    const harness = setup();
    await harness.credentials.configure('vaultwarden', VAULTWARDEN_SAMPLE_VALUES);
    const envPath = vaultwardenEnvPath(harness);
    rmSync(envPath, { force: true });
    expect(existsSync(envPath)).toBe(false);

    await harness.credentials.initialize();
    expect(existsSync(envPath)).toBe(true);
    expect(readFileSync(envPath, 'utf8')).toContain('BW_PASSWORD=master-password-fixture-value');
  });
});
