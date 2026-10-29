import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import type { ConfigProfileInput } from '../../src/core/types.js';
import { profileEnvSecretName } from '../../src/config_profiles/index.js';
import {
  addEnvServer,
  createHarness,
  reportEnv,
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

async function rejectedGatewayError(fn: () => Promise<unknown>): Promise<GatewayError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }
  throw new Error('Expected the promise to reject with a GatewayError.');
}

describe('DefaultConfigProfileService.apply with a live fixture server', () => {
  it('starts the server with resolved profile env and reports it through a tool call', async () => {
    const server = addEnvServer(harness);
    const profile = await harness.service.create({
      name: 'Runtime env',
      entries: [
        { key: 'API_URL', value: 'http://profile-url:8080' },
        { key: 'API_TOKEN', value: 'profile-token-value' },
        { key: 'API_PORT', value: '4321' },
      ],
    });

    const results = await harness.service.apply([profile.id], [server.id], {
      restart: true,
      test: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      serverId: server.id,
      serverName: 'env-fixture',
      applied: true,
      restarted: true,
      error: null,
    });
    expect(results[0]?.test?.ok).toBe(true);
    expect(results[0]?.test?.toolCount).toBe(1);
    expect(results[0]?.test?.tools).toEqual(['env_report']);
    expect(results[0]?.test?.latencyMs).toBeGreaterThanOrEqual(0);

    const report = await reportEnv(harness.supervisor, server.id, ['API_URL', 'API_TOKEN', 'API_PORT']);
    expect(report).toEqual({
      API_URL: 'http://profile-url:8080',
      API_TOKEN: 'profile-token-value',
      API_PORT: '4321',
    });
    // The plaintext secret must not be sitting in SQLite either.
    const sqliteDump = JSON.stringify(
      harness.db.prepare('SELECT * FROM config_profiles').all(),
    );
    expect(sqliteDump).not.toContain('profile-token-value');
  });

  it('applies server-specific env on top of profile env (server wins)', async () => {
    const server = addEnvServer(harness, {
      env: { API_URL: 'http://server-env-override' },
    });
    const profile = await harness.service.create({
      name: 'Base runtime',
      entries: [
        { key: 'API_URL', value: 'http://profile-url' },
        { key: 'API_PORT', value: '9999' },
      ],
    });

    await harness.service.apply([profile.id], [server.id], { restart: true });

    const report = await reportEnv(harness.supervisor, server.id, ['API_URL', 'API_PORT']);
    expect(report).toEqual({
      API_URL: 'http://server-env-override',
      API_PORT: '9999',
    });
  });

  it('applies later profiles on top of earlier ones', async () => {
    const server = addEnvServer(harness);
    const base = await harness.service.create({
      name: 'Base layer',
      entries: [
        { key: 'API_URL', value: 'http://base' },
        { key: 'API_PORT', value: '1111' },
      ],
    });
    const override = await harness.service.create({
      name: 'Override layer',
      entries: [{ key: 'API_URL', value: 'http://override' }],
    });

    await harness.service.apply([base.id, override.id], [server.id], { restart: true });

    const report = await reportEnv(harness.supervisor, server.id, ['API_URL', 'API_PORT']);
    expect(report).toEqual({ API_URL: 'http://override', API_PORT: '1111' });
  });

  it('resolves header values for the supervisor (HTTP transports)', async () => {
    const server = addEnvServer(harness);
    const profile = await harness.service.create({
      name: 'Headers',
      headers: [{ key: 'X-Api-Key', value: 'header-secret-value' }],
    });
    await harness.service.apply([profile.id], [server.id], { restart: false });

    expect(harness.service.resolveForServer(server.id)).toEqual({
      env: {},
      headers: { 'X-Api-Key': 'header-secret-value' },
      credentialRefs: [],
    });
    // Header values are in the vault, not SQLite.
    expect(JSON.stringify(harness.db.prepare('SELECT * FROM config_profiles').all())).not.toContain(
      'header-secret-value',
    );
  });

  it('starts stopped servers by default (restart defaults to true)', async () => {
    const server = addEnvServer(harness);
    const profile = await harness.service.create({
      name: 'Default restart',
      entries: [{ key: 'API_URL', value: 'http://default-restart' }],
    });

    const results = await harness.service.apply([profile.id], [server.id]);
    expect(results[0]?.restarted).toBe(true);
    expect(harness.supervisor.status(server.id)).toBe('running');
    expect(results[0]?.test).toBeNull();
    expect(await reportEnv(harness.supervisor, server.id, ['API_URL'])).toEqual({
      API_URL: 'http://default-restart',
    });
  });

  it('reports a per-server error without aborting the other servers', async () => {
    const first = addEnvServer(harness, { id: 'srv_a', name: 'env-fixture-a' });
    const second = addEnvServer(harness, { id: 'srv_b', name: 'env-fixture-b' });
    const profile = await harness.service.create({
      name: 'Multi',
      entries: [{ key: 'API_URL', value: 'http://multi' }],
    });

    const results = await harness.service.apply(
      [profile.id],
      [first.id, 'srv_missing', second.id],
      { restart: true, test: true },
    );

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ serverId: first.id, applied: true, error: null });
    expect(results[1]).toMatchObject({ serverId: 'srv_missing', applied: false, error: "Unknown server 'srv_missing'" });
    expect(results[2]).toMatchObject({ serverId: second.id, applied: true, error: null });
    expect(results[0]?.test?.ok).toBe(true);
    expect(results[2]?.test?.ok).toBe(true);
    // The healthy servers still run with the profile applied.
    expect(serverProfileIds(harness, first.id)).toEqual([profile.id]);
    expect(serverProfileIds(harness, second.id)).toEqual([profile.id]);
  });

  it('validates apply inputs and unknown profile ids', async () => {
    expect(
      (await rejectedGatewayError(() => harness.service.apply([], ['srv_a']))).code,
    ).toBe(ErrorCodes.INVALID_PARAMS);
    expect(
      (await rejectedGatewayError(() => harness.service.apply(['cfg_missing'], ['srv_a']))).code,
    ).toBe(ErrorCodes.TOOL_NOT_FOUND);
  });

  it('stops resolving a profile after detach', async () => {
    const server = addEnvServer(harness);
    const profile = await harness.service.create({
      name: 'Detach me',
      entries: [{ key: 'API_URL', value: 'http://detached' }],
    });
    await harness.service.apply([profile.id], [server.id], { restart: false });
    expect(harness.service.resolveForServer(server.id).env).toEqual({ API_URL: 'http://detached' });

    harness.service.detach(profile.id, server.id);
    expect(harness.service.resolveForServer(server.id)).toEqual({
      env: {},
      headers: {},
      credentialRefs: [],
    });
  });
});

