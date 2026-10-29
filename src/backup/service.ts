/**
 * Password-encrypted gateway backups (v0.6).
 *
 * `create()` snapshots the full gateway state (users, API keys, servers, tools,
 * update sources, config-profile metadata, catalog sources, escalations,
 * delegation traces, settings, optional audit rows and EVERY vault secret) and
 * writes a password-encrypted `.mcpbak` envelope plus a metadata sidecar under
 * `<dataDir>/backups/` (dir 0700, files 0600).
 *
 * `restore()` decrypts a backup and applies it transactionally: all current
 * state is replaced, API keys keep their hashes (existing plaintext keys keep
 * working), UI users keep their password hashes, vault secrets are re-encrypted
 * under this gateway's vault key, restored servers are stopped and servers whose
 * checked-out code is missing are reported in `reinstallRequired`.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { GatewayConfig } from '../core/config.js';
import { ErrorCodes, GatewayError, invalidParams } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type { Logger } from '../core/logger.js';
import type { BackupCreateOptions, BackupService, VaultService } from '../core/ports.js';
import type { BackupEnvelope, BackupMetadata, RestoreResult } from '../core/types.js';
import {
  BACKUP_GATEWAY_VERSION,
  decryptBackup,
  encryptBackup,
} from './crypto.js';

const BACKUP_DIR_MODE = 0o700;
const BACKUP_FILE_MODE = 0o600;
const BACKUP_ID_PATTERN = /^backup_[A-Za-z0-9_-]{8,64}$/;
const RESTORE_CONFIRMATION = 'RESTORE';
const RESTORED_SERVER_ERROR = 'Restored from backup — reinstall code if missing';

/** Row shape read directly from SQLite (snake_case columns). */
type SqlRow = Record<string, unknown>;

type BackupTable =
  | 'ui_users'
  | 'api_keys'
  | 'servers'
  | 'tools'
  | 'server_sources'
  | 'config_profiles'
  | 'catalog_sources'
  | 'escalations'
  | 'delegation_traces'
  | 'settings';

/** FK-safe delete order (children first; audit is conditional). */
const CLEAR_ORDER: readonly string[] = [
  'tools',
  'server_sources',
  'servers',
  'config_profiles',
  'catalog_sources',
  'escalations',
  'delegation_traces',
  'settings',
  'ui_sessions',
  'ui_users',
  'api_keys',
  'vault_secrets',
];

/** Insert order honoring foreign keys (parents first). */
const INSERT_ORDER: readonly BackupTable[] = [
  'ui_users',
  'api_keys',
  'servers',
  'tools',
  'server_sources',
  'config_profiles',
  'catalog_sources',
  'escalations',
  'delegation_traces',
  'settings',
];

export interface DefaultBackupServiceDeps {
  db: DatabaseSync;
  config: GatewayConfig;
  vault: VaultService;
  logger?: Logger;
}

export interface BackupPayload {
  gatewayVersion: string;
  createdAt: string;
  users: SqlRow[];
  apiKeys: SqlRow[];
  servers: SqlRow[];
  tools: SqlRow[];
  serverSources: SqlRow[];
  configProfiles: SqlRow[];
  catalogSources: SqlRow[];
  escalations: SqlRow[];
  delegationTraces: SqlRow[];
  settings: SqlRow[];
  /** `null` when the backup was created without audit history. */
  audit: SqlRow[] | null;
  vaultSecrets: Array<{ name: string; value: string }>;
}

