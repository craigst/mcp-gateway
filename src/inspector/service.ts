/**
 * Server inspector (v0.5).
 *
 * Read-only per-server view combining the catalog record, MCP metadata
 * (tools/prompts/resources/capabilities/instructions), the update source,
 * encrypted configuration (masked values + attached profiles + vault refs),
 * and audit-derived usage statistics/keys/activity.
 *
 * The audited `reveal` path is the ONLY way a configuration value leaves the
 * gateway. It is master-only at the API layer, resolves the value from the
 * server record or the AES-256 vault, and records an `admin.reveal` audit entry
 * carrying the principal, server and key metadata — never the value itself.
 */
import type { DatabaseSync } from 'node:sqlite';

import { ErrorCodes, GatewayError, invalidParams } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type { Logger } from '../core/logger.js';
import type {
  AuditQuery,
  AuditService,
  CatalogRepository,
  ConfigProfileService,
  KeyService,
  ServerUpdateService,
  VaultService,
} from '../core/ports.js';
import type {
  AuditStatus,
  AuthenticatedKey,
  ConfigProfileSummary,
  InspectorEnvEntry,
  InspectorProfile,
  InspectorProfileEntry,
  PromptDescriptor,
  ResourceDescriptor,
  ServerActivityPage,
  ServerInspectorOverview,
  ServerKeyUsage,
  ServerRecord,
  ServerSourceInfo,
  ServerUsageStats,
  ToolDescriptor,
} from '../core/types.js';
import { profileEnvSecretName, profileHeaderSecretName } from '../config_profiles/index.js';

/** Env/header names whose values are never returned unmasked by the overview. */
export const SECRET_KEY_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH/i;

const RECENT_ACTIVITY_LIMIT = 20;
const CALL_METHOD = 'tools/call';
const REVEAL_AUDIT_METHOD = 'admin.reveal';

export interface ServerInspectorDeps {
  db: DatabaseSync;
  repository: CatalogRepository;
  keys: KeyService;
  audit: AuditService;
  vault: VaultService;
  configProfiles?: ConfigProfileService;
  updates?: ServerUpdateService;
  logger?: Logger;
}

export type InspectorRevealKind = 'env' | 'header' | 'profile';

export interface InspectorRevealRequest {
  kind: InspectorRevealKind;
  key: string;
  profileId?: string | null;
}

export interface InspectorRevealResult {
  key: string;
  value: string;
}

export interface InspectorActivityFilter {
  status?: AuditStatus;
  toolId?: string;
  keyId?: string;
  limit?: number;
  offset?: number;
}

interface ToolUsageAccumulator {
  toolId: string;
  count: number;
  lastUsedAt: string | null;
  latencyTotal: number;
}

interface KeyUsageAccumulator {
  keyId: string;
  count: number;
  lastUsedAt: string | null;
}

interface AuditStatRow {
  tool_id: string | null;
  key_id: string | null;
  status: AuditStatus;
  latency_ms: number;
  ts: string;
}

function notFound(message: string, details?: unknown): GatewayError {
  return new GatewayError(ErrorCodes.TOOL_NOT_FOUND, message, {
    data: { status: 'NOT_FOUND', details },
    httpStatus: 404,
  });
}

function fieldNotFound(message: string, details?: unknown): GatewayError {
  return new GatewayError(ErrorCodes.TOOL_NOT_FOUND, message, {
    data: { status: 'NOT_FOUND', details },
    httpStatus: 404,
  });
}

/** Nearest-rank percentile over an ascending-sorted numeric array. */
export function percentile(sortedAscending: number[], percent: number): number {
  if (sortedAscending.length === 0) return 0;
  const clamped = Math.min(Math.max(percent, 0), 100);
  const rank = Math.max(1, Math.ceil((clamped / 100) * sortedAscending.length));
  const value = sortedAscending[Math.min(rank - 1, sortedAscending.length - 1)];
  return Number((value ?? 0).toFixed(2));
}

function roundMs(value: number): number {
  return Number(value.toFixed(2));
}

function laterTimestamp(left: string | null, right: string): string | null {
  if (left === null || right > left) return right;
  return left;
}

export class ServerInspectorService {
  private readonly db: DatabaseSync;
  private readonly repository: CatalogRepository;
  private readonly keys: KeyService;
  private readonly audit: AuditService;
  private readonly vault: VaultService;
  private readonly configProfiles: ConfigProfileService | undefined;
  private readonly updates: ServerUpdateService | undefined;
  private readonly logger: Logger;

