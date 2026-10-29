import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, SCHEMA_VERSION } from '../../src/core/db.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const root = join(process.cwd(), '.test-data');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'migration-'));
  tempDirs.push(dir);
  return join(dir, 'gateway.db');
}

function columnNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('schema migration', () => {
  it('creates the v2 schema on a fresh database', () => {
    const db = openDatabase(tempDbPath());
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(6);

    expect(columnNames(db, 'servers')).toEqual(
      expect.arrayContaining([
        'env_file',
        'approval_required_tools',
        'config_profile_ids',
        'capabilities_json',
        'instructions',
        'prompts_json',
        'resources_json',
      ]),
    );
    expect(columnNames(db, 'escalations')).toEqual(
      expect.arrayContaining(['ticket_type', 'tool_arguments', 'result_json', 'consumed_at']),
    );
    expect(columnNames(db, 'api_keys')).toEqual(expect.arrayContaining(['paused_at']));
    for (const table of ['catalog_sources', 'ui_users', 'ui_sessions', 'server_sources', 'config_profiles']) {
      const found = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) as { name?: string } | undefined;
      expect(found?.name).toBe(table);
    }
    db.close();
  });

  it('upgrades an existing v1 database without losing data', () => {
    const path = tempDbPath();
    const db = new DatabaseSync(path);
    // Minimal v1 shape for the two tables that gained columns.
    db.exec(`
      CREATE TABLE servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        runtime TEXT NOT NULL,
        transport TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'stopped',
        command TEXT,
        args TEXT NOT NULL DEFAULT '[]',
        url TEXT,
        env TEXT NOT NULL DEFAULT '{}',
        manifest TEXT,
        high_privilege_tools TEXT NOT NULL DEFAULT '[]',
        delegation_supported INTEGER NOT NULL DEFAULT 0,
        source_url TEXT,
        work_dir TEXT,
        last_error TEXT,
        pid INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE escalations (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL UNIQUE,
        key_id TEXT NOT NULL,
        tool_id TEXT,
        server_id TEXT,
        reason TEXT NOT NULL,
        request_payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        note TEXT
      );
      PRAGMA user_version = 1;
    `);
    db.prepare(
      `INSERT INTO servers (id,name,runtime,transport,status,created_at,updated_at)
       VALUES ('srv_legacy','legacy','node','stdio','stopped','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO escalations (id,ticket_id,key_id,reason,status,created_at)
       VALUES ('esc_legacy','esc-20260101-abcd','key_legacy','HIGH_PRIVILEGE_RESTRICTION','pending','2026-01-01T00:00:00.000Z')`,
    ).run();

    migrate(db);

    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBe(6);
    expect(columnNames(db, 'servers')).toEqual(
      expect.arrayContaining([
        'env_file',
        'approval_required_tools',
        'config_profile_ids',
        'capabilities_json',
        'instructions',
        'prompts_json',
        'resources_json',
      ]),
    );
    expect(columnNames(db, 'escalations')).toEqual(
      expect.arrayContaining(['ticket_type', 'tool_arguments', 'result_json', 'consumed_at']),
    );

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get('srv_legacy') as Record<string, unknown>;
    expect(server.name).toBe('legacy');
    expect(server.approval_required_tools).toBe('[]');
    const ticket = db.prepare('SELECT * FROM escalations WHERE id = ?').get('esc_legacy') as Record<string, unknown>;
    expect(ticket.status).toBe('pending');
    expect(ticket.ticket_type).toBe('scope');
    db.close();
  });

  it('adds config_profile_ids when upgrading a v3 database', () => {
    const path = tempDbPath();
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        runtime TEXT NOT NULL,
        transport TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'stopped',
        command TEXT,
        args TEXT NOT NULL DEFAULT '[]',
        url TEXT,
        env TEXT NOT NULL DEFAULT '{}',
        headers TEXT NOT NULL DEFAULT '{}',
        manifest TEXT,
        high_privilege_tools TEXT NOT NULL DEFAULT '[]',
        delegation_supported INTEGER NOT NULL DEFAULT 0,
        source_url TEXT,
        work_dir TEXT,
        env_file TEXT,
        approval_required_tools TEXT NOT NULL DEFAULT '[]',
        last_error TEXT,
        pid INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 3;
    `);
    db.prepare(
      `INSERT INTO servers (id,name,runtime,transport,status,created_at,updated_at)
       VALUES ('srv_v3','v3','node','stdio','stopped','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
    ).run();

    migrate(db);

    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBe(6);
    expect(columnNames(db, 'servers')).toEqual(expect.arrayContaining(['config_profile_ids']));
    const row = db.prepare('SELECT config_profile_ids FROM servers WHERE id = ?').get('srv_v3') as {
      config_profile_ids: string;
    };
    expect(row.config_profile_ids).toBe('[]');
    db.close();
  });

  it('adds paused_at when upgrading a v5 database', () => {
    const path = tempDbPath();
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_type TEXT NOT NULL CHECK (key_type IN ('agent','dev','sub','sup','master')),
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        server_grants TEXT NOT NULL DEFAULT '[]',
        delegation_allowed INTEGER NOT NULL DEFAULT 0,
        escalation_allowed INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );
      PRAGMA user_version = 5;
    `);
    db.prepare(
      `INSERT INTO api_keys (id,name,key_type,key_hash,key_prefix,created_at)
       VALUES ('key_v5','legacy','agent','deadbeef','mcp_ag_dead','2026-01-01T00:00:00.000Z')`,
    ).run();

    migrate(db);

    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBe(6);
    expect(columnNames(db, 'api_keys')).toEqual(expect.arrayContaining(['paused_at']));
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get('key_v5') as Record<string, unknown>;
    expect(row.name).toBe('legacy');
    expect(row.paused_at).toBeNull();
    db.close();
  });

  it('self-heals a v6-stamped database that is missing api_keys.paused_at', () => {
    const path = tempDbPath();
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_type TEXT NOT NULL CHECK (key_type IN ('agent','dev','sub','sup','master')),
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        server_grants TEXT NOT NULL DEFAULT '[]',
        delegation_allowed INTEGER NOT NULL DEFAULT 0,
        escalation_allowed INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );
      PRAGMA user_version = 6;
    `);
    migrate(db);
    expect(columnNames(db, 'api_keys')).toEqual(expect.arrayContaining(['paused_at']));
    db.close();
  });

  it('is idempotent when run twice', () => {
    const db = openDatabase(tempDbPath());
    expect(() => migrate(db)).not.toThrow();
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });
});
