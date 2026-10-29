import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import type { GatewayConfig } from '../../src/core/config.js';
import { openDatabase } from '../../src/core/db.js';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import { nowIso } from '../../src/core/ids.js';
import { DefaultBackupService } from '../../src/backup/service.js';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';
import { SqliteAuditService } from '../../src/gateway/audit.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';
import { SqliteVaultService } from '../../src/vault/store.js';
import { SqliteUiAuthService } from '../../src/auth/service.js';
import {
  HIDDEN_API_KEY_NAME,
  HIDDEN_SECRET_VALUE,
  OPERATOR_PASSWORD,
  OPERATOR_USERNAME,
  makeBackupConfig,
  makeRoot,
  removeRoot,
  seedState,
  type BackupHarness,
} from './support.js';

const RESTORED_ERROR = 'Restored from backup — reinstall code if missing';
const harnesses: BackupHarness[] = [];
const roots: string[] = [];
const extraDbs: DatabaseSync[] = [];

beforeEach(() => {
  roots.push(makeRoot('backup-restore-'));
});

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()?.dispose();
  while (extraDbs.length > 0) extraDbs.pop()?.close();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) removeRoot(root);
  }
});

interface FreshGateway {
  db: DatabaseSync;
  config: GatewayConfig;
  vault: SqliteVaultService;
  keys: SqliteKeyService;
  auth: SqliteUiAuthService;
  repository: SqliteCatalogRepository;
  audit: SqliteAuditService;
}

function freshGateway(config: GatewayConfig, vaultSecret: string | null = config.vaultSecret): FreshGateway {
  const db = openDatabase(':memory:');
  extraDbs.push(db);
  const vault = new SqliteVaultService(db, vaultSecret);
  return {
    db,
    config,
    vault,
    keys: new SqliteKeyService(db, { pepper: null }),
    auth: new SqliteUiAuthService(db, config),
    repository: new SqliteCatalogRepository(db),
    audit: new SqliteAuditService(db),
  };
}

function setupSource(): {
  harness: BackupHarness;
  service: DefaultBackupService;
  config: GatewayConfig;
  envelope: ReturnType<DefaultBackupService['read']>['envelope'];
  metadata: ReturnType<DefaultBackupService['create']>;
} {
  const root = roots[roots.length - 1] as string;
  const config = makeBackupConfig(root);
  const db = openDatabase(':memory:');
  const harness = seedState(db, config);
  harnesses.push(harness);
  const service = new DefaultBackupService({ db, config, vault: harness.vault });
  const metadata = service.create({ password: OPERATOR_PASSWORD });
  const { envelope } = service.read(metadata.id);
  return { harness, service, config, envelope, metadata };
}

function count(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function expectGatewayError(fn: () => unknown, code: number = ErrorCodes.INVALID_PARAMS): GatewayError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    const gatewayError = error as GatewayError;
    expect(gatewayError.code).toBe(code);
    return gatewayError;
  }
  throw new Error('expected a GatewayError');
}

