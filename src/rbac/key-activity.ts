/**
 * Per-key access view + activity feed (v0.8).
 *
 * `access()` powers the RBAC editor: it expands a key's server grants into the
 * concrete tool list with granted/high-privilege/approval/paused/available flags.
 * `activity()` powers the key detail drawer: a paginated audit feed plus usage
 * statistics aggregated over every audit row recorded for that key.
 *
 * Stats are aggregated over ALL methods (not just `tools/call`) so the console can
 * show discovery/denial traffic too; latency percentiles are computed locally from
 * the recorded `latency_ms` values (SQLite has no percentile function).
 */
import type { DatabaseSync } from 'node:sqlite';

import { ErrorCodes, GatewayError, invalidParams } from '../core/errors.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { AuditService, CatalogRepository, KeyActivityService, KeyService } from '../core/ports.js';
import type {
  ApiKeyRecord,
  AuditStatus,
  KeyAccessView,
  KeyActivityFilter,
  KeyActivityPage,
  KeyGrantToolView,
  KeyGrantView,
  KeySummary,
  KeyUsageStats,
  ServerGrant,
  ToolDescriptor,
} from '../core/types.js';

export interface KeyActivityServiceDeps {
  db: DatabaseSync;
  repository: CatalogRepository;
  keys: KeyService;
  audit: AuditService;
  logger?: Logger;
}

const DEFAULT_ACTIVITY_LIMIT = 50;
const MAX_ACTIVITY_LIMIT = 500;
const AUDIT_STATUSES: readonly AuditStatus[] = ['ok', 'error', 'denied'];

function keyNotFound(id: string): GatewayError {
  return new GatewayError(ErrorCodes.TOOL_NOT_FOUND, `API key '${id}' was not found`, {
    httpStatus: 404,
  });
}

function namesTool(identifiers: string[] | null | undefined, tool: ToolDescriptor): boolean {
  if (!Array.isArray(identifiers)) return false;
  return identifiers.includes(tool.name) || identifiers.includes(tool.id);
}

