import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../core/ids.js';
import type { AuditService, AuditQuery, MetricsSnapshot } from '../core/ports.js';
import { parseJson } from '../core/db.js';
import type { AuditEntry, AuditStatus } from '../core/types.js';

const MAX_PAYLOAD_BYTES = 32_768;

export interface AuditServiceOptions {
  /** Live server counts, supplied by the container from the supervisor. */
  serverCounts?: () => { running: number; total: number };
  /** Delegation counters from delegation_traces. */
  delegationCounts?: () => { total: number; approved: number; denied: number };
  startedAt?: number;
}

interface AuditRow {
  id: number;
  ts: string;
  request_id: string | null;
  key_id: string | null;
  method: string;
  server_id: string | null;
  tool_id: string | null;
  status: AuditStatus;
  latency_ms: number;
  error_code: number | null;
  delegation_depth: number;
  parent_id: number | null;
  payload: string | null;
}

export class SqliteAuditService implements AuditService {
  private lastCpu = process.cpuUsage();
  private lastCpuTs = Date.now();
  private cpuPercent = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: AuditServiceOptions = {},
  ) {}

  record(entry: {
    requestId: string | null;
    keyId: string | null;
    method: string;
    serverId?: string | null;
    toolId?: string | null;
    status: AuditStatus;
    latencyMs: number;
    errorCode?: number | null;
    delegationDepth?: number;
    parentId?: number | null;
    payload?: unknown;
  }): number {
    const payload = truncatePayload(entry.payload);
    const result = this.db
      .prepare(
        `INSERT INTO audit_log
          (ts, request_id, key_id, method, server_id, tool_id, status, latency_ms, error_code, delegation_depth, parent_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        nowIso(),
        entry.requestId,
        entry.keyId,
        entry.method,
        entry.serverId ?? null,
        entry.toolId ?? null,
        entry.status,
        Math.max(0, entry.latencyMs),
        entry.errorCode ?? null,
        entry.delegationDepth ?? 0,
        entry.parentId ?? null,
        payload === undefined ? null : JSON.stringify(payload),
      );
    return Number(result.lastInsertRowid);
  }

  query(filter: AuditQuery = {}): { entries: AuditEntry[]; total: number } {
    const where: string[] = [];
    const params: Array<string | number> = [];

    const equals: Array<[keyof AuditQuery, string]> = [
      ['keyId', 'key_id'],
      ['serverId', 'server_id'],
      ['toolId', 'tool_id'],
      ['method', 'method'],
      ['status', 'status'],
    ];
    for (const [key, column] of equals) {
      const value = filter[key];
      if (typeof value === 'string' && value !== '') {
        where.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (filter.search) {
      where.push('(payload LIKE ? OR method LIKE ? OR tool_id LIKE ?)');
      const like = `%${filter.search}%`;
      params.push(like, like, like);
    }
    if (filter.since) {
      where.push('ts >= ?');
      params.push(filter.since);
    }
    if (filter.until) {
      where.push('ts <= ?');
      params.push(filter.until);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);

    const totalRow = this.db.prepare(`SELECT COUNT(*) AS count FROM audit_log ${whereSql}`).get(...params) as
      | { count: number }
      | undefined;
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as AuditRow[];

    return { entries: rows.map(rowToEntry), total: Number(totalRow?.count ?? 0) };
  }

  get(id: number): AuditEntry | null {
    const row = this.db.prepare('SELECT * FROM audit_log WHERE id = ?').get(id) as unknown as AuditRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  metrics(windowMs = 300_000): MetricsSnapshot {
    const since = new Date(Date.now() - windowMs).toISOString();
    const minuteAgo = new Date(Date.now() - 60_000).toISOString();

    const rows = this.db
      .prepare('SELECT status, latency_ms FROM audit_log WHERE ts >= ?')
      .all(since) as unknown as Array<{ status: AuditStatus; latency_ms: number }>;

    let ok = 0;
    let denied = 0;
    let error = 0;
    const latencies: number[] = [];
    for (const row of rows) {
      if (row.status === 'ok') ok += 1;
      else if (row.status === 'denied') denied += 1;
      else error += 1;
      latencies.push(Number(row.latency_ms));
    }
    latencies.sort((a, b) => a - b);

    const minuteRow = this.db.prepare('SELECT COUNT(*) AS count FROM audit_log WHERE ts >= ?').get(minuteAgo) as
      | { count: number }
      | undefined;

    const total = ok + denied + error;
    const delegationCounts = this.options.delegationCounts?.() ?? { total: 0, approved: 0, denied: 0 };
    const servers = this.options.serverCounts?.() ?? { running: 0, total: 0 };

    return {
      uptimeMs: Date.now() - (this.options.startedAt ?? Date.now()),
      requests: { total, ok, denied, error },
      requestsPerMinute: Number(minuteRow?.count ?? 0),
      errorRate: total === 0 ? 0 : Number(((error + denied) / total).toFixed(4)),
      latencyMs: {
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        p99: percentile(latencies, 0.99),
      },
      servers,
      process: {
        cpuPercent: this.sampleCpu(),
        rssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed,
      },
      delegations: delegationCounts,
    };
  }

  private sampleCpu(): number {
    const usage = process.cpuUsage(this.lastCpu);
    const now = Date.now();
    const elapsedMs = Math.max(1, now - this.lastCpuTs);
    this.cpuPercent = Number((((usage.user + usage.system) / 1000 / elapsedMs) * 100).toFixed(1));
    this.lastCpu = process.cpuUsage();
    this.lastCpuTs = now;
    return this.cpuPercent;
  }
}

function rowToEntry(row: AuditRow): AuditEntry {
  return {
    id: Number(row.id),
    ts: row.ts,
    requestId: row.request_id,
    keyId: row.key_id,
    method: row.method,
    serverId: row.server_id,
    toolId: row.tool_id,
    status: row.status,
    latencyMs: Number(row.latency_ms),
    errorCode: row.error_code === null ? null : Number(row.error_code),
    delegationDepth: Number(row.delegation_depth ?? 0),
    parentId: row.parent_id === null ? null : Number(row.parent_id),
    payload: parseJson<unknown>(row.payload, null),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Number(sorted[index]?.toFixed(2) ?? 0);
}

function truncatePayload(payload: unknown): unknown {
  if (payload === undefined) return undefined;
  const json = JSON.stringify(payload);
  if (json === undefined) return undefined;
  if (json.length <= MAX_PAYLOAD_BYTES) return payload;
  return { truncated: true, preview: json.slice(0, MAX_PAYLOAD_BYTES) };
}
