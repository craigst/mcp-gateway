import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/core/db.js';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import { createLogger } from '../../src/core/logger.js';
import type { CreateKeyInput, ServerRecord, ToolDescriptor } from '../../src/core/types.js';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';
import { SqliteKeyActivityService } from '../../src/rbac/key-activity.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';
import { SqliteAuditService } from '../../src/gateway/audit.js';

const silent = createLogger('test', 'silent');

let db: DatabaseSync;
let repository: SqliteCatalogRepository;
let keys: SqliteKeyService;
let audit: SqliteAuditService;
let activity: SqliteKeyActivityService;

function makeServer(overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    id: 'srv_alpha',
    name: 'alpha',
    runtime: 'node',
    transport: 'stdio',
    status: 'running',
    command: 'node',
    args: [],
    url: null,
    env: {},
    headers: {},
    manifest: null,
    highPrivilegeTools: ['danger_delete'],
    delegationSupported: false,
    sourceUrl: null,
    workDir: null,
    envFile: null,
    approvalRequiredTools: [],
    lastError: null,
    pid: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTool(serverId: string, name: string, overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    id: `${serverId}:${name}`,
    name,
    description: `${name} description`,
    serverId,
    inputSchema: { type: 'object' },
    highPrivilege: false,
    tags: [],
    ...overrides,
  };
}

function issue(overrides: Partial<CreateKeyInput> = {}) {
  return keys.issue({ name: 'agent', keyType: 'agent', ...overrides });
}

function gatewayError(fn: () => unknown): GatewayError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }
  throw new Error('Expected a GatewayError');
}

beforeEach(() => {
  db = openDatabase(':memory:');
  repository = new SqliteCatalogRepository(db);
  keys = new SqliteKeyService(db, { logger: silent });
  audit = new SqliteAuditService(db);
  activity = new SqliteKeyActivityService({
    db,
    repository,
    keys,
    audit,
    logger: silent,
  });

  repository.upsertServer(
    makeServer({ approvalRequiredTools: ['write_query', 'danger_delete'] }),
  );
  repository.upsertTools('srv_alpha', [
    makeTool('srv_alpha', 'read_query'),
    makeTool('srv_alpha', 'write_query'),
    makeTool('srv_alpha', 'danger_delete', { highPrivilege: true }),
    makeTool('srv_alpha', 'list_tables'),
  ]);
  repository.upsertServer(makeServer({ id: 'srv_beta', name: 'beta', status: 'stopped' }));
  repository.upsertTools('srv_beta', [makeTool('srv_beta', 'ping')]);
});

afterEach(() => {
  db.close();
});

