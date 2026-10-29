import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import type { ConfigProfileInput } from '../../src/core/types.js';
import { DefaultConfigProfileService } from '../../src/config_profiles/service.js';
import {
  profileEnvSecretName,
  profileHeaderSecretName,
} from '../../src/config_profiles/index.js';
import { SqliteVaultService } from '../../src/vault/store.js';
import {
  addEnvServer,
  createHarness,
  silentLogger,
  serverProfileIds,
  type Harness,
} from './support.js';

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(async () => {
  await harness.close();
});

function gatewayError(fn: () => unknown): GatewayError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }
  throw new Error('Expected the function to throw a GatewayError.');
}

async function rejectedGatewayError(fn: () => Promise<unknown>): Promise<GatewayError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }
  throw new Error('Expected the promise to reject with a GatewayError.');
}

async function attach(profileId: string, serverId: string): Promise<void> {
  const results = await harness.service.apply([profileId], [serverId], { restart: false });
  expect(results[0]?.error).toBeNull();
}

function rawProfileRows(): Array<Record<string, unknown>> {
  return harness.db.prepare('SELECT * FROM config_profiles').all() as unknown as Array<
    Record<string, unknown>
  >;
}

describe('DefaultConfigProfileService.create', () => {
  it('encrypts plaintext values into the vault and never stores or returns them', async () => {
    const profile = await harness.service.create({
      name: 'Internal services',
      description: 'Shared N8N configuration',
      entries: [
        { key: 'N8N_BASE_URL', value: 'http://10.0.0.5:5678' },
        { key: 'N8N_TOKEN', value: 'super-secret-token-value' },
      ],
      headers: [{ key: 'X-API-Key', value: 'header-secret-value' }],
    });

    expect(profile.id).toMatch(/^cfg_[0-9a-f]+$/);
    expect(profile.name).toBe('Internal services');
    expect(profile.description).toBe('Shared N8N configuration');
    expect(profile.attachedServerIds).toEqual([]);
    expect(profile.entries).toEqual([
      { key: 'N8N_BASE_URL', source: 'encrypted', ref: null },
      { key: 'N8N_TOKEN', source: 'encrypted', ref: null },
    ]);
    expect(profile.headers).toEqual([{ key: 'X-API-Key', source: 'encrypted', ref: null }]);
    expect(Number.isNaN(Date.parse(profile.createdAt))).toBe(false);
    expect(profile.updatedAt).toBe(profile.createdAt);

    // Values live in the vault under the documented names...
    expect(harness.vault.getSecret(profileEnvSecretName(profile.id, 'N8N_BASE_URL'))).toBe(
      'http://10.0.0.5:5678',
    );
    expect(harness.vault.getSecret(profileEnvSecretName(profile.id, 'N8N_TOKEN'))).toBe(
      'super-secret-token-value',
    );
    expect(harness.vault.getSecret(profileHeaderSecretName(profile.id, 'X-API-Key'))).toBe(
      'header-secret-value',
    );

    // ...and nowhere in SQLite or any API projection.
    const sqliteDump = JSON.stringify(rawProfileRows());
    const apiDump = JSON.stringify(harness.service.list());
    for (const secret of ['super-secret-token-value', 'header-secret-value', 'http://10.0.0.5:5678']) {
      expect(sqliteDump).not.toContain(secret);
      expect(apiDump).not.toContain(secret);
      expect(JSON.stringify(profile)).not.toContain(secret);
    }

    const row = rawProfileRows()[0] as { env_json: string; secret_keys_json: string; env_file: string | null };
    expect(row.env_file).toBeNull();
    const envEntries = JSON.parse(row.env_json) as Array<Record<string, unknown>>;
    expect(envEntries.map((entry) => entry.key)).toEqual(['N8N_BASE_URL', 'N8N_TOKEN']);
    const secretKeys = JSON.parse(row.secret_keys_json) as string[];
    expect(secretKeys).toContain(profileEnvSecretName(profile.id, 'N8N_TOKEN'));
    expect(secretKeys).toContain(profileHeaderSecretName(profile.id, 'X-API-Key'));
  });

  it('supports references to existing vault secrets (vault-ref)', async () => {
    harness.vault.setSecret('SHARED_API_KEY', 'shared-vault-value-42');
    const profile = await harness.service.create({
      name: 'Shared refs',
      entries: [{ key: 'API_KEY', secretRef: 'SHARED_API_KEY' }],
    });
    expect(profile.entries).toEqual([{ key: 'API_KEY', source: 'vault-ref', ref: 'SHARED_API_KEY' }]);

    const server = addEnvServer(harness);
    await attach(profile.id, server.id);
    expect(harness.service.resolveForServer(server.id).env).toEqual({
      API_KEY: 'shared-vault-value-42',
    });
    expect(JSON.stringify(harness.service.get(profile.id))).not.toContain('shared-vault-value-42');
  });

  it('fails clearly for a missing secretRef', async () => {
    const error = await rejectedGatewayError(() =>
      harness.service.create({
        name: 'Broken refs',
        entries: [{ key: 'API_KEY', secretRef: 'DOES_NOT_EXIST' }],
      }),
    );
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(error.message).toContain('DOES_NOT_EXIST');
    expect(harness.service.list()).toEqual([]);
  });

  it('validates names, keys, duplicates and entry shapes', async () => {
    const cases: Array<ConfigProfileInput> = [
      { name: '   ' },
      { name: 'bad/name' },
      { name: 'keys', entries: [{ key: '1BAD', value: 'x' }] },
      {
        name: 'dupes',
        entries: [
          { key: 'API_URL', value: 'a' },
          { key: 'api_url', value: 'b' },
        ],
      },
      { name: 'both', entries: [{ key: 'K', value: 'v', secretRef: 'R' }] },
      { name: 'neither', entries: [{ key: 'K' }] },
      { name: 'header-injection', headers: [{ key: 'X-Bad', value: 'a\r\nInjected: yes' }] },
      { name: 'too-long-key', entries: [{ key: 'A'.repeat(60), value: 'v' }] },
      {
        name: 'collision',
        headers: [
          { key: 'X-Key', value: 'a' },
          { key: 'X_Key', value: 'b' },
        ],
      },
    ];
    for (const input of cases) {
      const error = await rejectedGatewayError(() => harness.service.create(input));
      expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
    }
    expect(harness.service.list()).toEqual([]);
  });

  it('enforces unique, case-insensitive profile names', async () => {
    await harness.service.create({ name: 'Production' });
    const error = await rejectedGatewayError(() => harness.service.create({ name: 'production' }));
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(error.message).toContain('already exists');
  });
});

