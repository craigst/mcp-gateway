import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import { DefaultCredentialProviderService, PROVIDER_IDS } from '../../src/credentials/index.js';
import {
  createCredentialsHarness,
  makeRoot,
  removeRoot,
  type CredentialsHarness,
} from './support.js';

const harnesses: CredentialsHarness[] = [];
const roots: string[] = [];

beforeEach(() => {
  roots.push(makeRoot('credentials-gateway-'));
});

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.dispose();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) removeRoot(root);
  }
});

function setup(vaultSecret: string | null = undefined as unknown as string): CredentialsHarness {
  const root = roots[roots.length - 1] as string;
  const harness = createCredentialsHarness(root, vaultSecret === null ? { vaultSecret: null } : {});
  harnesses.push(harness);
  return harness;
}

describe('gateway credential provider', () => {
  it('lists, searches and reveals gateway vault secrets', async () => {
    const harness = setup();
    harness.vault.setSecret('API_TOKEN', 'gateway-secret-value');
    harness.vault.setSecret('GITHUB_TOKEN', 'gateway-github-value');

    const providers = await harness.credentials.listProviders();
    expect(providers.map((provider) => provider.id)).toEqual([...PROVIDER_IDS]);
    const gateway = providers.find((provider) => provider.id === 'gateway');
    expect(gateway).toMatchObject({
      kind: 'builtin',
      configured: true,
      available: true,
      state: 'connected',
      isDefault: false,
    });
    expect(gateway?.message).toContain('2 encrypted secret');

    const descriptors = harness.credentials.descriptors();
    expect(descriptors.map((descriptor) => descriptor.id).sort()).toEqual([...PROVIDER_IDS].sort());
    expect(descriptors.find((descriptor) => descriptor.id === 'vaultwarden')?.fields.map((field) => field.key)).toEqual([
      'VAULTWARDEN_URL',
      'BW_CLIENTID',
      'BW_CLIENTSECRET',
      'BW_PASSWORD',
      'VAULT_ORG_ID',
      'VAULT_COLLECTION_ID',
    ]);
    expect(
      descriptors.find((descriptor) => descriptor.id === 'onepassword')?.fields.map((field) => field.key),
    ).toEqual(['OP_CONNECT_HOST', 'OP_CONNECT_TOKEN']);

    const items = await harness.credentials.listItems('gateway');
    expect(items.map((item) => item.id)).toEqual(['API_TOKEN', 'GITHUB_TOKEN']);
    expect(items[0]).toMatchObject({
      provider: 'gateway',
      name: 'API_TOKEN',
      username: null,
      category: 'gateway-vault',
      urls: [],
      fields: ['value'],
    });

    expect((await harness.credentials.listItems('gateway', { search: 'git' })).map((item) => item.id)).toEqual([
      'GITHUB_TOKEN',
    ]);
    expect(await harness.credentials.listItems('gateway', { search: 'zzz' })).toEqual([]);
    expect(await harness.credentials.listItems('gateway', { limit: 1 })).toHaveLength(1);

    await expect(harness.credentials.reveal('gateway', 'API_TOKEN')).resolves.toEqual({
      provider: 'gateway',
      itemId: 'API_TOKEN',
      field: 'value',
      value: 'gateway-secret-value',
    });
    await expect(harness.credentials.reveal('gateway', 'MISSING')).rejects.toMatchObject({
      code: ErrorCodes.TOOL_NOT_FOUND,
    });
  });

  it('persists the default provider and resolves refs through it', async () => {
    const harness = setup();
    harness.vault.setSecret('API_TOKEN', 'gateway-secret-value');

    expect(await harness.credentials.defaultProvider()).toBe('vaultwarden');
    await harness.credentials.setDefault('gateway');
    expect(await harness.credentials.defaultProvider()).toBe('gateway');
    const providers = await harness.credentials.listProviders();
    expect(providers.find((provider) => provider.id === 'gateway')?.isDefault).toBe(true);
    // The setting survives a new service instance sharing the DB.
    const reconfigured = new DefaultCredentialProviderService({
      db: harness.db,
      config: harness.config,
      vault: harness.vault,
      repository: harness.repository,
      supervisor: harness.supervisor,
      audit: harness.audit,
      homeDir: harness.homeDir,
    });
    expect(await reconfigured.defaultProvider()).toBe('gateway');

    const resolved = await harness.credentials.resolveRefs([
      { key: 'API_TOKEN', target: 'env', provider: 'gateway', itemId: 'API_TOKEN' },
    ]);
    expect(resolved).toEqual({ API_TOKEN: 'gateway-secret-value' });

    await expect(harness.credentials.setDefault('nope' as never)).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
    });
  });

  it('cannot be configured or cleared and rejects invalid providers', async () => {
    const harness = setup();
    await expect(harness.credentials.configure('gateway', {})).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
    });
    await expect(harness.credentials.clear('gateway')).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
    });
    await expect(harness.credentials.getProvider('nope' as never)).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
    });
    await expect(harness.credentials.reveal('nope' as never, 'x')).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
    });
  });

  it('reports unavailable when the vault is disabled', async () => {
    const harness = setup(null);
    const status = await harness.credentials.getProvider('gateway');
    expect(status).toMatchObject({ configured: false, available: false, state: 'unavailable' });

    try {
      await harness.credentials.listItems('gateway');
      throw new Error('expected listItems to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe(ErrorCodes.NOT_IMPLEMENTED);
    }
  });
});
