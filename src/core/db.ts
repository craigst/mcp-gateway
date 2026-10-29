import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Opens the persistent SQLite database and applies the schema.
 *
 * `node:sqlite` is used deliberately: it is built into Node >= 22.5, so the
 * gateway has no native build step and the Docker image stays small.
 */
export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export const SCHEMA_VERSION = 5;

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
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
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_api_keys_type ON api_keys(key_type);

    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      runtime TEXT NOT NULL CHECK (runtime IN ('node','python','binary','remote-agent')),
      transport TEXT NOT NULL CHECK (transport IN ('stdio','http','sse','websocket')),
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

    CREATE TABLE IF NOT EXISTS tools (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      input_schema TEXT NOT NULL DEFAULT '{}',
      high_privilege INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      UNIQUE (server_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_tools_server ON tools(server_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      request_id TEXT,
      key_id TEXT,
      method TEXT NOT NULL,
      server_id TEXT,
      tool_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('ok','error','denied')),
      latency_ms REAL NOT NULL DEFAULT 0,
      error_code INTEGER,
      delegation_depth INTEGER NOT NULL DEFAULT 0,
      parent_id INTEGER,
      payload TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_key ON audit_log(key_id);
    CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit_log(tool_id);
    CREATE INDEX IF NOT EXISTS idx_audit_parent ON audit_log(parent_id);

    CREATE TABLE IF NOT EXISTS vault_secrets (
      name TEXT PRIMARY KEY,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      key_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS escalations (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL UNIQUE,
      key_id TEXT NOT NULL,
      tool_id TEXT,
      server_id TEXT,
      reason TEXT NOT NULL,
      request_payload TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired')),
      ticket_type TEXT NOT NULL DEFAULT 'scope',
      tool_arguments TEXT,
      result_json TEXT,
      consumed_at TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);

    CREATE TABLE IF NOT EXISTS delegation_traces (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      parent_request_id TEXT,
      child_request_id TEXT,
      target TEXT NOT NULL,
      depth INTEGER NOT NULL,
      status TEXT NOT NULL,
      verdict TEXT,
      latency_ms REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delegation_trace ON delegation_traces(trace_id);

    CREATE TABLE IF NOT EXISTS server_sources (
      server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL DEFAULT 'git',
      catalog_source_id TEXT,
      catalog_entry_id TEXT,
      repo_url TEXT NOT NULL,
      requested_ref TEXT,
      installed_commit TEXT,
      installed_version TEXT,
      latest_commit TEXT,
      latest_version TEXT,
      latest_ref TEXT,
      update_available INTEGER NOT NULL DEFAULT 0,
      checked_at TEXT,
      check_error TEXT,
      changelog_url TEXT
    );

    CREATE TABLE IF NOT EXISTS config_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      env_json TEXT NOT NULL DEFAULT '{}',
      secret_keys_json TEXT NOT NULL DEFAULT '[]',
      headers_json TEXT NOT NULL DEFAULT '{}',
      env_file TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ui_users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ui_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ui_sessions_expiry ON ui_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_ui_sessions_user ON ui_sessions(username);

    CREATE TABLE IF NOT EXISTS catalog_sources (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('dsh-umbrella','github-repo','catalog-json')),
      repo_url TEXT NOT NULL,
      ref TEXT,
      subpath TEXT,
      token_secret_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const current = Number(row?.user_version ?? 0);
  // Column additions are idempotent and run on every open: a database that was
  // stamped with a newer user_version by an earlier binary but is missing a
  // column still heals itself.
  ensureColumn(db, 'servers', 'headers', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'servers', 'env_file', 'TEXT');
  ensureColumn(db, 'servers', 'approval_required_tools', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'servers', 'config_profile_ids', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'servers', 'capabilities_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'servers', 'instructions', 'TEXT');
  ensureColumn(db, 'servers', 'prompts_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'servers', 'resources_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'escalations', 'ticket_type', "TEXT NOT NULL DEFAULT 'scope'");
  ensureColumn(db, 'escalations', 'tool_arguments', 'TEXT');
  ensureColumn(db, 'escalations', 'result_json', 'TEXT');
  ensureColumn(db, 'escalations', 'consumed_at', 'TEXT');
  void current;
  if (current < SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}

/** Adds a column when a pre-existing database predates the current schema. */
function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

export function intToBool(value: unknown): boolean {
  return Number(value) === 1;
}