  constructor(deps: ServerInspectorDeps) {
    this.db = deps.db;
    this.repository = deps.repository;
    this.keys = deps.keys;
    this.audit = deps.audit;
    this.vault = deps.vault;
    this.configProfiles = deps.configProfiles;
    this.updates = deps.updates;
    this.logger = deps.logger ?? createLogger('inspector', 'silent');
  }

  // -------------------------------------------------------------------------
  // Overview
  // -------------------------------------------------------------------------

  overview(serverId: string): ServerInspectorOverview {
    const server = this.requireServer(serverId);
    const source: ServerSourceInfo | null = this.updates?.get(serverId) ?? null;
    const tools: ToolDescriptor[] = this.repository.listToolsByServer(serverId);
    const prompts: PromptDescriptor[] = server.prompts ?? [];
    const resources: ResourceDescriptor[] = server.resources ?? [];
    const stats = this.computeStats(serverId);
    const keysUsed = this.computeKeysUsed(serverId);

    const profiles = this.attachedProfiles(server);
    const config = {
      env: this.configEntries(server.env ?? {}, 'server'),
      headers: this.configEntries(server.headers ?? {}, 'header'),
      profiles: profiles.map((profile) => this.toInspectorProfile(profile)),
      vaultRefs: this.collectVaultRefs(profiles),
    };

    const activity = this.audit.query({ serverId, limit: RECENT_ACTIVITY_LIMIT }).entries;

    return {
      server,
      source,
      tools,
      prompts,
      resources,
      config,
      stats,
      keysUsed,
      activity,
    };
  }

  // -------------------------------------------------------------------------
  // Activity
  // -------------------------------------------------------------------------

  activity(serverId: string, filter: InspectorActivityFilter = {}): ServerActivityPage {
    this.requireServer(serverId);
    const query: AuditQuery = { serverId };
    if (filter.status !== undefined) query.status = filter.status;
    if (filter.toolId !== undefined) query.toolId = filter.toolId;
    if (filter.keyId !== undefined) query.keyId = filter.keyId;
    if (filter.limit !== undefined) query.limit = clampLimit(filter.limit);
    if (filter.offset !== undefined) query.offset = Math.max(0, Math.trunc(filter.offset));

    const page = this.audit.query(query);
    return {
      summary: this.computeStats(serverId),
      entries: page.entries,
      total: page.total,
    };
  }

  // -------------------------------------------------------------------------
  // Audited reveal
  // -------------------------------------------------------------------------

  reveal(
    serverId: string,
    request: InspectorRevealRequest,
    principal: AuthenticatedKey,
  ): InspectorRevealResult {
    const started = performance.now();
    const server = this.requireServer(serverId);
    if (request.kind !== 'env' && request.kind !== 'header' && request.kind !== 'profile') {
      throw invalidParams('"kind" must be one of env, header, profile');
    }
    if (typeof request.key !== 'string' || request.key.trim().length === 0) {
      throw invalidParams('"key" is required');
    }
    const key = request.key.trim();

    let value: string;
    switch (request.kind) {
      case 'env':
        value = this.requireServerValue(server, 'env', key);
        break;
      case 'header':
        value = this.requireServerValue(server, 'header', key);
        break;
      case 'profile': {
        const profileId = typeof request.profileId === 'string' ? request.profileId.trim() : '';
        if (profileId.length === 0) throw invalidParams('"profileId" is required for kind "profile"');
        value = this.revealProfileValue(server, profileId, key);
        break;
      }
      default:
        throw invalidParams('Unsupported reveal kind');
    }

    // Audited: metadata only — the value is never part of the payload/log.
    this.audit.record({
      requestId: null,
      keyId: principal.id,
      method: REVEAL_AUDIT_METHOD,
      serverId,
      toolId: null,
      status: 'ok',
      latencyMs: Math.max(0, performance.now() - started),
      payload: {
        kind: request.kind,
        key,
        profileId: request.kind === 'profile' ? (request.profileId ?? null) : null,
      },
    });
    this.logger.info('configuration value revealed via inspector', {
      serverId,
      principalId: principal.id,
      kind: request.kind,
    });

    return { key, value };
  }

  // -------------------------------------------------------------------------
  // Usage statistics
  // -------------------------------------------------------------------------