describe('DefaultConfigProfileService.update', () => {
  it('rotates an encrypted value in place', async () => {
    const profile = await harness.service.create({
      name: 'Rotating',
      entries: [{ key: 'API_TOKEN', value: 'version-one-secret' }],
    });
    const secretName = profileEnvSecretName(profile.id, 'API_TOKEN');
    expect(harness.vault.getSecret(secretName)).toBe('version-one-secret');

    const updated = await harness.service.update(profile.id, {
      name: 'Rotating',
      entries: [{ key: 'API_TOKEN', value: 'version-two-secret' }],
    });

    expect(harness.vault.getSecret(secretName)).toBe('version-two-secret');
    expect(JSON.stringify(harness.service.list())).not.toContain('version-one-secret');
    expect(JSON.stringify(harness.service.list())).not.toContain('version-two-secret');
    expect(updated.entries).toEqual([{ key: 'API_TOKEN', source: 'encrypted', ref: null }]);
  });

  it('deletes the vault entry for an entry that is removed', async () => {
    const profile = await harness.service.create({
      name: 'Removable',
      entries: [
        { key: 'KEEP_ME', value: 'keep-value' },
        { key: 'DROP_ME', value: 'drop-value' },
      ],
    });
    const droppedSecret = profileEnvSecretName(profile.id, 'DROP_ME');
    expect(harness.vault.getSecret(droppedSecret)).toBe('drop-value');

    await harness.service.update(profile.id, {
      name: 'Removable',
      entries: [{ key: 'KEEP_ME', value: 'keep-value' }],
    });

    expect(harness.vault.getSecret(droppedSecret)).toBeNull();
    expect(harness.vault.getSecret(profileEnvSecretName(profile.id, 'KEEP_ME'))).toBe(
      'keep-value',
    );
    expect(harness.service.get(profile.id)?.entries.map((entry) => entry.key)).toEqual(['KEEP_ME']);
  });

  it('cleans up a profile-owned value when an entry becomes a vault-ref', async () => {
    harness.vault.setSecret('EXTERNAL_TOKEN', 'external-value');
    const profile = await harness.service.create({
      name: 'Switching',
      entries: [{ key: 'TOKEN', value: 'owned-value' }],
    });
    const ownedSecret = profileEnvSecretName(profile.id, 'TOKEN');

    const updated = await harness.service.update(profile.id, {
      name: 'Switching',
      entries: [{ key: 'TOKEN', secretRef: 'EXTERNAL_TOKEN' }],
    });

    expect(updated.entries).toEqual([{ key: 'TOKEN', source: 'vault-ref', ref: 'EXTERNAL_TOKEN' }]);
    expect(harness.vault.getSecret(ownedSecret)).toBeNull();
    expect(harness.vault.getSecret('EXTERNAL_TOKEN')).toBe('external-value');
  });

  it('leaves referenced secrets alone when an entry becomes profile-owned', async () => {
    harness.vault.setSecret('EXTERNAL_TOKEN', 'external-value');
    const profile = await harness.service.create({
      name: 'Switching back',
      entries: [{ key: 'TOKEN', secretRef: 'EXTERNAL_TOKEN' }],
    });

    await harness.service.update(profile.id, {
      name: 'Switching back',
      entries: [{ key: 'TOKEN', value: 'now-owned-value' }],
    });

    // References are not owned by the profile, so they must survive.
    expect(harness.vault.getSecret('EXTERNAL_TOKEN')).toBe('external-value');
    expect(harness.vault.getSecret(profileEnvSecretName(profile.id, 'TOKEN'))).toBe(
      'now-owned-value',
    );
  });

  it('rejects unknown ids and duplicate names', async () => {
    const first = await harness.service.create({ name: 'First' });
    await harness.service.create({ name: 'Second' });

    expect(
      (await rejectedGatewayError(() => harness.service.update('cfg_missing', { name: 'First' }))).code,
    ).toBe(ErrorCodes.TOOL_NOT_FOUND);
    expect(
      (await rejectedGatewayError(() => harness.service.update(first.id, { name: 'Second' }))).code,
    ).toBe(ErrorCodes.INVALID_PARAMS);
  });
});