describe('DefaultConfigProfileService.migrateEnvFile', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mcp-profile-migrate-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('encrypts every env-file value, attaches the profile and clears server.envFile', async () => {
    const envFile = join(tempDir, 'server.env');
    writeFileSync(
      envFile,
      [
        '# legacy plaintext config',
        'API_URL=http://from-file:8080',
        'API_TOKEN=file-secret-token',
        'export QUOTED="quoted value"',
        '',
      ].join('\n'),
    );
    const server = addEnvServer(harness, { envFile, name: 'legacy-env' });

    const profile = await harness.service.migrateEnvFile(server.id, 'Migrated legacy config');

    expect(profile.name).toBe('Migrated legacy config');
    expect(profile.entries.map((entry) => entry.key)).toEqual(['API_URL', 'API_TOKEN', 'QUOTED']);
    expect(profile.entries.every((entry) => entry.source === 'encrypted')).toBe(true);
    expect(profile.attachedServerIds).toEqual([server.id]);

    // The profile is attached, the legacy file path is cleared and values live in the vault.
    expect(serverProfileIds(harness, server.id)).toEqual([profile.id]);
    expect(harness.repository.getServer(server.id)?.envFile).toBeNull();
    expect(harness.vault.getSecret(profileEnvSecretName(profile.id, 'API_TOKEN'))).toBe(
      'file-secret-token',
    );
    expect(harness.vault.getSecret(profileEnvSecretName(profile.id, 'API_URL'))).toBe(
      'http://from-file:8080',
    );
    expect(JSON.stringify(harness.db.prepare('SELECT * FROM config_profiles').all())).not.toContain(
      'file-secret-token',
    );

    // The running server receives the migrated values.
    await harness.supervisor.start(server.id);
    expect(await reportEnv(harness.supervisor, server.id, ['API_URL', 'API_TOKEN', 'QUOTED'])).toEqual({
      API_URL: 'http://from-file:8080',
      API_TOKEN: 'file-secret-token',
      QUOTED: 'quoted value',
    });
  });

  it('derives a unique name when none is supplied', async () => {
    const envFile = join(tempDir, 'auto.env');
    writeFileSync(envFile, 'API_URL=http://auto\n');
    const server = addEnvServer(harness, { envFile, name: 'auto-name' });

    const profile = await harness.service.migrateEnvFile(server.id);
    expect(profile.name).toBe('auto-name configuration');
  });

  it('rejects servers without an env file and empty files', async () => {
    const server = addEnvServer(harness);
    expect(
      (await rejectedGatewayError(() => harness.service.migrateEnvFile(server.id))).code,
    ).toBe(ErrorCodes.INVALID_PARAMS);

    const emptyFile = join(tempDir, 'empty.env');
    writeFileSync(emptyFile, '# only comments\n\n');
    harness.repository.upsertServer({ ...server, envFile: emptyFile });
    const error = await rejectedGatewayError(() => harness.service.migrateEnvFile(server.id));
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(error.message).toContain('no KEY=VALUE');
  });

  it('fails clearly when the vault is disabled, leaving the env file in place', async () => {
    const disabled = createHarness({ vaultSecret: null });
    try {
      const envFile = join(tempDir, 'disabled.env');
      writeFileSync(envFile, 'API_TOKEN=file-secret\n');
      const server = addEnvServer(disabled, { envFile, name: 'vault-disabled' });

      const error = await rejectedGatewayError(() => disabled.service.migrateEnvFile(server.id));
      expect(error.code).toBe(ErrorCodes.NOT_IMPLEMENTED);
      expect(disabled.repository.getServer(server.id)?.envFile).toBe(envFile);
      expect(disabled.service.list()).toEqual([]);
    } finally {
      await disabled.close();
    }
  });

  it('validates the explicit profile name', async () => {
    const envFile = join(tempDir, 'named.env');
    writeFileSync(envFile, 'API_URL=http://named\n');
    const server = addEnvServer(harness, { envFile, name: 'named-server' });
    const invalidName: ConfigProfileInput['name'] = 'bad/name';
    const error = await rejectedGatewayError(() =>
      harness.service.migrateEnvFile(server.id, invalidName),
    );
    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
  });
});
