/**
 * SQLite-backed catalog store for sub-servers and their discovered tools.
 *
 * All SQL lives here (mirrors the schema in `src/core/db.ts`); JSON columns are
 * encoded/decoded at the boundary so the rest of the gateway only sees typed records.
 */
import type { DatabaseSync } from 'node:sqlite';
import { boolToInt, intToBool, parseJson, toJson } from '../core/db.js';
import { invalidParams } from '../core/errors.js';
import { nowIso } from '../core/ids.js';
import type { CatalogRepository } from '../core/ports.js';
import type {
  JsonSchema,
  RuntimeKind,
  ServerManifest,
  ServerRecord,
  PromptDescriptor,
  ResourceDescriptor,
  ServerStatus,
  ToolDescriptor,
  TransportKind,
} from '../core/types.js';

interface ServerRow {
  id: string;
  name: string;
  runtime: string;
  transport: string;
  status: string;
  command: string | null;
  args: string;
  url: string | null;
  env: string;
  headers: string;
  manifest: string | null;
  high_privilege_tools: string;
  delegation_supported: number;
  source_url: string | null;
  work_dir: string | null;
  env_file: string | null;
  approval_required_tools: string;
  config_profile_ids: string;
  capabilities_json: string;
  instructions: string | null;
  prompts_json: string;
  resources_json: string;
  last_error: string | null;
  pid: number | null;
  created_at: string;
  updated_at: string;
}

interface ToolRow {
  id: string;
  server_id: string;
  name: string;
  description: string;
  input_schema: string;
  high_privilege: number;
  tags: string;
  updated_at: string;
}