describe('DefaultConfigProfileService resolution and attachment', () => {
  it('resolves attached profiles in order with later profiles overriding earlier ones', async () => {
    const server = addEnvServer(harness);
    const base = await harness.service.create({
      name: 'Base',
      entries: [
        { key: 'API_URL', value: 'http://base' },
        { key: 'API_PORT', value: '1111' },
      ],
      headers: [{ key: 'X-Tenant', value: 'base-tenant' }],
    });
    const override = await harness.service.create({
      name: 'Override',
      entries: [{ key: 'API_URL', value: 'http://override' }],
      headers: [{ key: 'X-Tenant', value: 'override-tenant' }],
    });

    await harness.service.apply([base.id, override.id], [server.id], { restart: false });

    const resolved = harness.service.resolveForServer(server.id);
    expect(resolved.env).toEqual({ API_URL: 'http://override', API_PORT: '1111' });
    expect(resolved.headers).toEqual({ 'X-Tenant': 'override-tenant' });
    expect(harness.service.profileIdsForServer(server.id)).toEqual([base.id, override.id]);
    expect(harness.service.get(base.id)?.attachedServerIds).toEqual([server.id]);
    expect(serverProfileIds(harness, server.id)).toEqual([base.id, override.id]);
  });

  it('computes attachedServerIds for every attached server', async () => {
    const first = addEnvServer(harness, { id: 'srv_a', name: 'a' });
    const second = addEnvServer(harness, { id: 'srv_b', name: 'b' });
    const profile = await harness.service.create({ name: 'Shared' });

    await harness.service.apply([profile.id], [first.id, second.id], { restart: false });
    await harness.service.apply([profile.id], [second.id], { restart: false });

    expect(harness.service.get(profile.id)?.attachedServerIds.sort()).toEqual(['srv_a', 'srv_b']);
    expect(harness.service.list()[0]?.attachedServerIds.sort()).toEqual(['srv_a', 'srv_b']);
    // Applying twice does not duplicate the id.
    expect(serverProfileIds(harness, second.id)).toEqual([profile.id]);
  });

  it('detaches a profile from a single server', async () => {
    const first = addEnvServer(harness, { id: 'srv_a', name: 'a' });
    const second = addEnvServer(harness, { id: 'srv_b', name: 'b' });
    const profile = await harness.service.create({ name: 'Shared' });
    await harness.service.apply([profile.id], [first.id, second.id], { restart: false });

    harness.service.detach(profile.id, first.id);

    expect(serverProfileIds(harness, first.id)).toEqual([]);
    expect(serverProfileIds(harness, second.id)).toEqual([profile.id]);
    expect(harness.service.get(profile.id)?.attachedServerIds).toEqual([second.id]);

    expect(
      gatewayError(() => harness.service.detach('cfg_missing', second.id)).code,
    ).toBe(ErrorCodes.TOOL_NOT_FOUND);
    expect(
      gatewayError(() => harness.service.detach(profile.id, 'srv_missing')).code,
    ).toBe(ErrorCodes.TOOL_NOT_FOUND);
  });
});

