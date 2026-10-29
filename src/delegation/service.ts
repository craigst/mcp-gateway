/**
 * Delegation service (spec §7–§8, Phase 4).
 *
 * Responsibilities:
 *  - delegation-claim enforcement (RBAC check is repeated here so the service is
 *    safe regardless of the caller);
 *  - recursion depth limiting (`X-MCP-Delegation-Depth`, hard cap from config);
 *  - isolated payload forwarding through {@link HttpObserverProxy} — the caller's
 *    key, grants and conversation are never part of the envelope;
 *  - bearer-token resolution from the encrypted vault (never persisted or logged);
 *  - parent → child trace persistence in `delegation_traces`.
 */
import type { DatabaseSync } from 'node:sqlite';

import type { GatewayConfig } from '../core/config.js';
import { ErrorCodes, GatewayError, accessDenied, invalidParams } from '../core/errors.js';
import { newId, newTraceId, nowIso } from '../core/ids.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { DelegationService, DelegationTrace, VaultService } from '../core/ports.js';
import type {
  AuthenticatedKey,
  DelegationResult,
  DelegationTarget,
} from '../core/types.js';

import { HttpObserverProxy, type ObserverCallResult } from './proxy.js';
import { observerToolResult } from './observer.js';

const DEFAULT_TARGET_TIMEOUT_MS = 30_000;
const DEFAULT_TRACE_LIMIT = 100;
const MAX_TRACE_LIMIT = 1_000;

export interface DelegationServiceDeps {
  db: DatabaseSync;
  config: GatewayConfig;
  vault?: VaultService;
  targets?: DelegationTarget[];
  proxy?: HttpObserverProxy;
  logger?: Logger;
}

interface DelegationTraceRow {
  id: string;
  trace_id: string;
  parent_request_id: string | null;
  child_request_id: string | null;
  target: string;
  depth: number;
  status: string;
  verdict: string | null;
  latency_ms: number;
  created_at: string;
}

interface PersistedTrace {
  id: string;
  traceId: string;
  parentRequestId: string | null;
  target: string;
  depth: number;
  status: 'approved' | 'denied' | 'error';
  verdict: string | null;
  latencyMs: number;
  createdAt: string;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Round to sub-millisecond precision; keeps SQLite REAL / JSON output tidy. */
function elapsedMs(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(3));
}

function mapTraceRow(row: DelegationTraceRow): DelegationTrace {
  return {
    id: String(row.id),
    traceId: String(row.trace_id),
    parentRequestId: row.parent_request_id === null ? null : String(row.parent_request_id),
    childRequestId: row.child_request_id === null ? null : String(row.child_request_id),
    target: String(row.target),
    depth: Number(row.depth),
    status: row.status as DelegationTrace['status'],
    verdict: row.verdict === null ? null : String(row.verdict),
    latencyMs: Number(row.latency_ms),
    createdAt: String(row.created_at),
  };
}

export class DefaultDelegationService implements DelegationService {
  private readonly db: DatabaseSync;
  private readonly config: GatewayConfig;
  private readonly vault: VaultService | undefined;
  private readonly proxy: HttpObserverProxy;
  private readonly logger: Logger;
  private readonly targets = new Map<string, DelegationTarget>();

  constructor(deps: DelegationServiceDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.vault = deps.vault;
    this.logger = deps.logger ?? createLogger('delegation.service', deps.config.logLevel);
    this.proxy = deps.proxy ?? new HttpObserverProxy({ logger: this.logger });

    for (const target of deps.targets ?? []) {
      const normalized = this.normalizeTarget(target);
      if (this.targets.has(normalized.id)) {
        throw invalidParams(`Delegation target '${normalized.id}' already exists.`);
      }
      this.targets.set(normalized.id, normalized);
    }
  }

  listTargets(): DelegationTarget[] {
    return [...this.targets.values()].map((target) => ({ ...target }));
  }

  addTarget(target: DelegationTarget): DelegationTarget {
    const normalized = this.normalizeTarget(target);
    if (this.targets.has(normalized.id)) {
      throw invalidParams(`Delegation target '${normalized.id}' already exists.`);
    }
    this.targets.set(normalized.id, normalized);
    this.logger.info('delegation target registered', {
      target: normalized.id,
      protocol: normalized.protocol,
      auth: Boolean(normalized.authSecretName),
    });
    return { ...normalized };
  }