function mapServerRow(row: ServerRow): ServerRecord {
  return {
    id: row.id,
    name: row.name,
    runtime: row.runtime as RuntimeKind,
    transport: row.transport as TransportKind,
    status: row.status as ServerStatus,
    command: row.command ?? null,
    args: parseJson<string[]>(row.args, []),
    url: row.url ?? null,
    env: parseJson<Record<string, string>>(row.env, {}),
    headers: parseJson<Record<string, string>>(row.headers, {}),
    manifest: parseJson<ServerManifest | null>(row.manifest, null),
    highPrivilegeTools: parseJson<string[]>(row.high_privilege_tools, []),
    delegationSupported: intToBool(row.delegation_supported),
    sourceUrl: row.source_url ?? null,
    workDir: row.work_dir ?? null,
    envFile: row.env_file ?? null,
    approvalRequiredTools: parseJson<string[]>(row.approval_required_tools, []),
    configProfileIds: parseJson<string[]>(row.config_profile_ids, []),
    capabilities: parseJson<Record<string, unknown>>(row.capabilities_json, {}),
    instructions: row.instructions ?? null,
    prompts: parseJson<PromptDescriptor[]>(row.prompts_json, []),
    resources: parseJson<ResourceDescriptor[]>(row.resources_json, []),
    lastError: row.last_error ?? null,
    pid: row.pid ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapToolRow(row: ToolRow): ToolDescriptor {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    serverId: row.server_id,
    inputSchema: parseJson<JsonSchema>(row.input_schema, {}),
    highPrivilege: intToBool(row.high_privilege),
    tags: parseJson<string[]>(row.tags, []),
  };
}

export class SqliteCatalogRepository implements CatalogRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    // The gateway opens the DB with foreign keys enabled; enforce it here too so
    // cascade deletes behave even for an externally supplied connection.
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  upsertServer(server: ServerRecord): void {
    try {
      this.db
        .prepare(
          `INSERT INTO servers
             (id, name, runtime, transport, status, command, args, url, env, headers, manifest,
              high_privilege_tools, delegation_supported, source_url, work_dir, env_file,
              approval_required_tools, config_profile_ids, capabilities_json, instructions,
              prompts_json, resources_json, last_error, pid, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             runtime = excluded.runtime,
             transport = excluded.transport,
             status = excluded.status,
             command = excluded.command,
             args = excluded.args,
             url = excluded.url,
             env = excluded.env,
             headers = excluded.headers,
             manifest = excluded.manifest,
             high_privilege_tools = excluded.high_privilege_tools,
             delegation_supported = excluded.delegation_supported,
             source_url = excluded.source_url,
             work_dir = excluded.work_dir,
             env_file = excluded.env_file,
             approval_required_tools = excluded.approval_required_tools,
             config_profile_ids = excluded.config_profile_ids,
             capabilities_json = excluded.capabilities_json,
             instructions = excluded.instructions,
             prompts_json = excluded.prompts_json,
             resources_json = excluded.resources_json,
             last_error = excluded.last_error,
             pid = excluded.pid,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          server.id,
          server.name,
          server.runtime,
          server.transport,
          server.status,
          server.command ?? null,
          toJson(server.args ?? []),
          server.url ?? null,
          toJson(server.env ?? {}),
          toJson(server.headers ?? {}),
          server.manifest === null ? null : toJson(server.manifest),
          toJson(server.highPrivilegeTools ?? []),
          boolToInt(server.delegationSupported === true),
          server.sourceUrl ?? null,
          server.workDir ?? null,
          server.envFile ?? null,
          toJson(server.approvalRequiredTools ?? []),
          toJson(server.configProfileIds ?? []),
          toJson(server.capabilities ?? {}),
          server.instructions ?? null,
          toJson(server.prompts ?? []),
          toJson(server.resources ?? []),
          server.lastError ?? null,
          server.pid ?? null,
          server.createdAt,
          server.updatedAt,
        );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE constraint failed')) {
        throw invalidParams(`A server named '${server.name}' already exists.`, message);
      }
      throw error;
    }
  }

  getServer(id: string): ServerRecord | null {
    const row = this.db
      .prepare('SELECT * FROM servers WHERE id = ?')
      .get(id) as unknown as ServerRow | undefined;
    return row ? mapServerRow(row) : null;
  }

  getServerByName(name: string): ServerRecord | null {
    const row = this.db
      .prepare('SELECT * FROM servers WHERE name = ?')
      .get(name) as unknown as ServerRow | undefined;
    return row ? mapServerRow(row) : null;
  }

  listServers(): ServerRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM servers ORDER BY name ASC, id ASC')
      .all() as unknown as ServerRow[];
    return rows.map(mapServerRow);
  }

  deleteServer(id: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM tools WHERE server_id = ?').run(id);
      this.db.prepare('DELETE FROM servers WHERE id = ?').run(id);
    });
  }

  setServerStatus(id: string, status: ServerStatus, patch: Partial<ServerRecord> = {}): void {
    const current = this.getServer(id);
    if (!current) throw invalidParams(`Server '${id}' was not found.`);
    const next: ServerRecord = { ...current };
    const target = next as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (key === 'id' || key === 'createdAt' || key === 'updatedAt') continue;
      target[key] = value;
    }
    // status is authoritative and updated_at always advances on a status change.
    next.status = status;
    next.updatedAt = nowIso();
    this.upsertServer(next);
  }

  updateDiscovery(
    serverId: string,
    patch: {
      capabilities?: Record<string, unknown>;
      instructions?: string | null;
      prompts?: ToolDescriptor extends never ? never : import('../core/types.js').PromptDescriptor[];
      resources?: import('../core/types.js').ResourceDescriptor[];
    },
  ): void {
    const current = this.getServer(serverId);
    if (!current) throw invalidParams(`Server '${serverId}' was not found.`);
    this.upsertServer({
      ...current,
      capabilities: patch.capabilities ?? current.capabilities,
      instructions: patch.instructions === undefined ? current.instructions ?? null : patch.instructions,
      prompts: patch.prompts ?? current.prompts ?? [],
      resources: patch.resources ?? current.resources ?? [],
      updatedAt: nowIso(),
    });
  }

  upsertTools(serverId: string, tools: ToolDescriptor[]): void {
    const insert = this.db.prepare(
      `INSERT INTO tools
         (id, server_id, name, description, input_schema, high_privilege, tags, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updatedAt = nowIso();
    this.transaction(() => {
      this.db.prepare('DELETE FROM tools WHERE server_id = ?').run(serverId);
      for (const tool of tools) {
        insert.run(
          tool.id || `${serverId}:${tool.name}`,
          serverId,
          tool.name,
          tool.description ?? '',
          toJson(tool.inputSchema ?? {}),
          boolToInt(tool.highPrivilege === true),
          toJson(tool.tags ?? []),
          updatedAt,
        );
      }
    });
  }

  deleteTools(serverId: string): void {
    this.db.prepare('DELETE FROM tools WHERE server_id = ?').run(serverId);
  }

  getTool(id: string): ToolDescriptor | null {
    const row = this.db
      .prepare('SELECT * FROM tools WHERE id = ?')
      .get(id) as unknown as ToolRow | undefined;
    return row ? mapToolRow(row) : null;
  }

  getToolByName(serverId: string, name: string): ToolDescriptor | null {
    const row = this.db
      .prepare('SELECT * FROM tools WHERE server_id = ? AND name = ?')
      .get(serverId, name) as unknown as ToolRow | undefined;
    return row ? mapToolRow(row) : null;
  }

  listTools(): ToolDescriptor[] {
    const rows = this.db
      .prepare('SELECT * FROM tools ORDER BY server_id ASC, name ASC')
      .all() as unknown as ToolRow[];
    return rows.map(mapToolRow);
  }

  listToolsByServer(serverId: string): ToolDescriptor[] {
    const rows = this.db
      .prepare('SELECT * FROM tools WHERE server_id = ? ORDER BY name ASC')
      .all(serverId) as unknown as ToolRow[];
    return rows.map(mapToolRow);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // A failed rollback must not mask the original error.
      }
      throw error;
    }
  }
}
