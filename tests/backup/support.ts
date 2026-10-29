/**
 * Shared harness for v0.6 encrypted-backup tests.
 *
 * Builds real in-memory (or file-backed) SQLite databases with the full gateway
 * schema plus seeded users, API keys, servers/tools, update sources, profiles,
 * catalog sources, escalations, delegation traces, settings, audit rows and
 * AES-vault secrets. All scratch files live under `.test-data/`.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { GatewayConfig } from '../../src/core/config.js';
import { openDatabase } from '../../src/core/db.js';
import { nowIso } from '../../src/core/ids.js';
import type { ServerRecord } from '../../src/core/types.js';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';
import { SqliteServerSourceStore } from '../../src/updates/store.js';
import { SqliteAuditService } from '../../src/gateway/audit.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';
import { SqliteVaultService } from '../../src/vault/store.js';
import { SqliteUiAuthService } from '../../src/auth/service.js';

export const BACKUP_VAULT_SECRET = 'backup-test-vault-secret-0123456789';
export const OPERATOR_USERNAME = 'admin';
export const OPERATOR_PASSWORD = 'operator-password-123456';
export const HIDDEN_SECRET_VALUE = 'vault-hidden-fixture-secret-9f2a';
export const HIDDEN_API_KEY_NAME = 'N8N_API_KEY';
export const HIDDEN_GITHUB_TOKEN = 'ghp_hidden_backup_fixture_token_0123456789';

const TEST_DATA_DIR = join(process.cwd(), '.test-data');

export interface BackupHarness {
  root: string;
  config: GatewayConfig;
  db: DatabaseSync;
  vault: SqliteVaultService;
  keys: SqliteKeyService;
  auth: SqliteUiAuthService;
  audit: SqliteAuditService;
  agentKeyId: string;
  agentPlaintext: string;
  servers: { healthyId: string; missingId: string; remoteId: string };
  dispose(): void;
}

export function makeBackupConfig(root: string, overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir: join(root, 'data'),
    dbPath: join(root, 'data', 'gateway.db'),
    uiDistDir: join(root, 'ui'),
    vaultSecret: BACKUP_VAULT_SECRET,
    bootstrapMasterKey: null,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: [],
    reposDir: join(root, 'data', 'repos'),
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 10_000,
    keyPepper: null,
    publicBaseUrl: 'http://127.0.0.1:8080',
    uiUsername: OPERATOR_USERNAME,
    uiPassword: OPERATOR_PASSWORD,
    uiSessionTtlMs: 60 * 60 * 1000,
    uiCookieSecure: false,
    ...overrides,
  };
}

export function makeRoot(prefix = 'backup-'): string {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  return mkdtempSync(join(TEST_DATA_DIR, prefix));
}

export function removeRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function seedServer(
  repository: SqliteCatalogRepository,
  input: {
    id: string;
    name: string;
    transport: 'stdio' | 'http';
    workDir: string | null;
    status?: ServerRecord['status'];
  },
): void {
  const now = nowIso();
  repository.upsertServer({
    id: input.id,
    name: input.name,
    runtime: input.transport === 'stdio' ? 'node' : 'remote-agent',
    transport: input.transport,
    status: input.status ?? 'running',
    command: input.transport === 'stdio' ? 'node' : null,
    args: input.transport === 'stdio' ? ['server.js'] : [],
    url: input.transport === 'http' ? 'https://example.internal/mcp' : null,
    env: { EXAMPLE_FLAG: 'on' },
    headers: { 'x-example': '1' },
    manifest: {
      name: input.name,
      version: '1.0.0',
      runtime: 'node20',
      start_command: 'node server.js',
    },
    highPrivilegeTools: ['danger_delete'],
    delegationSupported: false,
    sourceUrl: 'https://github.com/example/backup-fixture',
    workDir: input.workDir,
    envFile: null,
    approvalRequiredTools: ['echo'],
    configProfileIds: ['cfg_fixture'],
    capabilities: { tools: { listChanged: true } },
    instructions: 'fixture instructions',
    prompts: [],
    resources: [],
    lastError: null,
    pid: 1234,
    createdAt: now,
    updatedAt: now,
  });
}

/** Seeds a representative gateway state and returns handles used by tests. */
export function seedState(db: DatabaseSync, config: GatewayConfig): BackupHarness {
  const root = config.dataDir.replace(/\/data$/, '');
  const repository = new SqliteCatalogRepository(db);
  const vault = new SqliteVaultService(db, BACKUP_VAULT_SECRET);
  const keys = new SqliteKeyService(db, { pepper: null });
  const audit = new SqliteAuditService(db);
  const auth = new SqliteUiAuthService(db, config);
  auth.ensureBootstrapUser();

  const issued = keys.issue({ name: 'backup-agent', keyType: 'agent', serverGrants: [] });
  const healthyDir = join(root, 'repos', 'healthy-server');
  mkdirSync(healthyDir, { recursive: true });
  const missingDir = join(root, 'repos', 'missing-server');

  seedServer(repository, { id: 'srv_healthy0000001', name: 'healthy-server', transport: 'stdio', workDir: healthyDir });
  seedServer(repository, { id: 'srv_missing0000001', name: 'missing-server', transport: 'stdio', workDir: missingDir });
  seedServer(repository, { id: 'srv_remote0000001', name: 'remote-server', transport: 'http', workDir: null });
  repository.upsertTools('srv_healthy0000001', [
    {
      id: 'srv_healthy0000001:echo',
      name: 'echo',
      description: 'Echo text',
      serverId: 'srv_healthy0000001',
      inputSchema: { type: 'object', properties: {} },
      highPrivilege: false,
      tags: [],
    },
  ]);

  const sources = new SqliteServerSourceStore(db);
  sources.upsert({
    serverId: 'srv_healthy0000001',
    sourceKind: 'git',
    catalogSourceId: null,
    catalogEntryId: null,
    repoUrl: 'https://github.com/example/backup-fixture',
    requestedRef: 'main',
    installedCommit: 'a'.repeat(40),
    installedVersion: '1.0.0',
    latestCommit: null,
    latestVersion: null,
    latestRef: null,
    updateAvailable: true,
    checkedAt: nowIso(),
    checkError: null,
    changelogUrl: null,
  });

  const now = nowIso();
  db.prepare(
    `INSERT INTO config_profiles
       (id, name, description, env_json, secret_keys_json, headers_json, env_file, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    'cfg_fixture',
    'Fixture profile',
    'Profile metadata only',
    JSON.stringify([
      { key: 'API_TOKEN', source: 'encrypted', ref: null },
      { key: 'EXISTING_KEY', source: 'vault-ref', ref: HIDDEN_API_KEY_NAME },
    ]),
    JSON.stringify(['PROFILE_CFG_FIXTURE_ENV_API_TOKEN']),
    '[]',
    now,
    now,
  );
  db.prepare(
    `INSERT INTO catalog_sources
       (id, label, kind, repo_url, ref, subpath, token_secret_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run('cat_fixture', 'Example catalog', 'github-repo', 'https://github.com/example/catalog', 'main', 'CATALOG_CAT_FIXTURE_TOKEN', now, now);
  db.prepare(
    `INSERT INTO escalations
       (id, ticket_id, key_id, tool_id, server_id, reason, request_payload, status, ticket_type,
        tool_arguments, result_json, consumed_at, created_at, resolved_at, resolved_by, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'scope', NULL, NULL, NULL, ?, NULL, NULL, NULL)`,
  ).run('esc_fixture', 'esc-20261029-fixture', issued.key.id, 'srv_healthy0000001:echo', 'srv_healthy0000001', 'HIGH_PRIVILEGE_RESTRICTION', '{}', now);
  db.prepare(
    `INSERT INTO delegation_traces
       (id, trace_id, parent_request_id, child_request_id, target, depth, status, verdict, latency_ms, created_at)
     VALUES (?, ?, NULL, NULL, ?, 1, 'approved', 'ok', 12.5, ?)`,
  ).run('del_fixture', 'tr_fixture', 'observer-bot', now);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('fixture.setting', 'enabled');

  audit.record({
    requestId: 'req_fixture',
    keyId: issued.key.id,
    method: 'tools/call',
    serverId: 'srv_healthy0000001',
    toolId: 'srv_healthy0000001:echo',
    status: 'ok',
    latencyMs: 12,
  });
  audit.record({
    requestId: null,
    keyId: issued.key.id,
    method: 'tools/call',
    serverId: 'srv_healthy0000001',
    toolId: 'srv_healthy0000001:echo',
    status: 'denied',
    latencyMs: 4,
  });

  vault.setSecret(HIDDEN_API_KEY_NAME, HIDDEN_SECRET_VALUE);
  vault.setSecret('GITHUB_TOKEN', HIDDEN_GITHUB_TOKEN);

  return {
    root,
    config,
    db,
    vault,
    keys,
    auth,
    audit,
    agentKeyId: issued.key.id,
    agentPlaintext: issued.plaintext,
    servers: {
      healthyId: 'srv_healthy0000001',
      missingId: 'srv_missing0000001',
      remoteId: 'srv_remote0000001',
    },
    dispose: () => db.close(),
  };
}

/** Opens a fresh in-memory DB with the schema (a "new gateway"). */
export function openFreshDb(): DatabaseSync {
  return openDatabase(':memory:');
}

export function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}
