import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import type { Logger } from '../../src/core/logger.js';
import type { AuthenticatedKey } from '../../src/core/types.js';
import {
  INSPECTOR_VAULT_SECRET,
  createInspectorHarness,
  seedProfile,
  seedServer,
  type InspectorHarness,
} from './support.js';

const harnesses: InspectorHarness[] = [];

interface RecordingLogger {
  logger: Logger;
  records: Array<{ level: string; message: string; context?: Record<string, unknown> }>;
}

function createRecordingLogger(): RecordingLogger {
  const records: RecordingLogger['records'] = [];
  const logger: Logger = {
    module: 'inspector-test',
    debug: (message, context) => records.push({ level: 'debug', message, context }),
    info: (message, context) => records.push({ level: 'info', message, context }),
    warn: (message, context) => records.push({ level: 'warn', message, context }),
    error: (message, context) => records.push({ level: 'error', message, context }),
    child: () => logger,
  };
  return { logger, records };
}

beforeEach(() => {
  harnesses.length = 0;
});

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.dispose();
});

function setup(): { harness: InspectorHarness; master: AuthenticatedKey; recording: RecordingLogger } {
  const recording = createRecordingLogger();
  const harness = createInspectorHarness({ logger: recording.logger });
  harnesses.push(harness);
  const master = harness.keys.issue({ name: 'master-key', keyType: 'master' }).key;
  return { harness, master, recording };
}

function expectGatewayError(fn: () => unknown): GatewayError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }
  throw new Error('expected a GatewayError');
}

describe('ServerInspectorService.reveal', () => {
  it('reveals server env and header values and audits each reveal', async () => {
    const { harness, master, recording } = setup();
    const server = seedServer(harness, {
      name: 'brain',
      env: { API_TOKEN: 'server-token-value', PUBLIC_URL: 'https://example.internal' },
      headers: { 'x-api-key': 'header-secret-value' },
    });

    expect(harness.inspector.reveal(server.id, { kind: 'env', key: 'API_TOKEN' }, master)).toEqual({
      key: 'API_TOKEN',
      value: 'server-token-value',
    });
    expect(harness.inspector.reveal(server.id, { kind: 'env', key: 'PUBLIC_URL' }, master)).toEqual({
      key: 'PUBLIC_URL',
      value: 'https://example.internal',
    });
    expect(
      harness.inspector.reveal(server.id, { kind: 'header', key: 'x-api-key' }, master),
    ).toEqual({ key: 'x-api-key', value: 'header-secret-value' });

    const reveals = harness.audit.query({ serverId: server.id, method: 'admin.reveal' });
    expect(reveals.total).toBe(3);
    const latest = reveals.entries[0];
    expect(latest).toMatchObject({
      keyId: master.id,
      method: 'admin.reveal',
      serverId: server.id,
      status: 'ok',
    });
    expect(latest?.payload).toMatchObject({ kind: 'header', key: 'x-api-key', profileId: null });
    // The audit payload NEVER carries the revealed value.
    expect(JSON.stringify(reveals.entries)).not.toContain('server-token-value');
    expect(JSON.stringify(reveals.entries)).not.toContain('header-secret-value');
    // ...and neither do the service logs.
    expect(JSON.stringify(recording.records)).not.toContain('server-token-value');
    expect(JSON.stringify(recording.records)).not.toContain('header-secret-value');
  });

  it('reveals encrypted and vault-ref profile values when attached', async () => {
    const { harness, master } = setup();
    const server = seedServer(harness, { name: 'brain' });
    const { profileId } = await seedProfile(harness, server.id);

    expect(
      harness.inspector.reveal(server.id, { kind: 'profile', profileId, key: 'API_TOKEN' }, master),
    ).toEqual({ key: 'API_TOKEN', value: 'profile-encrypted-token' });
    expect(
      harness.inspector.reveal(server.id, { kind: 'profile', profileId, key: 'BASE_URL' }, master),
    ).toEqual({ key: 'BASE_URL', value: 'https://config.example.internal' });
    expect(
      harness.inspector.reveal(server.id, { kind: 'profile', profileId, key: 'EXISTING_KEY' }, master),
    ).toEqual({ key: 'EXISTING_KEY', value: 'vault-ref-secret-value' });
    expect(
      harness.inspector.reveal(server.id, { kind: 'profile', profileId, key: 'AUTHORIZATION' }, master),
    ).toEqual({ key: 'AUTHORIZATION', value: 'Bearer profile-header-token' });

    const reveals = harness.audit.query({ method: 'admin.reveal', serverId: server.id });
    expect(reveals.total).toBe(4);
    const profileReveal = reveals.entries[0];
    expect(profileReveal?.payload).toMatchObject({ kind: 'profile', profileId });
    expect(JSON.stringify(reveals.entries)).not.toContain('profile-encrypted-token');
    expect(JSON.stringify(reveals.entries)).not.toContain('vault-ref-secret-value');
    expect(JSON.stringify(reveals.entries)).not.toContain('profile-header-token');
  });

  it('rejects unknown keys, unattached profiles and missing values', async () => {
    const { harness, master } = setup();
    const server = seedServer(harness, { name: 'brain', env: { API_TOKEN: 'x' } });
    const { profileId } = await seedProfile(harness, server.id);
    const detached = await harness.configProfiles.create({ name: 'Detached profile' });

    expect(
      expectGatewayError(() => harness.inspector.reveal(server.id, { kind: 'env', key: 'MISSING' }, master)).code,
    ).toBe(ErrorCodes.TOOL_NOT_FOUND);
    expect(
      expectGatewayError(() => harness.inspector.reveal(server.id, { kind: 'header', key: 'missing' }, master)).code,
    ).toBe(ErrorCodes.TOOL_NOT_FOUND);
    expect(
      expectGatewayError(() =>
        harness.inspector.reveal(server.id, { kind: 'profile', profileId, key: 'UNKNOWN' }, master),
      ).code,
    ).toBe(ErrorCodes.INVALID_PARAMS);
    expect(
      expectGatewayError(() =>
        harness.inspector.reveal(server.id, { kind: 'profile', profileId: detached.id, key: 'X' }, master),
      ).code,
    ).toBe(ErrorCodes.INVALID_PARAMS);
    expect(
      expectGatewayError(() => harness.inspector.reveal(server.id, { kind: 'profile', key: 'X' }, master)).code,
    ).toBe(ErrorCodes.INVALID_PARAMS);
    expect(
      expectGatewayError(() => harness.inspector.reveal('srv_missing', { kind: 'env', key: 'X' }, master)).code,
    ).toBe(ErrorCodes.TOOL_NOT_FOUND);
    // No audit rows are written for failed reveals.
    expect(harness.audit.query({ method: 'admin.reveal' }).total).toBe(0);
  });

  it('reports a missing vault value after the secret is rotated away', async () => {
    const { harness, master } = setup();
    const server = seedServer(harness, { name: 'brain' });
    const { profileId } = await seedProfile(harness, server.id);
    harness.vault.deleteSecret('EXISTING_SECRET');

    const error = expectGatewayError(() =>
      harness.inspector.reveal(server.id, { kind: 'profile', profileId, key: 'EXISTING_KEY' }, master),
    );
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(error.message).toContain('EXISTING_KEY');
    expect(error.message).not.toContain(INSPECTOR_VAULT_SECRET);
  });
});