describe('SqliteKeyActivityService.access', () => {
  it('expands grants into tool flags (granted, paused, available, approval, high privilege)', () => {
    const issued = issue({
      serverGrants: [
        {
          serverId: 'srv_alpha',
          tools: ['read_query', 'write_query'],
          highPrivilegeTools: ['danger_delete'],
          pausedTools: ['write_query'],
        },
        { serverId: 'srv_beta', paused: true },
        { serverId: 'srv_missing' },
      ],
    });

    const view = activity.access(issued.key.id);
    expect(view.key.id).toBe(issued.key.id);
    expect(view.key.pausedAt).toBeNull();
    expect(view.key.name).toBe('agent');
    expect(view.grants).toHaveLength(3);

    const alpha = view.grants[0]!;
    expect(alpha).toMatchObject({
      serverId: 'srv_alpha',
      serverName: 'alpha',
      serverStatus: 'running',
      paused: false,
    });
    expect(alpha.tools.map((tool) => tool.name)).toEqual([
      'danger_delete',
      'list_tables',
      'read_query',
      'write_query',
    ]);
    expect(alpha.tools.find((tool) => tool.name === 'read_query')).toEqual({
      name: 'read_query',
      description: 'read_query description',
      highPrivilege: false,
      approvalRequired: false,
      granted: true,
      paused: false,
      available: true,
    });
    expect(alpha.tools.find((tool) => tool.name === 'write_query')).toMatchObject({
      granted: true,
      paused: true,
      approvalRequired: true,
    });
    expect(alpha.tools.find((tool) => tool.name === 'danger_delete')).toMatchObject({
      highPrivilege: true,
      granted: true,
      approvalRequired: true,
      paused: false,
    });
    // list_tables is not in the whitelist, so it is visible but not granted.
    expect(alpha.tools.find((tool) => tool.name === 'list_tables')).toMatchObject({
      granted: false,
      paused: false,
    });

    const beta = view.grants[1]!;
    expect(beta).toMatchObject({
      serverId: 'srv_beta',
      serverName: 'beta',
      serverStatus: 'stopped',
      paused: true,
    });
    expect(beta.tools[0]).toMatchObject({ name: 'ping', granted: true, paused: true, available: false });

    const missing = view.grants[2]!;
    expect(missing).toEqual({
      serverId: 'srv_missing',
      serverName: '(deleted)',
      serverStatus: 'missing',
      paused: false,
      tools: [],
    });
  });

  it('treats an omitted tool whitelist as all non-high-privilege tools', () => {
    const issued = issue({ serverGrants: [{ serverId: 'srv_alpha', pausedTools: ['read_query'] }] });
    const alpha = activity.access(issued.key.id).grants[0]!;
    expect(alpha.tools.find((tool) => tool.name === 'read_query')).toMatchObject({
      granted: true,
      paused: true,
    });
    expect(alpha.tools.find((tool) => tool.name === 'list_tables')).toMatchObject({
      granted: true,
      paused: false,
    });
    expect(alpha.tools.find((tool) => tool.name === 'danger_delete')).toMatchObject({
      highPrivilege: true,
      granted: false,
    });
  });

  it('reflects a paused key in the summary', () => {
    const issued = issue();
    keys.pause(issued.key.id);
    expect(activity.access(issued.key.id).key.pausedAt).not.toBeNull();
  });

  it('throws TOOL_NOT_FOUND for unknown keys', () => {
    const error = gatewayError(() => activity.access('key_missing'));
    expect(error.code).toBe(ErrorCodes.TOOL_NOT_FOUND);
    expect(error.httpStatus).toBe(404);
  });
});

