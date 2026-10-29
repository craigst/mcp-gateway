import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import { credentialSecretName } from '../../src/credentials/index.js';
import {
  OP_CONNECT_SECRET_VALUE,
  OP_CONNECT_TOKEN,
  createCredentialsHarness,
  makeRoot,
  removeRoot,
  startFakeOnepassword,
  type CredentialsHarness,
  type FakeOnepassword,
} from './support.js';

const harnesses: CredentialsHarness[] = [];
const roots: string[] = [];
const servers: FakeOnepassword[] = [];

beforeEach(() => {
  roots.push(makeRoot('credentials-onepassword-'));
});

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  while (harnesses.length > 0) await harnesses.pop()?.dispose();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) removeRoot(root);
  }
});

async function setup(): Promise<{ harness: CredentialsHarness; fake: FakeOnepassword }> {
  const root = roots[roots.length - 1] as string;
  const harness = createCredentialsHarness(root);
  harnesses.push(harness);
  const fake = await startFakeOnepassword();
  servers.push(fake);
  return { harness, fake };
}

describe('1Password credential provider (Connect REST)', () => {
  it('stores the token encrypted and reports Connect mode', async () => {
    const { harness, fake } = await setup();
    const status = await harness.credentials.configure('onepassword', {
      OP_CONNECT_HOST: fake.url,
      OP_CONNECT_TOKEN,
    });

    expect(status).toMatchObject({
      id: 'onepassword',
      kind: 'password-manager',
      configured: true,
      available: true,
      state: 'connected',
    });
    expect(status.details).toMatchObject({ mode: 'connect', host: fake.url });
    expect(JSON.stringify(status)).not.toContain(OP_CONNECT_TOKEN);
    expect(harness.vault.getSecret(credentialSecretName('onepassword', 'OP_CONNECT_TOKEN'))).toBe(
      OP_CONNECT_TOKEN,
    );
  });

  it('tests the connection and rejects an invalid token', async () => {
    const { harness, fake } = await setup();
    await harness.credentials.configure('onepassword', {
      OP_CONNECT_HOST: fake.url,
      OP_CONNECT_TOKEN,
    });
    const tested = await harness.credentials.test('onepassword');
    expect(tested.state).toBe('connected');
    expect(tested.message).toContain('1Password Connect connected');
    expect(fake.requests.some((request) => request.authorization === `Bearer ${OP_CONNECT_TOKEN}`)).toBe(true);

    // Wrong token: the provider reports an error and never leaks the token.
    await harness.credentials.configure('onepassword', {
      OP_CONNECT_HOST: fake.url,
      OP_CONNECT_TOKEN: 'wrong-token-value',
    });
    const failed = await harness.credentials.test('onepassword');
    expect(failed.state).toBe('error');
    expect(failed.message).not.toContain('wrong-token-value');
    expect(JSON.stringify(failed)).not.toContain('wrong-token-value');
  });

  it('lists and searches vault items through Connect', async () => {
    const { harness, fake } = await setup();
    await harness.credentials.configure('onepassword', {
      OP_CONNECT_HOST: fake.url,
      OP_CONNECT_TOKEN,
    });

    const items = await harness.credentials.listItems('onepassword');
    expect(items).toEqual([
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
    expect(await harness.credentials.listItems('onepassword', { search: 'api token' })).toHaveLength(1);
    expect(await harness.credentials.listItems('onepassword', { search: 'no-match' })).toHaveLength(0);
    expect(await harness.credentials.listItems('onepassword', { limit: 1 })).toHaveLength(1);
  });

  it('reveals the concealed field (and a requested field) from item detail', async () => {
    const { harness, fake } = await setup();
    await harness.credentials.configure('onepassword', {
      OP_CONNECT_HOST: fake.url,
      OP_CONNECT_TOKEN,
    });

    await expect(harness.credentials.reveal('onepassword', 'vault1/item1')).resolves.toEqual({
      provider: 'onepassword',
      itemId: 'vault1/item1',
      field: 'password',
      value: OP_CONNECT_SECRET_VALUE,
    });
    await expect(harness.credentials.reveal('onepassword', 'vault1/item1', 'username')).resolves.toMatchObject({
      field: 'username',
      value: 'example-user',
    });
    await expect(harness.credentials.reveal('onepassword', 'vault1/missing')).rejects.toMatchObject({
      code: ErrorCodes.TOOL_NOT_FOUND,
    });
    await expect(harness.credentials.reveal('onepassword', 'not-a-vault-item')).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
    });
  });

  it('clears configuration and rejects unusable setups', async () => {
    const { harness, fake } = await setup();
    await harness.credentials.configure('onepassword', {
      OP_CONNECT_HOST: fake.url,
      OP_CONNECT_TOKEN,
    });
    const cleared = await harness.credentials.clear('onepassword');
    expect(cleared).toMatchObject({ configured: false, state: 'not-configured' });
    expect(harness.vault.getSecret(credentialSecretName('onepassword', 'OP_CONNECT_TOKEN'))).toBeNull();

    await expect(harness.credentials.configure('onepassword', {})).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
    });
    await expect(
      harness.credentials.configure('onepassword', {
        OP_CONNECT_HOST: 'ftp://not-a-connect-host',
        OP_CONNECT_TOKEN,
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
    await expect(harness.credentials.listItems('onepassword')).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
    });
  });

  it('handles a token without a Connect host (CLI mode when available)', async () => {
    const harness = createCredentialsHarness(roots[roots.length - 1] as string);
    harnesses.push(harness);
    const status = await harness.credentials.configure('onepassword', { OP_CONNECT_TOKEN });
    expect(status.details.mode).toBeNull();
    if (status.details.cliAvailable === true) {
      expect(status.configured).toBe(true);
      expect(status.message).toContain('CLI');
    } else {
      expect(status.configured).toBe(false);
      expect(status.state).toBe('not-configured');
      expect(status.message).toContain('OP_CONNECT_HOST');
    }
  });

  it('scrubs the token from upstream failure messages', async () => {
    const harness = createCredentialsHarness(roots[roots.length - 1] as string);
    harnesses.push(harness);
    // Closed port: connection refused must not echo the token.
    await harness.credentials.configure('onepassword', {
      OP_CONNECT_HOST: 'http://127.0.0.1:9',
      OP_CONNECT_TOKEN: 'op-token-should-not-leak',
    });
    try {
      await harness.credentials.listItems('onepassword');
      throw new Error('expected listItems to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      const message = (error as GatewayError).message;
      expect(message).not.toContain('op-token-should-not-leak');
      expect(message).toContain('1Password Connect request failed');
    }
  });
});