function notFound(id: string): GatewayError {
  return new GatewayError(ErrorCodes.TOOL_NOT_FOUND, `Backup '${id}' was not found`, {
    httpStatus: 404,
    data: { status: 'NOT_FOUND', details: { backupId: id } },
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRows(value: unknown): SqlRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).map((row) => ({ ...row }));
}

function toSqliteValue(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  return JSON.stringify(value);
}

export class DefaultBackupService implements BackupService {
  private readonly db: DatabaseSync;
  private readonly config: GatewayConfig;
  private readonly vault: VaultService;
  private readonly logger: Logger;

  constructor(deps: DefaultBackupServiceDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.vault = deps.vault;
    this.logger = deps.logger ?? createLogger('backup', 'silent');
  }

  // -------------------------------------------------------------------------
  // Create / list / read / remove
  // -------------------------------------------------------------------------

  create(options: BackupCreateOptions): BackupMetadata {
    if (typeof options.password !== 'string' || options.password.length === 0) {
      throw invalidParams('A backup password is required');
    }
    const includeAudit = options.includeAudit !== false;
    const createdAt = new Date().toISOString();
    const payload = this.buildPayload(createdAt, includeAudit);
    const envelope = encryptBackup(payload, options.password);
    const envelopeJson = JSON.stringify(envelope);

    const id = buildBackupId(createdAt);
    const fileName = `${id}.mcpbak`;
    const counts = {
      users: payload.users.length,
      keys: payload.apiKeys.length,
      servers: payload.servers.length,
      tools: payload.tools.length,
      profiles: payload.configProfiles.length,
      catalogSources: payload.catalogSources.length,
      secrets: payload.vaultSecrets.length,
      auditEntries: payload.audit?.length ?? 0,
    };
    const metadata: BackupMetadata = {
      id,
      fileName,
      createdAt,
      sizeBytes: Buffer.byteLength(envelopeJson, 'utf8'),
      gatewayVersion: BACKUP_GATEWAY_VERSION,
      includeAudit,
      counts,
    };

    const dir = this.backupDir();
    this.ensureBackupDir(dir);
    const envelopePath = join(dir, fileName);
    const metaPath = join(dir, `${id}.meta.json`);
    writeFileSync(envelopePath, envelopeJson, { encoding: 'utf8', mode: BACKUP_FILE_MODE });
    writeFileSync(metaPath, JSON.stringify(metadata), { encoding: 'utf8', mode: BACKUP_FILE_MODE });
    try {
      chmodSync(envelopePath, BACKUP_FILE_MODE);
      chmodSync(metaPath, BACKUP_FILE_MODE);
    } catch {
      // Best effort: the write mode already restricts new files.
    }

    this.logger.info('backup created', {
      backupId: id,
      sizeBytes: metadata.sizeBytes,
      includeAudit,
      counts,
    });
    return metadata;
  }

  list(): BackupMetadata[] {
    const dir = this.backupDir();
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    const metadata: BackupMetadata[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.meta.json')) continue;
      const id = entry.slice(0, -'.meta.json'.length);
      if (!BACKUP_ID_PATTERN.test(id)) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as unknown;
        if (isBackupMetadata(parsed)) metadata.push(parsed);
      } catch {
        this.logger.warn('skipping unreadable backup metadata', { file: entry });
      }
    }
    metadata.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    return metadata;
  }

  read(id: string): { metadata: BackupMetadata; envelope: BackupEnvelope } {
    this.assertBackupId(id);
    const dir = this.backupDir();
    const metaPath = join(dir, `${id}.meta.json`);
    if (!existsSync(metaPath)) throw notFound(id);
    let metadata: BackupMetadata;
    try {
      const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as unknown;
      if (!isBackupMetadata(parsed)) throw new Error('invalid metadata');
      metadata = parsed;
    } catch {
      throw invalidParams(`Stored backup '${id}' has invalid metadata`);
    }
    const envelopePath = join(dir, metadata.fileName);
    if (!existsSync(envelopePath)) throw notFound(id);
    let envelope: BackupEnvelope;
    try {
      const parsed = JSON.parse(readFileSync(envelopePath, 'utf8')) as unknown;
      if (!isPlainObject(parsed)) throw new Error('invalid envelope');
      envelope = parsed as unknown as BackupEnvelope;
    } catch {
      throw invalidParams(`Stored backup '${id}' is corrupted`);
    }
    return { metadata, envelope };
  }

  remove(id: string): void {
    this.assertBackupId(id);
    const dir = this.backupDir();
    const metaPath = join(dir, `${id}.meta.json`);
    const envelopePath = join(dir, `${id}.mcpbak`);
    const hasMeta = existsSync(metaPath);
    const hasEnvelope = existsSync(envelopePath);
    if (!hasMeta && !hasEnvelope) throw notFound(id);
    for (const file of [metaPath, envelopePath]) {
      try {
        unlinkSync(file);
      } catch {
        // Already gone — removal is idempotent for the existing id.
      }
    }
    this.logger.info('backup removed', { backupId: id });
  }

  // -------------------------------------------------------------------------
  // Restore
  // -------------------------------------------------------------------------

  restore(input: { envelope: BackupEnvelope; password: string; confirm: string }): RestoreResult {
    if (input.confirm !== RESTORE_CONFIRMATION) {
      throw invalidParams(`Restore confirmation must be the string "${RESTORE_CONFIRMATION}"`);
    }
    const payload = this.parsePayload(decryptBackup(input.envelope, input.password));
    if (payload.vaultSecrets.length > 0 && !this.vault.isEnabled()) {
      throw invalidParams(
        'Vault is not configured (set MCP_VAULT_SECRET); the backup contains vault secrets that cannot be restored',
      );
    }

    const reinstallRequired = this.pendingReinstalls(payload.servers);
    const result: RestoreResult = {
      usersRestored: payload.users.length,
      keysRestored: payload.apiKeys.length,
      serversRestored: payload.servers.length,
      toolsRestored: payload.tools.length,
      profilesRestored: payload.configProfiles.length,
      catalogSourcesRestored: payload.catalogSources.length,
      secretsRestored: payload.vaultSecrets.length,
      auditEntriesRestored: payload.audit?.length ?? 0,
      reinstallRequired,
    };

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const clearTables = [...CLEAR_ORDER];
      if (payload.audit !== null) clearTables.push('audit_log');
      for (const table of clearTables) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }

      for (const table of INSERT_ORDER) {
        this.insertRows(table, payload[payloadFieldFor(table)] as unknown as SqlRow[], table === 'servers');
      }
      if (payload.audit !== null) this.insertRows('audit_log', payload.audit, false);

      // Re-encrypt every vault secret under this gateway's vault key.
      for (const secret of payload.vaultSecrets) {
        this.vault.setSecret(secret.name, secret.value);
      }

      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // A failed rollback must not mask the original error.
      }
      if (error instanceof GatewayError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('backup restore failed', { error: message });
      throw new GatewayError(ErrorCodes.INTERNAL_ERROR, 'Backup restore failed', {
        cause: error,
        httpStatus: 500,
        data: { status: 'INTERNAL_ERROR' },
      });
    }

    this.logger.info('backup restored', {
      users: result.usersRestored,
      keys: result.keysRestored,
      servers: result.serversRestored,
      secrets: result.secretsRestored,
      reinstallRequired: result.reinstallRequired.length,
    });
    return result;
  }

  restoreFirstRun(input: { envelope: BackupEnvelope; password: string }): RestoreResult {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM ui_users').get() as
      | { count?: number }
      | undefined;
    if (Number(row?.count ?? 0) > 0) {
      throw new GatewayError(
        ErrorCodes.ACCESS_DENIED,
        'First-run restore is only allowed while the gateway has no Web UI users',
        { httpStatus: 409, data: { status: 'FORBIDDEN', reason: 'GATEWAY_ALREADY_CONFIGURED' } },
      );
    }
    return this.restore({ envelope: input.envelope, password: input.password, confirm: RESTORE_CONFIRMATION });
  }

  // -------------------------------------------------------------------------
  // Payload / file helpers
  // -------------------------------------------------------------------------

  private buildPayload(createdAt: string, includeAudit: boolean): BackupPayload {
    const tableRows = (table: string): SqlRow[] =>
      this.db.prepare(`SELECT * FROM ${table}`).all() as unknown as SqlRow[];

    const vaultSecrets: Array<{ name: string; value: string }> = [];
    if (this.vault.isEnabled()) {
      for (const metadata of this.vault.listSecrets()) {
        const value = this.vault.getSecret(metadata.name);
        if (value === null) continue;
        vaultSecrets.push({ name: metadata.name, value });
      }
    } else {
      this.logger.warn('vault is disabled; backup will not include vault secrets');
    }
    vaultSecrets.sort((left, right) => left.name.localeCompare(right.name));

    return {
      gatewayVersion: BACKUP_GATEWAY_VERSION,
      createdAt,
      users: tableRows('ui_users'),
      apiKeys: tableRows('api_keys'),
      servers: tableRows('servers'),
      tools: tableRows('tools'),
      serverSources: tableRows('server_sources'),
      configProfiles: tableRows('config_profiles'),
      catalogSources: tableRows('catalog_sources'),
      escalations: tableRows('escalations'),
      delegationTraces: tableRows('delegation_traces'),
      settings: tableRows('settings'),
      audit: includeAudit ? tableRows('audit_log') : null,
      vaultSecrets,
    };
  }

  private parsePayload(decrypted: unknown): BackupPayload {
    if (!isPlainObject(decrypted)) throw this.invalidPayload();
    const raw = decrypted as Record<string, unknown>;
    const vaultSecrets: Array<{ name: string; value: string }> = [];
    if (Array.isArray(raw.vaultSecrets)) {
      for (const item of raw.vaultSecrets) {
        if (!isPlainObject(item)) continue;
        const name = item.name;
        const value = item.value;
        if (typeof name !== 'string' || name.length === 0 || typeof value !== 'string') continue;
        vaultSecrets.push({ name, value });
      }
    }
    const audit = raw.audit === undefined || raw.audit === null ? null : asRows(raw.audit);
    if (raw.audit !== undefined && raw.audit !== null && !Array.isArray(raw.audit)) {
      throw this.invalidPayload();
    }
    return {
      gatewayVersion:
        typeof raw.gatewayVersion === 'string' ? raw.gatewayVersion : BACKUP_GATEWAY_VERSION,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
      users: asRows(raw.users),
      apiKeys: asRows(raw.apiKeys),
      servers: asRows(raw.servers),
      tools: asRows(raw.tools),
      serverSources: asRows(raw.serverSources),
      configProfiles: asRows(raw.configProfiles),
      catalogSources: asRows(raw.catalogSources),
      escalations: asRows(raw.escalations),
      delegationTraces: asRows(raw.delegationTraces),
      settings: asRows(raw.settings),
      audit,
      vaultSecrets,
    };
  }

  private invalidPayload(): GatewayError {
    return invalidParams('Decrypted backup payload is not a valid MCP Gateway backup');
  }

  private insertRows(table: string, rows: SqlRow[], isServers: boolean): void {
    if (rows.length === 0) return;
    const columns = this.tableColumns(table);

    for (const original of rows) {
      const row = isServers ? restoreServerRow(original) : original;
      const keys = Object.keys(row).filter((key) => columns.has(key));
      if (keys.length === 0) continue;
      this.db
        .prepare(
          `INSERT INTO ${table} (${keys.map((key) => `"${key}"`).join(', ')})
           VALUES (${keys.map(() => '?').join(', ')})`,
        )
        .run(...keys.map((key) => toSqliteValue(row[key])));
    }
  }

  private tableColumns(table: string): Set<string> {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  }

  private pendingReinstalls(serverRows: SqlRow[]): Array<{ serverId: string; name: string }> {
    const required: Array<{ serverId: string; name: string }> = [];
    for (const row of serverRows) {
      if (row.transport !== 'stdio') continue;
      const serverId = typeof row.id === 'string' ? row.id : '';
      const name = typeof row.name === 'string' ? row.name : serverId;
      if (serverId.length === 0) continue;
      const workDir = row.work_dir;
      if (typeof workDir !== 'string' || workDir.length === 0 || !existsSync(workDir)) {
        required.push({ serverId, name });
      }
    }
    return required.sort((left, right) => left.name.localeCompare(right.name));
  }

  private backupDir(): string {
    return join(this.config.dataDir, 'backups');
  }

  private ensureBackupDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: BACKUP_DIR_MODE });
    try {
      chmodSync(dir, BACKUP_DIR_MODE);
    } catch {
      // Best effort on platforms without POSIX modes (e.g. Windows dev hosts).
    }
  }

  private assertBackupId(id: string): void {
    if (typeof id !== 'string' || !BACKUP_ID_PATTERN.test(id)) throw notFound(String(id));
  }
}