  private computeStats(serverId: string): ServerUsageStats {
    const rows = this.db
      .prepare(
        `SELECT tool_id, key_id, status, latency_ms, ts
           FROM audit_log
          WHERE server_id = ? AND method = ?
          ORDER BY id ASC`,
      )
      .all(serverId, CALL_METHOD) as unknown as AuditStatRow[];

    const total = rows.length;
    let ok = 0;
    let error = 0;
    let denied = 0;
    let lastUsedAt: string | null = null;
    let latencyTotal = 0;
    const latencies: number[] = [];
    const distinctKeys = new Set<string>();
    const toolUsage = new Map<string, ToolUsageAccumulator>();

    for (const row of rows) {
      if (row.status === 'ok') ok += 1;
      else if (row.status === 'error') error += 1;
      else if (row.status === 'denied') denied += 1;

      lastUsedAt = laterTimestamp(lastUsedAt, row.ts);
      const latency = Number.isFinite(row.latency_ms) ? Math.max(0, row.latency_ms) : 0;
      latencyTotal += latency;
      latencies.push(latency);
      if (row.key_id !== null && row.key_id !== '') distinctKeys.add(row.key_id);

      if (row.tool_id !== null && row.tool_id !== '') {
        const existing = toolUsage.get(row.tool_id);
        if (existing === undefined) {
          toolUsage.set(row.tool_id, {
            toolId: row.tool_id,
            count: 1,
            lastUsedAt: row.ts,
            latencyTotal: latency,
          });
        } else {
          existing.count += 1;
          existing.latencyTotal += latency;
          existing.lastUsedAt = laterTimestamp(existing.lastUsedAt, row.ts);
        }
      }
    }

    latencies.sort((left, right) => left - right);
    const usage = [...toolUsage.values()]
      .map((entry) => ({
        toolId: entry.toolId,
        name: this.toolName(entry.toolId),
        count: entry.count,
        lastUsedAt: entry.lastUsedAt,
        avgLatencyMs: roundMs(entry.latencyTotal / entry.count),
      }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

    return {
      total,
      ok,
      error,
      denied,
      errorRate: total === 0 ? 0 : Number(((error + denied) / total).toFixed(4)),
      lastUsedAt,
      avgLatencyMs: total === 0 ? 0 : roundMs(latencyTotal / total),
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      distinctKeys: distinctKeys.size,
      toolUsage: usage,
    };
  }

  private computeKeysUsed(serverId: string): ServerKeyUsage[] {
    const rows = this.db
      .prepare(
        `SELECT key_id, ts
           FROM audit_log
          WHERE server_id = ? AND method = ? AND key_id IS NOT NULL AND key_id <> ''
          ORDER BY id ASC`,
      )
      .all(serverId, CALL_METHOD) as unknown as Array<{ key_id: string; ts: string }>;

    const usage = new Map<string, KeyUsageAccumulator>();
    for (const row of rows) {
      const existing = usage.get(row.key_id);
      if (existing === undefined) {
        usage.set(row.key_id, { keyId: row.key_id, count: 1, lastUsedAt: row.ts });
      } else {
        existing.count += 1;
        existing.lastUsedAt = laterTimestamp(existing.lastUsedAt, row.ts);
      }
    }

    return [...usage.values()]
      .map((entry) => {
        const record = this.keys.get(entry.keyId);
        return {
          keyId: entry.keyId,
          keyName: record?.name ?? 'unknown',
          keyPrefix: record?.keyPrefix ?? '',
          keyType: record?.keyType ?? 'unknown',
          count: entry.count,
          lastUsedAt: entry.lastUsedAt,
        };
      })
      .sort((left, right) => right.count - left.count || left.keyId.localeCompare(right.keyId));
  }

  private toolName(toolId: string): string {
    const tool = this.repository.getTool(toolId);
    if (tool !== null) return tool.name;
    const separator = toolId.indexOf(':');
    return separator >= 0 ? toolId.slice(separator + 1) : toolId;
  }

  // -------------------------------------------------------------------------
  // Configuration view
  // -------------------------------------------------------------------------

  private configEntries(
    values: Record<string, string>,
    source: 'server' | 'header',
  ): InspectorEnvEntry[] {
    return Object.entries(values)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => {
        const masked = SECRET_KEY_PATTERN.test(key);
        return {
          key,
          masked,
          value: masked ? null : value,
          source,
        };
      });
  }

  private attachedProfiles(server: ServerRecord): ConfigProfileSummary[] {
    if (this.configProfiles === undefined) return [];
    const attached = new Set(server.configProfileIds ?? []);
    return this.configProfiles
      .list()
      .filter((profile) => attached.has(profile.id) || profile.attachedServerIds.includes(server.id));
  }

  private toInspectorProfile(profile: ConfigProfileSummary): InspectorProfile {
    const mapEntries = (entries: ConfigProfileSummary['entries']): InspectorProfileEntry[] =>
      entries.map((entry) => ({
        key: entry.key,
        source: entry.source,
        ref: entry.ref ?? null,
        ...(entry.source === 'credential-ref'
          ? { provider: entry.provider, itemId: entry.itemId, field: entry.field ?? null }
          : {}),
      }));
    return {
      id: profile.id,
      name: profile.name,
      description: profile.description,
      entries: mapEntries(profile.entries),
      headers: mapEntries(profile.headers),
    };
  }

  private collectVaultRefs(profiles: ConfigProfileSummary[]): string[] {
    const names = new Set<string>();
    for (const profile of profiles) {
      for (const entry of profile.entries) {
        if (entry.source === 'vault-ref') {
          if (entry.ref !== null && entry.ref.length > 0) names.add(entry.ref);
        } else {
          names.add(profileEnvSecretName(profile.id, entry.key));
        }
      }
      for (const entry of profile.headers) {
        if (entry.source === 'vault-ref') {
          if (entry.ref !== null && entry.ref.length > 0) names.add(entry.ref);
        } else {
          names.add(profileHeaderSecretName(profile.id, entry.key));
        }
      }
    }
    return [...names].sort();
  }

  private requireServerValue(server: ServerRecord, kind: 'env' | 'header', key: string): string {
    const values = kind === 'env' ? (server.env ?? {}) : (server.headers ?? {});
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      const label = kind === 'env' ? 'Environment variable' : 'HTTP header';
      throw fieldNotFound(`${label} '${key}' was not found on server '${server.name}'`, {
        serverId: server.id,
        key,
      });
    }
    return values[key] as string;
  }

