/**
 * v0.4: editing a configuration profile with a blank value must KEEP the
 * existing encrypted value (or existing vault reference), not blank it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { GatewayError } from '../../src/core/errors.js';
import { profileEnvSecretName, profileHeaderSecretName } from '../../src/config_profiles/index.js';
import { addEnvServer, createHarness, reportEnv } from './support.js';

const harnesses: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
});

function setup() {
  const harness = createHarness();
  harnesses.push(harness);
  return harness;
}

describe('profile update keeps values when blank', () => {
  it('keeps an existing encrypted env value and rotates only the provided one', async () => {
    const harness = setup();
    const created = await harness.service.create({
      name: 'Internal services',
      entries: [
        { key: 'API_URL', value: 'http://one.example' },
        { key: 'API_TOKEN', value: 'first-token' },
      ],
    });
    expect(created.entries.map((entry) => entry.source)).toEqual(['encrypted', 'encrypted']);

    const updated = await harness.service.update(created.id, {
      name: 'Internal services',
      entries: [{ key: 'API_URL' }, { key: 'API_TOKEN', value: 'rotated-token' }],
    });

    expect(updated.entries.map((entry) => entry.key).sort()).toEqual(['API_TOKEN', 'API_URL']);
    expect(harness.vault.getSecret(profileEnvSecretName(created.id, 'API_URL'))).toBe('http://one.example');
    expect(harness.vault.getSecret(profileEnvSecretName(created.id, 'API_TOKEN'))).toBe('rotated-token');
    expect(JSON.stringify(updated)).not.toContain('first-token');
    expect(JSON.stringify(updated)).not.toContain('rotated-token');
  });

  it('keeps a vault-ref entry when the row has no value', async () => {
    const harness = setup();
    harness.vault.setSecret('SHARED_TOKEN', 'from-vault');
    const created = await harness.service.create({
      name: 'Reuse vault',
      entries: [{ key: 'SHARED_TOKEN', secretRef: 'SHARED_TOKEN' }],
    });
    expect(created.entries[0]).toEqual({ key: 'SHARED_TOKEN', source: 'vault-ref', ref: 'SHARED_TOKEN' });

    const updated = await harness.service.update(created.id, {
      name: 'Reuse vault',
      entries: [{ key: 'SHARED_TOKEN' }],
    });
    expect(updated.entries[0]).toEqual({ key: 'SHARED_TOKEN', source: 'vault-ref', ref: 'SHARED_TOKEN' });
    expect(harness.vault.getSecret('SHARED_TOKEN')).toBe('from-vault');
  });

  it('keeps existing encrypted header values too', async () => {
    const harness = setup();
    const created = await harness.service.create({
      name: 'Headers',
      headers: [{ key: 'X-Api-Key', value: 'header-secret' }],
    });
    const updated = await harness.service.update(created.id, {
      name: 'Headers',
      headers: [{ key: 'X-Api-Key' }],
    });
    expect(updated.headers).toEqual([{ key: 'X-Api-Key', source: 'encrypted', ref: null }]);
    expect(harness.vault.getSecret(profileHeaderSecretName(created.id, 'X-Api-Key'))).toBe('header-secret');
  });

  it('injects the kept values into a running server', async () => {
    const harness = setup();
    const server = addEnvServer(harness, { name: 'env-keep', id: 'srv_env_keep' });
    const created = await harness.service.create({
      name: 'Keep live',
      entries: [
        { key: 'API_URL', value: 'http://kept.example' },
        { key: 'API_TOKEN', value: 'kept-token' },
      ],
    });
    await harness.service.apply([created.id], [server.id], { restart: true, test: true });

    const updated = await harness.service.update(created.id, {
      name: 'Keep live',
      entries: [{ key: 'API_URL' }, { key: 'API_TOKEN', value: 'rotated-live' }],
    });
    await harness.service.apply([updated.id], [server.id], { restart: true, test: false });

    const env = await reportEnv(harness.supervisor, server.id, ['API_URL', 'API_TOKEN']);
    expect(env.API_URL).toBe('http://kept.example');
    expect(env.API_TOKEN).toBe('rotated-live');
  });

  it('rejects key-only rows when creating and for unknown keys', async () => {
    const harness = setup();
    await expect(
      harness.service.create({
        name: 'Bad create',
        entries: [{ key: 'NO_VALUE' }],
      }),
    ).rejects.toBeInstanceOf(GatewayError);

    const created = await harness.service.create({
      name: 'Known keys',
      entries: [{ key: 'KNOWN', value: 'x' }],
    });
    await expect(
      harness.service.update(created.id, {
        name: 'Known keys',
        entries: [{ key: 'UNKNOWN' }],
      }),
    ).rejects.toBeInstanceOf(GatewayError);
    // The failed update must not have destroyed the existing value.
    expect(harness.vault.getSecret(profileEnvSecretName(created.id, 'KNOWN'))).toBe('x');
  });
});