describe('DefaultConfigProfileService.remove', () => {
  it('deletes the profile, its vault secrets and all attachments', async () => {
    const first = addEnvServer(harness, { id: 'srv_a', name: 'a' });
    const second = addEnvServer(harness, { id: 'srv_b', name: 'b' });
    const profile = await harness.service.create({
      name: 'Disposable',
      entries: [{ key: 'TOKEN', value: 'disposable-secret' }],
      headers: [{ key: 'X-Token', value: 'disposable-header' }],
    });
    const envSecret = profileEnvSecretName(profile.id, 'TOKEN');
    const headerSecret = profileHeaderSecretName(profile.id, 'X-Token');
    await harness.service.apply([profile.id], [first.id, second.id], { restart: false });

    harness.service.remove(profile.id);

    expect(harness.service.get(profile.id)).toBeNull();
    expect(harness.vault.getSecret(envSecret)).toBeNull();
    expect(harness.vault.getSecret(headerSecret)).toBeNull();
    expect(serverProfileIds(harness, first.id)).toEqual([]);
    expect(serverProfileIds(harness, second.id)).toEqual([]);
    expect(
      gatewayError(() => harness.service.remove(profile.id)).code,
    ).toBe(ErrorCodes.TOOL_NOT_FOUND);
  });
});

describe('DefaultConfigProfileService vault-disabled behaviour', () => {
  it('refuses to create profiles with values when the vault is disabled', async () => {
    const disabled = createHarness({ vaultSecret: null });
    try {
      const error = await rejectedGatewayError(() =>
        disabled.service.create({
          name: 'Needs vault',
          entries: [{ key: 'TOKEN', value: 'value' }],
        }),
      );
      expect(error.code).toBe(ErrorCodes.NOT_IMPLEMENTED);
      expect(disabled.service.list()).toEqual([]);
      expect(disabled.vault.listSecrets()).toEqual([]);

      const refError = await rejectedGatewayError(() =>
        disabled.service.create({
          name: 'Needs vault ref',
          entries: [{ key: 'TOKEN', secretRef: 'EXISTING' }],
        }),
      );
      expect(refError.code).toBe(ErrorCodes.NOT_IMPLEMENTED);
    } finally {
      await disabled.close();
    }
  });

  it('refuses to resolve attached profiles when the vault is disabled', async () => {
    const server = addEnvServer(harness);
    const profile = await harness.service.create({
      name: 'Encrypted',
      entries: [{ key: 'TOKEN', value: 'value' }],
    });
    await attach(profile.id, server.id);

    const disabledVault = new SqliteVaultService(harness.db, null, { logger: silentLogger() });
    const disabledService = new DefaultConfigProfileService({
      db: harness.db,
      repository: harness.repository,
      vault: disabledVault,
      supervisor: harness.supervisor,
      logger: silentLogger(),
    });
    const error = gatewayError(() => disabledService.resolveForServer(server.id));
    expect(error.code).toBe(ErrorCodes.NOT_IMPLEMENTED);
  });
});