  async delegate(
    key: AuthenticatedKey,
    input: { targetId: string; payload: unknown; mode?: 'delegate' | 'observe_and_verify' },
    context: { depth: number; parentRequestId: string },
  ): Promise<DelegationResult> {
    // 1. Delegation claim is mandatory — checked before anything else is resolved.
    if (!key || key.delegationAllowed !== true) {
      throw accessDenied('Access Denied: key lacks delegation claim.', {
        reason: 'DELEGATION_NOT_PERMITTED',
      });
    }

    // 2. Recursion guard applies to the child depth.
    const nextDepth = context.depth + 1;
    const maxDepth = this.config.delegationMaxDepth;
    if (nextDepth > maxDepth) {
      this.logger.warn('delegation depth exceeded', {
        target: input.targetId,
        nextDepth,
        maxDepth,
      });
      throw new GatewayError(
        ErrorCodes.DELEGATION_DEPTH_EXCEEDED,
        `Maximum delegation depth of ${maxDepth} exceeded.`,
        { data: { status: 'FORBIDDEN', reason: 'DELEGATION_DEPTH_EXCEEDED' } },
      );
    }

    // 3. Target lookup — never echo URLs in the error (no endpoint probing).
    const target = this.targets.get(input.targetId);
    if (!target) {
      const available = [...this.targets.keys()];
      this.logger.warn('unknown delegation target', { target: input.targetId });
      throw invalidParams(
        `Unknown delegation target '${input.targetId}'. Available targets: ${
          available.length > 0 ? available.join(', ') : '(none)'
        }.`,
        { available },
      );
    }

    // 4. Resolve the observer bearer token from the vault (if the target needs one).
    const authToken = this.resolveAuthToken(target);

    // 5. Call the observer. Only the isolated payload envelope crosses the boundary.
    const mode = input.mode ?? 'delegate';
    const traceId = newTraceId();
    const parentRequestId = context.parentRequestId;
    const startedAt = performance.now();

    let observerResult: ObserverCallResult;
    try {
      observerResult = await this.proxy.call(
        target,
        {
          mode,
          payload: input.payload,
          depth: nextDepth,
          traceId,
          parentRequestId,
        },
        authToken,
      );
    } catch (error) {
      const latencyMs = elapsedMs(startedAt);
      // Persist a failed attempt for the parent → child audit lineage, then rethrow.
      this.persistTrace({
        id: newId('trc'),
        traceId,
        parentRequestId,
        target: target.id,
        depth: nextDepth,
        status: 'error',
        verdict: null,
        latencyMs,
        createdAt: nowIso(),
      });
      throw error;
    }

    const latencyMs = elapsedMs(startedAt);
    this.persistTrace({
      id: newId('trc'),
      traceId,
      parentRequestId,
      target: target.id,
      depth: nextDepth,
      status: observerResult.status,
      verdict: observerResult.verdict,
      latencyMs,
      createdAt: nowIso(),
    });

    this.logger.info('delegation completed', {
      target: target.id,
      status: observerResult.status,
      depth: nextDepth,
      traceId,
      latencyMs,
      mode,
    });

    return observerToolResult(observerResult, {
      targetId: target.id,
      depth: nextDepth,
      traceId,
      latencyMs,
    });
  }

  listTraces(limit: number = DEFAULT_TRACE_LIMIT): DelegationTrace[] {
    const safeLimit =
      Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_TRACE_LIMIT) : DEFAULT_TRACE_LIMIT;

    const rows = this.db
      .prepare(
        `SELECT id, trace_id, parent_request_id, child_request_id, target, depth, status, verdict,
                latency_ms, created_at
           FROM delegation_traces
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?`,
      )
      .all(safeLimit) as unknown as DelegationTraceRow[];

    return rows.map(mapTraceRow);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private normalizeTarget(raw: DelegationTarget): DelegationTarget {
    const candidate = (raw ?? {}) as Partial<DelegationTarget>;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    if (id.length === 0) {
      throw invalidParams('Delegation target id must be a non-empty string.');
    }

    const url = typeof candidate.url === 'string' ? candidate.url.trim() : '';
    if (!isHttpUrl(url)) {
      throw invalidParams(`Delegation target '${id}' must have a valid http(s) URL.`);
    }

    const rawTimeout = candidate.timeoutMs as number | undefined;
    const timeoutMs = rawTimeout === undefined || rawTimeout === null ? DEFAULT_TARGET_TIMEOUT_MS : rawTimeout;
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw invalidParams(`Delegation target '${id}' must have a positive timeoutMs.`);
    }

    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const protocol = candidate.protocol === 'mcp' ? 'mcp' : 'http';
    const authSecretName =
      typeof candidate.authSecretName === 'string' && candidate.authSecretName.trim().length > 0
        ? candidate.authSecretName.trim()
        : null;

    return {
      id,
      name: name.length > 0 ? name : id,
      url,
      protocol,
      authSecretName,
      timeoutMs,
    };
  }

  private resolveAuthToken(target: DelegationTarget): string | null {
    const secretName = target.authSecretName;
    if (!secretName) return null;
    if (!this.vault?.isEnabled()) return null;

    const token = this.vault.getSecret(secretName);
    if (!token) {
      throw invalidParams(
        `Delegation target '${target.id}' is missing vault secret '${secretName}'.`,
        { targetId: target.id, secret: secretName },
      );
    }
    return token;
  }

  private persistTrace(trace: PersistedTrace): void {
    this.db
      .prepare(
        `INSERT INTO delegation_traces
           (id, trace_id, parent_request_id, child_request_id, target, depth, status, verdict, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trace.id,
        trace.traceId,
        trace.parentRequestId,
        null,
        trace.target,
        trace.depth,
        trace.status,
        trace.verdict,
        trace.latencyMs,
        trace.createdAt,
      );
  }
}