describe('SqliteKeyActivityService.activity', () => {
  /** Insert audit rows (newest last) with deterministic timestamps. */
  function seedAudit(keyId: string): void {
    const rows = [
      { method: 'tools/call', serverId: 'srv_alpha', toolId: 'srv_alpha:read_query', status: 'ok' as const, latencyMs: 10, errorCode: null, ts: '2026-01-01T00:00:01.000Z' },
      { method: 'tools/call', serverId: 'srv_alpha', toolId: 'srv_alpha:read_query', status: 'ok' as const, latencyMs: 20, errorCode: null, ts: '2026-01-01T00:00:02.000Z' },
      { method: 'tools/call', serverId: 'srv_alpha', toolId: 'srv_alpha:danger_delete', status: 'denied' as const, latencyMs: 5, errorCode: -32001, ts: '2026-01-01T00:00:03.000Z' },
      { method: 'tools/list', serverId: 'srv_beta', toolId: null, status: 'ok' as const, latencyMs: 8, errorCode: null, ts: '2026-01-01T00:00:04.000Z' },
      { method: 'prompts/get', serverId: 'srv_missing', toolId: null, status: 'error' as const, latencyMs: 30, errorCode: -32007, ts: '2026-01-01T00:00:05.000Z' },
    ];
    for (const row of rows) {
      const id = audit.record({
        requestId: `req_${row.ts}`,
        keyId,
        method: row.method,
        serverId: row.serverId,
        toolId: row.toolId,
        status: row.status,
        latencyMs: row.latencyMs,
        errorCode: row.errorCode,
      });
      db.prepare('UPDATE audit_log SET ts = ? WHERE id = ?').run(row.ts, id);
    }
  }

  it('returns the key summary, aggregated stats and a newest-first page', () => {
    const issued = issue();
    seedAudit(issued.key.id);
    // Audit rows for a different key must not leak into stats.
    audit.record({ requestId: null, keyId: 'key_other', method: 'tools/call', status: 'ok', latencyMs: 100 });

    const page = activity.activity(issued.key.id);
    expect(page.key.id).toBe(issued.key.id);
    expect(page.total).toBe(5);
    expect(page.entries).toHaveLength(5);
    expect(page.entries.map((entry) => entry.ts)).toEqual([
      '2026-01-01T00:00:05.000Z',
      '2026-01-01T00:00:04.000Z',
      '2026-01-01T00:00:03.000Z',
      '2026-01-01T00:00:02.000Z',
      '2026-01-01T00:00:01.000Z',
    ]);

    expect(page.stats).toEqual({
      total: 5,
      ok: 3,
      error: 1,
      denied: 1,
      lastUsedAt: '2026-01-01T00:00:05.000Z',
      avgLatencyMs: 14.6,
      p50LatencyMs: 10,
      p95LatencyMs: 30,
      distinctServers: 3,
      distinctTools: 2,
      serverUsage: [
        { serverId: 'srv_alpha', name: 'alpha', count: 3 },
        { serverId: 'srv_beta', name: 'beta', count: 1 },
        { serverId: 'srv_missing', name: '(deleted)', count: 1 },
      ],
      toolUsage: [
        {
          toolId: 'srv_alpha:read_query',
          name: 'read_query',
          count: 2,
          lastUsedAt: '2026-01-01T00:00:02.000Z',
        },
        {
          toolId: 'srv_alpha:danger_delete',
          name: 'danger_delete',
          count: 1,
          lastUsedAt: '2026-01-01T00:00:03.000Z',
        },
      ],
    });
  });

  it('filters by status, server and tool while keeping total = matched count', () => {
    const issued = issue();
    seedAudit(issued.key.id);

    const denied = activity.activity(issued.key.id, { status: 'denied' });
    expect(denied.total).toBe(1);
    expect(denied.entries[0]?.status).toBe('denied');
    // Stats always describe the whole key, not just the filtered page.
    expect(denied.stats.total).toBe(5);

    expect(activity.activity(issued.key.id, { serverId: 'srv_alpha' }).total).toBe(3);
    expect(activity.activity(issued.key.id, { toolId: 'srv_alpha:read_query' }).total).toBe(2);
    expect(
      activity.activity(issued.key.id, { serverId: 'srv_alpha', status: 'denied' }).total,
    ).toBe(1);
  });

  it('paginates newest-first over the filtered set', () => {
    const issued = issue();
    seedAudit(issued.key.id);

    const page = activity.activity(issued.key.id, { limit: 2, offset: 1 });
    expect(page.total).toBe(5);
    expect(page.entries.map((entry) => entry.ts)).toEqual([
      '2026-01-01T00:00:04.000Z',
      '2026-01-01T00:00:03.000Z',
    ]);

    const clamped = activity.activity(issued.key.id, { limit: 0, offset: -5 });
    expect(clamped.entries).toHaveLength(1);
  });

  it('reports zeroed stats when a key has no audit rows', () => {
    const issued = issue();
    const page = activity.activity(issued.key.id);
    expect(page.total).toBe(0);
    expect(page.entries).toEqual([]);
    expect(page.stats).toMatchObject({
      total: 0,
      ok: 0,
      error: 0,
      denied: 0,
      avgLatencyMs: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      distinctServers: 0,
      distinctTools: 0,
      serverUsage: [],
      toolUsage: [],
    });
  });

  it('validates the filter and unknown keys', () => {
    const issued = issue();
    expect(
      gatewayError(() =>
        activity.activity(issued.key.id, { status: 'weird' as never }),
      ).code,
    ).toBe(ErrorCodes.INVALID_PARAMS);
    expect(
      gatewayError(() => activity.activity(issued.key.id, { limit: Number.NaN })).code,
    ).toBe(ErrorCodes.INVALID_PARAMS);
    expect(
      gatewayError(() => activity.activity(issued.key.id, { offset: Number.POSITIVE_INFINITY })).code,
    ).toBe(ErrorCodes.INVALID_PARAMS);
    expect(
      gatewayError(() => activity.activity(issued.key.id, { serverId: '   ' })).code,
    ).toBe(ErrorCodes.INVALID_PARAMS);

    const missing = gatewayError(() => activity.activity('key_missing'));
    expect(missing.code).toBe(ErrorCodes.TOOL_NOT_FOUND);
  });
});