  private revealProfileValue(server: ServerRecord, profileId: string, key: string): string {
    if (this.configProfiles === undefined) {
      throw new GatewayError(ErrorCodes.NOT_IMPLEMENTED, 'Configuration profiles are not available', {
        httpStatus: 501,
        data: { status: 'NOT_IMPLEMENTED' },
      });
    }
    const profile = this.configProfiles.get(profileId);
    if (profile === null) {
      throw notFound(`Configuration profile '${profileId}' was not found`, { profileId });
    }
    const attached =
      (server.configProfileIds ?? []).includes(profileId) || profile.attachedServerIds.includes(server.id);
    if (!attached) {
      throw invalidParams(
        `Configuration profile '${profileId}' is not attached to server '${server.name}'`,
        { serverId: server.id, profileId },
      );
    }

    const envEntry = profile.entries.find((entry) => entry.key === key);
    if (envEntry !== undefined) {
      return this.resolveProfileSecret(profile, envEntry, 'env');
    }
    const headerEntry = profile.headers.find((entry) => entry.key === key);
    if (headerEntry !== undefined) {
      return this.resolveProfileSecret(profile, headerEntry, 'header');
    }
    throw invalidParams(
      `Configuration key '${key}' was not found in profile '${profileId}'`,
      { profileId, key },
    );
  }

  private resolveProfileSecret(
    profile: ConfigProfileSummary,
    entry: ConfigProfileSummary['entries'][number],
    kind: 'env' | 'header',
  ): string {
    let secretName: string | null;
    if (entry.source === 'vault-ref') {
      if (entry.ref === null || entry.ref.length === 0) {
        throw invalidParams(`Configuration key '${entry.key}' has no vault reference`);
      }
      secretName = entry.ref;
    } else {
      secretName = kind === 'env' ? profileEnvSecretName(profile.id, entry.key) : profileHeaderSecretName(profile.id, entry.key);
    }
    const value = this.vault.getSecret(secretName);
    if (value === null) {
      throw invalidParams(
        `The vault value for configuration key '${entry.key}' was not found`,
        { profileId: profile.id, key: entry.key },
      );
    }
    return value;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private requireServer(serverId: string): ServerRecord {
    const server = this.repository.getServer(serverId);
    if (server === null) {
      throw notFound(`Server '${serverId}' was not found`, { serverId });
    }
    return server;
  }
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return RECENT_ACTIVITY_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), 500);
}
