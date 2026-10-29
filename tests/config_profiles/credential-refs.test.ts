/**
 * v0.7: external credential-provider references in configuration profiles.
 *
 * A profile entry may reference an item held by Vaultwarden/1Password/the gateway
 * credential store instead of storing a value. Only metadata is persisted; the
 * service returns `credentialRefs` for the supervisor to resolve at process start.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import type { ConfigProfileInput, CredentialRef } from '../../src/core/types.js';
import { profileEnvSecretName, profileHeaderSecretName } from '../../src/config_profiles/index.js';
import { addEnvServer, createHarness, reportEnv, serverProfileIds, type Harness } from './support.js';

const harnesses: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
});

function setup(options: Parameters<typeof createHarness>[0] = {}): Harness {
  const harness = createHarness(options);
  harnesses.push(harness);
  return harness;
}

async function rejectedGatewayError(fn: () => Promise<unknown>): Promise<GatewayError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }
  throw new Error('Expected the promise to reject with a GatewayError');
}

function rawProfileRow(harness: Harness): Record<string, unknown> {
  return harness.db.prepare('SELECT * FROM config_profiles LIMIT 1').get() as unknown as Record<
    string,
    unknown
  >;
}

const MIXED_INPUT: ConfigProfileInput = {
  name: 'Mixed sources',
  entries: [
    { key: 'API_URL', value: 'https://api.example.test' },
    { key: 'VAULT_TOKEN', secretRef: 'SHARED_VAULT_TOKEN' },
    {
      key: 'VW_API_KEY',
      credentialRef: { provider: 'vaultwarden', itemId: 'vw-item-123', field: 'password' },
    },
    { key: 'OP_SECRET', credentialRef: { provider: 'onepassword', itemId: 'op-item-9' } },
  ],
  headers: [
    { key: 'Authorization', value: 'Bearer header-secret-value' },
    { key: 'X-Api-Key', credentialRef: { provider: 'gateway', itemId: 'gw-item-1' } },
  ],
};

describe('credential-ref profiles: storage and listing', () => {
  it('stores credential-ref metadata only and never touches the vault for it', async () => {
    const harness = setup();
    harness.vault.setSecret('SHARED_VAULT_TOKEN', 'vault-token-value');

    const profile = await harness.service.create(MIXED_INPUT);

    expect(profile.entries).toEqual([
      { key: 'API_URL', source: 'encrypted', ref: null },
      { key: 'VAULT_TOKEN', source: 'vault-ref', ref: 'SHARED_VAULT_TOKEN' },
      {
        key: 'VW_API_KEY',
        source: 'credential-ref',
        ref: null,
        provider: 'vaultwarden',
        itemId: 'vw-item-123',
        field: 'password',
      },
      {
        key: 'OP_SECRET',
        source: 'credential-ref',
        ref: null,
        provider: 'onepassword',
        itemId: 'op-item-9',
        field: null,
      },
    ]);
    expect(profile.headers).toEqual([
      { key: 'Authorization', source: 'encrypted', ref: null },
      {
        key: 'X-Api-Key',
        source: 'credential-ref',
        ref: null,
        provider: 'gateway',
        itemId: 'gw-item-1',
        field: null,
      },
    ]);

    // Only the encrypted entries own vault secrets.
    const row = rawProfileRow(harness);
    const ownedSecrets = JSON.parse(String(row.secret_keys_json)) as string[];
    expect(ownedSecrets.sort()).toEqual(
      [
        profileEnvSecretName(profile.id, 'API_URL'),
        profileHeaderSecretName(profile.id, 'Authorization'),
      ].sort(),
    );
    expect(harness.vault.getSecret(profileEnvSecretName(profile.id, 'API_URL'))).toBe(
      'https://api.example.test',
    );
    expect(harness.vault.getSecret(profileHeaderSecretName(profile.id, 'Authorization'))).toBe(
      'Bearer header-secret-value',
    );

    // The persisted/env rows carry provider metadata but never a value or a vault name
    // for credential-referenced keys.
    const envJson = String(row.env_json);
    expect(envJson).toContain('"provider":"vaultwarden"');
    expect(envJson).toContain('"itemId":"vw-item-123"');
    expect(envJson).toContain('"field":"password"');
    expect(envJson).not.toContain('vault-token-value');
    expect(envJson).not.toContain('https://api.example.test');
    // A vault-ref name is reference metadata (allowed); the secret value is not.
    expect(envJson).toContain('SHARED_VAULT_TOKEN');
    expect(ownedSecrets.some((name) => name.includes('VW_API_KEY'))).toBe(false);

    // list/get expose the same metadata (but no values or owned vault names).
    for (const read of [profile, harness.service.get(profile.id), harness.service.list()[0]]) {
      const dump = JSON.stringify(read);
      expect(dump).toContain('credential-ref');
      expect(dump).toContain('vw-item-123');
      expect(dump).not.toContain('vault-token-value');
      expect(dump).not.toContain('header-secret-value');
      expect(dump).not.toContain('ownedSecretNames');
    }
  });

  it('works without a vault when the profile only uses credential refs', async () => {
    const harness = setup({ vaultSecret: null });
    const profile = await harness.service.create({
      name: 'External only',
      entries: [
        { key: 'API_KEY', credentialRef: { provider: 'onepassword', itemId: 'op-1', field: 'credential' } },
      ],
      headers: [{ key: 'X-Key', credentialRef: { provider: 'vaultwarden', itemId: 'vw-1' } }],
    });
    expect(profile.entries[0]?.source).toBe('credential-ref');
    expect(JSON.parse(String(rawProfileRow(harness).secret_keys_json))).toEqual([]);

    const server = addEnvServer(harness);
    await harness.service.apply([profile.id], [server.id], { restart: false });
    expect(harness.service.resolveForServer(server.id).credentialRefs).toEqual([
      { key: 'API_KEY', target: 'env', provider: 'onepassword', itemId: 'op-1', field: 'credential' },
      { key: 'X-Key', target: 'header', provider: 'vaultwarden', itemId: 'vw-1', field: null },
    ]);

    harness.service.remove(profile.id);
    expect(harness.service.list()).toEqual([]);
  });
});

describe('credential-ref profiles: resolution', () => {
  it('returns env/header values plus credentialRefs for attached profiles', async () => {
    const harness = setup();
    harness.vault.setSecret('SHARED_VAULT_TOKEN', 'vault-token-value');
    const profile = await harness.service.create(MIXED_INPUT);
    const server = addEnvServer(harness);
    await harness.service.apply([profile.id], [server.id], { restart: false });

    const resolved = harness.service.resolveForServer(server.id);
    expect(resolved.env).toEqual({
      API_URL: 'https://api.example.test',
      VAULT_TOKEN: 'vault-token-value',
    });
    expect(resolved.headers).toEqual({ Authorization: 'Bearer header-secret-value' });
    // Credential-referenced keys are NOT resolved locally (no network calls here).
    expect(resolved.env).not.toHaveProperty('VW_API_KEY');
    expect(resolved.env).not.toHaveProperty('OP_SECRET');
    expect(resolved.headers).not.toHaveProperty('X-Api-Key');
    expect(resolved.credentialRefs).toEqual([
      {
        key: 'VW_API_KEY',
        target: 'env',
        provider: 'vaultwarden',
        itemId: 'vw-item-123',
        field: 'password',
      },
      { key: 'OP_SECRET', target: 'env', provider: 'onepassword', itemId: 'op-item-9', field: null },
      { key: 'X-Api-Key', target: 'header', provider: 'gateway', itemId: 'gw-item-1', field: null },
    ]);
  });

  it('lets later profiles override earlier credential refs and plain values', async () => {
    const harness = setup();
    const server = addEnvServer(harness);
    const first = await harness.service.create({
      name: 'First layer',
      entries: [
        { key: 'API_KEY', credentialRef: { provider: 'vaultwarden', itemId: 'vw-old', field: 'password' } },
      ],
    });
    const second = await harness.service.create({
      name: 'Second layer',
      entries: [
        { key: 'API_KEY', credentialRef: { provider: 'onepassword', itemId: 'op-new', field: 'credential' } },
      ],
    });
    await harness.service.apply([first.id, second.id], [server.id], { restart: false });
    expect(harness.service.resolveForServer(server.id).credentialRefs).toEqual([
      { key: 'API_KEY', target: 'env', provider: 'onepassword', itemId: 'op-new', field: 'credential' },
    ]);

    // A later plain value wins over an earlier credential reference.
    const third = await harness.service.create({
      name: 'Third layer',
      entries: [{ key: 'API_KEY', value: 'direct-value' }],
    });
    await harness.service.apply([third.id], [server.id], { restart: false });
    const resolved = harness.service.resolveForServer(server.id);
    expect(resolved.env.API_KEY).toBe('direct-value');
    expect(resolved.credentialRefs).toEqual([]);
  });

  it('resolves external credentials through the supervisor at start when wired', async () => {
    const calls: CredentialRef[][] = [];
    const harness = setup({
      credentialResolver: async (refs) => {
        calls.push(refs);
        const resolved: Record<string, string> = {};
        for (const ref of refs) {
          resolved[`${ref.target}:${ref.key}`] = `resolved:${ref.provider}:${ref.itemId}:${ref.field ?? 'none'}`;
        }
        return resolved;
      },
    });
    const server = addEnvServer(harness);
    const profile = await harness.service.create({
      name: 'Supervised',
      entries: [
        { key: 'EXTERNAL_TOKEN', credentialRef: { provider: 'vaultwarden', itemId: 'vw-42', field: 'password' } },
      ],
    });

    const results = await harness.service.apply([profile.id], [server.id], {
      restart: true,
      test: true,
    });
    expect(results[0]).toMatchObject({ applied: true, restarted: true, error: null });
    expect(results[0]?.test?.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      { key: 'EXTERNAL_TOKEN', target: 'env', provider: 'vaultwarden', itemId: 'vw-42', field: 'password' },
    ]);

    const report = await reportEnv(harness.supervisor, server.id, ['EXTERNAL_TOKEN']);
    expect(report.EXTERNAL_TOKEN).toBe('resolved:vaultwarden:vw-42:password');
    expect(serverProfileIds(harness, server.id)).toEqual([profile.id]);
  });

  it('surfaces a per-server error when no credential provider is wired', async () => {
    const harness = setup();
    const server = addEnvServer(harness);
    const profile = await harness.service.create({
      name: 'No provider',
      entries: [
        { key: 'EXTERNAL_TOKEN', credentialRef: { provider: 'onepassword', itemId: 'op-7' } },
      ],
    });
    await harness.service.apply([profile.id], [server.id], { restart: false });

    const results = await harness.service.apply([profile.id], [server.id], { restart: true });
    expect(results[0]?.applied).toBe(true);
    expect(results[0]?.restarted).toBe(false);
    expect(results[0]?.error).toContain('credential');
  });
});

describe('credential-ref profiles: update semantics', () => {
  it('keeps credential-provider metadata for key-only update rows', async () => {
    const harness = setup();
    harness.vault.setSecret('SHARED_VAULT_TOKEN', 'vault-token-value');
    const created = await harness.service.create(MIXED_INPUT);
    const vaultSecret = profileEnvSecretName(created.id, 'API_URL');

    const updated = await harness.service.update(created.id, {
      name: 'Mixed sources',
      entries: [{ key: 'VW_API_KEY' }, { key: 'API_URL' }],
      headers: [{ key: 'X-Api-Key' }],
    });

    expect(updated.entries).toEqual([
      {
        key: 'VW_API_KEY',
        source: 'credential-ref',
        ref: null,
        provider: 'vaultwarden',
        itemId: 'vw-item-123',
        field: 'password',
      },
      { key: 'API_URL', source: 'encrypted', ref: null },
    ]);
    expect(updated.headers).toEqual([
      {
        key: 'X-Api-Key',
        source: 'credential-ref',
        ref: null,
        provider: 'gateway',
        itemId: 'gw-item-1',
        field: null,
      },
    ]);
    // The kept encrypted value was not rotated or lost.
    expect(harness.vault.getSecret(vaultSecret)).toBe('https://api.example.test');
    // No vault writes were created for the credential refs.
    const owned = JSON.parse(String(rawProfileRow(harness).secret_keys_json)) as string[];
    expect(owned).toEqual([vaultSecret]);
  });

  it('replaces a credential reference without creating vault entries', async () => {
    const harness = setup();
    const created = await harness.service.create({
      name: 'Replace ref',
      entries: [
        {
          key: 'API_KEY',
          credentialRef: { provider: 'vaultwarden', itemId: 'vw-old', field: 'password' },
        },
      ],
    });
    const vaultNamesBefore = harness.vault.listSecrets().map((secret) => secret.name);

    const updated = await harness.service.update(created.id, {
      name: 'Replace ref',
      entries: [
        { key: 'API_KEY', credentialRef: { provider: 'onepassword', itemId: 'op-new', field: 'credential' } },
      ],
    });

    expect(updated.entries[0]).toEqual({
      key: 'API_KEY',
      source: 'credential-ref',
      ref: null,
      provider: 'onepassword',
      itemId: 'op-new',
      field: 'credential',
    });
    expect(harness.vault.listSecrets().map((secret) => secret.name)).toEqual(vaultNamesBefore);
    expect(JSON.parse(String(rawProfileRow(harness).secret_keys_json))).toEqual([]);
  });

  it('removes a credential reference without touching the vault', async () => {
    const harness = setup();
    const created = await harness.service.create({
      name: 'Drop ref',
      entries: [
        { key: 'KEEP', value: 'kept-value' },
        { key: 'DROP', credentialRef: { provider: 'gateway', itemId: 'gw-1' } },
      ],
    });
    const keptSecret = profileEnvSecretName(created.id, 'KEEP');
    expect(harness.vault.getSecret(keptSecret)).toBe('kept-value');

    const updated = await harness.service.update(created.id, {
      name: 'Drop ref',
      entries: [{ key: 'KEEP' }],
    });
    expect(updated.entries).toEqual([{ key: 'KEEP', source: 'encrypted', ref: null }]);
    expect(harness.vault.getSecret(keptSecret)).toBe('kept-value');
    expect(JSON.parse(String(rawProfileRow(harness).secret_keys_json))).toEqual([keptSecret]);
  });

  it('converts between encrypted values and credential references', async () => {
    const harness = setup();
    const created = await harness.service.create({
      name: 'Convert',
      entries: [{ key: 'TOKEN', value: 'inline-secret' }],
    });
    const ownedSecret = profileEnvSecretName(created.id, 'TOKEN');
    expect(harness.vault.getSecret(ownedSecret)).toBe('inline-secret');

    // encrypted -> credential-ref: the stale owned vault entry is deleted.
    const asRef = await harness.service.update(created.id, {
      name: 'Convert',
      entries: [{ key: 'TOKEN', credentialRef: { provider: 'vaultwarden', itemId: 'vw-9' } }],
    });
    expect(asRef.entries[0]?.source).toBe('credential-ref');
    expect(harness.vault.getSecret(ownedSecret)).toBeNull();
    expect(JSON.parse(String(rawProfileRow(harness).secret_keys_json))).toEqual([]);

    // credential-ref -> encrypted: a new vault entry is created.
    const asValue = await harness.service.update(created.id, {
      name: 'Convert',
      entries: [{ key: 'TOKEN', value: 'back-inline' }],
    });
    expect(asValue.entries[0]).toEqual({ key: 'TOKEN', source: 'encrypted', ref: null });
    expect(harness.vault.getSecret(ownedSecret)).toBe('back-inline');
    expect(JSON.parse(String(rawProfileRow(harness).secret_keys_json))).toEqual([ownedSecret]);
  });
});

describe('credential-ref profiles: validation', () => {
  it('rejects malformed credential references', async () => {
    const harness = setup();
    const badInputs: ConfigProfileInput[] = [
      {
        name: 'Bad provider',
        entries: [
          // @ts-expect-error -- runtime validation of an unknown provider id.
          { key: 'API_KEY', credentialRef: { provider: 'bitwarden', itemId: 'x' } },
        ],
      },
      { name: 'Missing item', entries: [{ key: 'API_KEY', credentialRef: { provider: 'vaultwarden', itemId: '' } }] },
      // @ts-expect-error -- runtime validation of a missing itemId.
      { name: 'No item', entries: [{ key: 'API_KEY', credentialRef: { provider: 'vaultwarden' } }] },
      {
        name: 'Value and ref',
        entries: [
          {
            key: 'API_KEY',
            value: 'inline',
            credentialRef: { provider: 'vaultwarden', itemId: 'x' },
          },
        ],
      },
      {
        name: 'Secret and credential',
        entries: [
          {
            key: 'API_KEY',
            secretRef: 'SOME_SECRET',
            credentialRef: { provider: 'vaultwarden', itemId: 'x' },
          },
        ],
      },
      // @ts-expect-error -- runtime validation of a non-object credentialRef.
      { name: 'Not object', entries: [{ key: 'API_KEY', credentialRef: 'vaultwarden:x' }] },
      // @ts-expect-error -- runtime validation of a non-string field.
      { name: 'Bad field', entries: [{ key: 'API_KEY', credentialRef: { provider: 'gateway', itemId: 'x', field: 5 } }] },
    ];

    for (const input of badInputs) {
      const error = await rejectedGatewayError(() => harness.service.create(input));
      expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
    }
    expect(harness.service.list()).toEqual([]);
  });

  it('normalises an empty field to null and accepts all three providers', async () => {
    const harness = setup();
    for (const [index, provider] of (['vaultwarden', 'onepassword', 'gateway'] as const).entries()) {
      const profile = await harness.service.create({
        name: `Provider ${provider}`,
        entries: [
          { key: `KEY_${index}`, credentialRef: { provider, itemId: `item-${index}`, field: '   ' } },
        ],
      });
      expect(profile.entries[0]).toMatchObject({ provider, itemId: `item-${index}`, field: null });
    }
  });

  it('requires a value/ref for new keys on update', async () => {
    const harness = setup();
    const created = await harness.service.create({
      name: 'Known',
      entries: [{ key: 'KNOWN', value: 'x' }],
    });
    const error = await rejectedGatewayError(() =>
      harness.service.update(created.id, { name: 'Known', entries: [{ key: 'UNKNOWN' }] }),
    );
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(error.message).toContain('credentialRef');
  });
});