function restoreServerRow(row: SqlRow): SqlRow {
  const next: SqlRow = { ...row };
  next.status = 'stopped';
  next.pid = null;
  next.last_error = RESTORED_SERVER_ERROR;
  return next;
}

function payloadFieldFor(table: BackupTable): keyof BackupPayload {
  switch (table) {
    case 'ui_users':
      return 'users';
    case 'api_keys':
      return 'apiKeys';
    case 'servers':
      return 'servers';
    case 'tools':
      return 'tools';
    case 'server_sources':
      return 'serverSources';
    case 'config_profiles':
      return 'configProfiles';
    case 'catalog_sources':
      return 'catalogSources';
    case 'escalations':
      return 'escalations';
    case 'delegation_traces':
      return 'delegationTraces';
    case 'settings':
      return 'settings';
    default: {
      const exhaustive: never = table;
      throw new Error(`Unsupported backup table: ${String(exhaustive)}`);
    }
  }
}

function buildBackupId(createdAt: string): string {
  const compact = createdAt.replace(/[-:]/g, '').replace('.', '');
  const random = randomHex(3);
  return `backup_${compact}_${random}`;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function isBackupMetadata(value: unknown): value is BackupMetadata {
  if (!isPlainObject(value)) return false;
  const counts = value.counts;
  return (
    typeof value.id === 'string' &&
    BACKUP_ID_PATTERN.test(value.id) &&
    typeof value.fileName === 'string' &&
    value.fileName.length > 0 &&
    typeof value.createdAt === 'string' &&
    typeof value.sizeBytes === 'number' &&
    typeof value.gatewayVersion === 'string' &&
    typeof value.includeAudit === 'boolean' &&
    isPlainObject(counts)
  );
}