function toKeySummary(record: ApiKeyRecord): KeySummary {
  return {
    id: record.id,
    name: record.name,
    keyType: record.keyType,
    keyPrefix: record.keyPrefix,
    serverGrants: record.serverGrants,
    delegationAllowed: record.delegationAllowed,
    escalationAllowed: record.escalationAllowed,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    pausedAt: record.pausedAt,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
  };
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

/** Nearest-rank percentile over an ascending list (0 when empty). */
function percentile(ascending: number[], p: number): number {
  if (ascending.length === 0) return 0;
  const rank = Math.ceil((p / 100) * ascending.length);
  const index = Math.min(ascending.length - 1, Math.max(0, rank - 1));
  return round(ascending[index] as number);
}

interface UsageRow {
  server_id: string;
  count: number;
}

interface ToolUsageRow {
  tool_id: string;
  count: number;
  last_ts: string | null;
}

export class SqliteKeyActivityService implements KeyActivityService {
  private readonly db: DatabaseSync;
  private readonly repository: CatalogRepository;
  private readonly keys: KeyService;
  private readonly audit: AuditService;
  private readonly logger: Logger;

  constructor(deps: KeyActivityServiceDeps) {
    this.db = deps.db;
    this.repository = deps.repository;
    this.keys = deps.keys;
    this.audit = deps.audit;
    this.logger = deps.logger ?? createLogger('rbac.key-activity');
  }

  access(keyId: string): KeyAccessView {
    const record = this.keys.get(keyId);
    if (!record) throw keyNotFound(keyId);
    return {
      key: toKeySummary(record),
      grants: record.serverGrants.map((grant) => this.buildGrantView(grant)),
    };
  }

  activity(keyId: string, filter: KeyActivityFilter = {}): KeyActivityPage {
    const record = this.keys.get(keyId);
    if (!record) throw keyNotFound(keyId);
    const normalized = this.normalizeFilter(filter);

    const page = this.audit.query({
      keyId,
      ...(normalized.status === undefined ? {} : { status: normalized.status }),
      ...(normalized.serverId === undefined ? {} : { serverId: normalized.serverId }),
      ...(normalized.toolId === undefined ? {} : { toolId: normalized.toolId }),
      limit: normalized.limit,
      offset: normalized.offset,
    });

    return {
      key: toKeySummary(record),
      stats: this.buildStats(record),
      entries: page.entries,
      total: page.total,
    };
  }

  // -------------------------------------------------------------------------
  // Access view
  // -------------------------------------------------------------------------

  private buildGrantView(grant: ServerGrant): KeyGrantView {
    const server = this.repository.getServer(grant.serverId);
    const paused = grant.paused === true;
    const pausedTools = Array.isArray(grant.pausedTools) ? grant.pausedTools : [];
    const approvalRequiredTools = server?.approvalRequiredTools ?? [];
    const available = server !== null && server.status === 'running';

    const tools: KeyGrantToolView[] = server
      ? this.repository.listToolsByServer(server.id).map((tool) => {
          const granted = tool.highPrivilege
            ? namesTool(grant.highPrivilegeTools, tool)
            : grant.tools === undefined || grant.tools === null
              ? true
              : namesTool(grant.tools, tool);
          return {
            name: tool.name,
            description: tool.description,
            highPrivilege: tool.highPrivilege,
            approvalRequired: approvalRequiredTools.includes(tool.name),
            granted,
            paused: paused || namesTool(pausedTools, tool),
            available,
          };
        })
      : [];

    tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    return {
      serverId: grant.serverId,
      serverName: server?.name ?? '(deleted)',
      serverStatus: server?.status ?? 'missing',
      paused,
      tools,
    };
  }

  // -------------------------------------------------------------------------
  // Activity + stats
  // -------------------------------------------------------------------------

  private normalizeFilter(filter: KeyActivityFilter): {
    status?: AuditStatus;
    serverId?: string;
    toolId?: string;
    limit: number;
    offset: number;
  } {
    if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
      throw invalidParams('Activity filter must be an object.');
    }
    let status: AuditStatus | undefined;
    if (filter.status !== undefined) {
      if (!(AUDIT_STATUSES as readonly string[]).includes(filter.status)) {
        throw invalidParams('status must be one of ok, error or denied.');
      }
      status = filter.status;
    }
    const optionalId = (value: unknown, field: string): string | undefined => {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== 'string' || value.trim() === '') {
        throw invalidParams(`${field} must be a non-empty string.`);
      }
      return value.trim();
    };
    const serverId = optionalId(filter.serverId, 'serverId');
    const toolId = optionalId(filter.toolId, 'toolId');

    let limit = DEFAULT_ACTIVITY_LIMIT;
    if (filter.limit !== undefined) {
      if (typeof filter.limit !== 'number' || !Number.isFinite(filter.limit)) {
        throw invalidParams('limit must be a finite number.');
      }
      limit = Math.min(Math.max(Math.trunc(filter.limit), 1), MAX_ACTIVITY_LIMIT);
    }
    let offset = 0;
    if (filter.offset !== undefined) {
      if (typeof filter.offset !== 'number' || !Number.isFinite(filter.offset)) {
        throw invalidParams('offset must be a finite number.');
      }
      offset = Math.max(0, Math.trunc(filter.offset));
    }

    return { ...(status === undefined ? {} : { status }), ...(serverId === undefined ? {} : { serverId }), ...(toolId === undefined ? {} : { toolId }), limit, offset };
  }

  private buildStats(record: ApiKeyRecord): KeyUsageStats {
    const keyId = record.id;

    const aggregate = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END), 0) AS ok,
                COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error,
                COALESCE(SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END), 0) AS denied,
                MAX(ts) AS last_ts,
                COALESCE(AVG(latency_ms), 0) AS avg_latency
           FROM audit_log
          WHERE key_id = ?`,
      )
      .get(keyId) as unknown as
      | { total: number; ok: number; error: number; denied: number; last_ts: string | null; avg_latency: number }
      | undefined;

    const latencyRows = this.db
      .prepare('SELECT latency_ms FROM audit_log WHERE key_id = ? ORDER BY latency_ms ASC')
      .all(keyId) as unknown as Array<{ latency_ms: number }>;
    const latencies = latencyRows.map((row) => Number(row.latency_ms));

    const distinctServersRow = this.db
      .prepare(
        `SELECT COUNT(DISTINCT server_id) AS count FROM audit_log
          WHERE key_id = ? AND server_id IS NOT NULL AND server_id != ''`,
      )
      .get(keyId) as unknown as { count?: number } | undefined;
    const distinctToolsRow = this.db
      .prepare(
        `SELECT COUNT(DISTINCT tool_id) AS count FROM audit_log
          WHERE key_id = ? AND tool_id IS NOT NULL AND tool_id != ''`,
      )
      .get(keyId) as unknown as { count?: number } | undefined;

    const usageRows = this.db
      .prepare(
        `SELECT server_id, COUNT(*) AS count FROM audit_log
          WHERE key_id = ? AND server_id IS NOT NULL AND server_id != ''
          GROUP BY server_id
          ORDER BY count DESC, server_id ASC`,
      )
      .all(keyId) as unknown as UsageRow[];
    const serversById = new Map(this.repository.listServers().map((server) => [server.id, server]));

    const toolUsageRows = this.db
      .prepare(
        `SELECT tool_id, COUNT(*) AS count, MAX(ts) AS last_ts FROM audit_log
          WHERE key_id = ? AND tool_id IS NOT NULL AND tool_id != ''
          GROUP BY tool_id
          ORDER BY count DESC, tool_id ASC`,
      )
      .all(keyId) as unknown as ToolUsageRow[];

    const total = Number(aggregate?.total ?? 0);
    return {
      total,
      ok: Number(aggregate?.ok ?? 0),
      error: Number(aggregate?.error ?? 0),
      denied: Number(aggregate?.denied ?? 0),
      lastUsedAt: aggregate?.last_ts ?? record.lastUsedAt ?? null,
      avgLatencyMs: round(Number(aggregate?.avg_latency ?? 0)),
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      distinctServers: Number(distinctServersRow?.count ?? 0),
      distinctTools: Number(distinctToolsRow?.count ?? 0),
      serverUsage: usageRows.map((row) => ({
        serverId: row.server_id,
        name: serversById.get(row.server_id)?.name ?? '(deleted)',
        count: Number(row.count),
      })),
      toolUsage: toolUsageRows.map((row) => ({
        toolId: row.tool_id,
        name: this.toolDisplayName(row.tool_id),
        count: Number(row.count),
        lastUsedAt: row.last_ts ?? null,
      })),
    };
  }

  private toolDisplayName(toolId: string): string {
    const tool = this.repository.getTool(toolId);
    if (tool) return tool.name;
    // Fall back to the `${serverId}:${name}` convention for deleted/discovered tools.
    const separator = toolId.indexOf(':');
    return separator >= 0 && separator < toolId.length - 1 ? toolId.slice(separator + 1) : toolId;
  }
}