describe('DefaultBackupService.restore', () => {
  it('restores users, key hashes, vault secrets, servers and reinstall-required state', () => {
    const { harness, config, envelope } = setupSource();
    const fresh = freshGateway(config);
    const service = new DefaultBackupService({ db: fresh.db, config, vault: fresh.vault });

    // A stale session on the target must be cleared by restore.
    fresh.db
      .prepare(
        `INSERT INTO ui_sessions (id, token_hash, username, created_at, expires_at, last_seen_at, revoked_at)
         VALUES ('sess_stale', 'hash_stale', ?, ?, ?, ?, NULL)`,
      )
      .run(OPERATOR_USERNAME, nowIso(), nowIso(), nowIso());

    const result = service.restore({ envelope, password: OPERATOR_PASSWORD, confirm: 'RESTORE' });

    expect(result).toEqual({
      usersRestored: 1,
      keysRestored: 1,
      serversRestored: 3,
      toolsRestored: 1,
      profilesRestored: 1,
      catalogSourcesRestored: 1,
      secretsRestored: 2,
      auditEntriesRestored: 2,
      reinstallRequired: [{ serverId: 'srv_missing0000001', name: 'missing-server' }],
    });

    // The old UI password still logs in (password hash restored).
    const session = fresh.auth.login(OPERATOR_USERNAME, OPERATOR_PASSWORD);
    expect(session.user.username).toBe(OPERATOR_USERNAME);
    expect(count(fresh.db, 'ui_sessions')).toBe(1); // only the fresh login above
    expect(count(fresh.db, 'ui_users')).toBe(1);

    // The old API key plaintext still authenticates (hash restored).
    const key = fresh.keys.authenticate(harness.agentPlaintext);
    expect(key.id).toBe(harness.agentKeyId);
    expect(key.keyType).toBe('agent');

    // Vault secrets were re-encrypted under this gateway's vault key.
    expect(fresh.vault.getSecret(HIDDEN_API_KEY_NAME)).toBe(HIDDEN_SECRET_VALUE);
    expect(fresh.vault.getSecret('GITHUB_TOKEN')).toBe('ghp_hidden_backup_fixture_token_0123456789');

    // Restored servers are stopped, sanitized and keep their configuration.
    const healthy = fresh.repository.getServer('srv_healthy0000001');
    expect(healthy).toMatchObject({
      name: 'healthy-server',
      status: 'stopped',
      pid: null,
      lastError: RESTORED_ERROR,
      env: { EXAMPLE_FLAG: 'on' },
      headers: { 'x-example': '1' },
      configProfileIds: ['cfg_fixture'],
    });
    expect(fresh.repository.getServer('srv_missing0000001')?.status).toBe('stopped');
    expect(fresh.repository.getServer('srv_remote0000001')?.status).toBe('stopped');
    expect(fresh.repository.listToolsByServer('srv_healthy0000001')).toHaveLength(1);
    expect(count(fresh.db, 'server_sources')).toBe(1);
    expect(count(fresh.db, 'config_profiles')).toBe(1);
    expect(count(fresh.db, 'catalog_sources')).toBe(1);
    expect(count(fresh.db, 'escalations')).toBe(1);
    expect(count(fresh.db, 'delegation_traces')).toBe(1);
    expect(count(fresh.db, 'settings')).toBe(1);
    expect(count(fresh.db, 'audit_log')).toBe(2);
  });

  it('replaces existing gateway state instead of merging it', () => {
    const { config, envelope } = setupSource();
    const fresh = freshGateway(config);
    fresh.auth.setup('other-user', 'other-password-123456');
    fresh.repository.upsertServer({
      id: 'srv_old',
      name: 'old-server',
      runtime: 'node',
      transport: 'stdio',
      status: 'running',
      command: 'node',
      args: [],
      url: null,
      env: {},
      headers: {},
      manifest: null,
      highPrivilegeTools: [],
      delegationSupported: false,
      sourceUrl: null,
      workDir: null,
      lastError: null,
      pid: 999,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const service = new DefaultBackupService({ db: fresh.db, config, vault: fresh.vault });

    service.restore({ envelope, password: OPERATOR_PASSWORD, confirm: 'RESTORE' });

    expect(fresh.repository.getServer('srv_old')).toBeNull();
    expect(fresh.repository.getServer('srv_healthy0000001')).not.toBeNull();
    expect(fresh.auth.hasUsers()).toBe(true);
    expect(count(fresh.db, 'ui_users')).toBe(1);
    expect(fresh.auth.verifyUserPassword('other-user', 'other-password-123456')).toBe(false);
  });

  it('keeps existing audit history when the backup was created without it', () => {
    const root = roots[roots.length - 1] as string;
    const config = makeBackupConfig(root);
    const sourceDb = openDatabase(':memory:');
    const harness = seedState(sourceDb, config);
    harnesses.push(harness);
    const sourceService = new DefaultBackupService({ db: sourceDb, config, vault: harness.vault });
    const metadata = sourceService.create({ password: OPERATOR_PASSWORD, includeAudit: false });
    const { envelope } = sourceService.read(metadata.id);

    const fresh = freshGateway(config);
    fresh.audit.record({
      requestId: null,
      keyId: null,
      method: 'tools/call',
      serverId: 'srv_existing',
      toolId: null,
      status: 'ok',
      latencyMs: 1,
    });
    const service = new DefaultBackupService({ db: fresh.db, config, vault: fresh.vault });
    const result = service.restore({ envelope, password: OPERATOR_PASSWORD, confirm: 'RESTORE' });

    expect(result.auditEntriesRestored).toBe(0);
    // The target's own audit trail is preserved when the backup excludes audit.
    expect(count(fresh.db, 'audit_log')).toBe(1);
  });

  it('rejects wrong passwords/confirmation/corruption without touching the target', () => {
    const { config, envelope } = setupSource();
    const fresh = freshGateway(config);
    const service = new DefaultBackupService({ db: fresh.db, config, vault: fresh.vault });

    const before = {
      users: count(fresh.db, 'ui_users'),
      servers: count(fresh.db, 'servers'),
      secrets: count(fresh.db, 'vault_secrets'),
    };

    expectGatewayError(() =>
      service.restore({ envelope, password: 'wrong-password', confirm: 'RESTORE' }),
    );
    expectGatewayError(() => service.restore({ envelope, password: OPERATOR_PASSWORD, confirm: 'restore' }));
    const tampered = {
      ...envelope,
      cipher: { ...envelope.cipher, dataB64: Buffer.alloc(32, 3).toString('base64') },
    };
    expectGatewayError(() =>
      service.restore({ envelope: tampered, password: OPERATOR_PASSWORD, confirm: 'RESTORE' }),
    );

    expect({
      users: count(fresh.db, 'ui_users'),
      servers: count(fresh.db, 'servers'),
      secrets: count(fresh.db, 'vault_secrets'),
    }).toEqual(before);
  });

  it('requires an enabled vault when the backup contains secrets', () => {
    const { config, envelope } = setupSource();
    const fresh = freshGateway(config, null);
    const service = new DefaultBackupService({ db: fresh.db, config, vault: fresh.vault });

    const error = expectGatewayError(() =>
      service.restore({ envelope, password: OPERATOR_PASSWORD, confirm: 'RESTORE' }),
    );
    expect(error.message).toContain('Vault is not configured');
    expect(count(fresh.db, 'ui_users')).toBe(0);
  });

  it('removes vault secrets that are not part of the backup', () => {
    const { config, envelope } = setupSource();
    const fresh = freshGateway(config);
    fresh.vault.setSecret('ONLY_ON_TARGET', 'stale-secret-value');
    const service = new DefaultBackupService({ db: fresh.db, config, vault: fresh.vault });

    service.restore({ envelope, password: OPERATOR_PASSWORD, confirm: 'RESTORE' });

    expect(fresh.vault.getSecret('ONLY_ON_TARGET')).toBeNull();
    expect(fresh.vault.listSecrets().map((secret) => secret.name)).toEqual([
      'GITHUB_TOKEN',
      HIDDEN_API_KEY_NAME,
    ]);
  });
});

describe('DefaultBackupService.restoreFirstRun', () => {
  it('restores when no UI user exists yet', () => {
    const { config, envelope } = setupSource();
    const fresh = freshGateway(config);
    const service = new DefaultBackupService({ db: fresh.db, config, vault: fresh.vault });

    const result = service.restoreFirstRun({ envelope, password: OPERATOR_PASSWORD });
    expect(result.usersRestored).toBe(1);
    expect(fresh.auth.login(OPERATOR_USERNAME, OPERATOR_PASSWORD).user.username).toBe(OPERATOR_USERNAME);
  });

  it('refuses when the gateway already has a UI user (409)', () => {
    const { config, envelope } = setupSource();
    const fresh = freshGateway(config);
    fresh.auth.ensureBootstrapUser();
    const service = new DefaultBackupService({ db: fresh.db, config, vault: fresh.vault });

    const error = expectGatewayError(
      () => service.restoreFirstRun({ envelope, password: OPERATOR_PASSWORD }),
      ErrorCodes.ACCESS_DENIED,
    );
    expect(error.httpStatus).toBe(409);
    expect(count(fresh.db, 'ui_users')).toBe(1);
  });
});
