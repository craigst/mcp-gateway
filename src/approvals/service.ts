/**
 * Tool-approval gating (v0.2).
 *
 * Dangerous tools (Vaultwarden credential delivery/rotation, …) are listed in a
 * server's `approvalRequiredTools`. When an agent calls one of them the gateway
 * captures the exact call in an `escalations` row with `ticket_type =
 * 'tool_approval'` and returns `ESCALATION_REQUIRED` with the ticket id.
 *
 * A supervisor approves the ticket in the UI. Approving executes the stored
 * call **exactly once** through the supervisor and stores the MCP result.
 * The agent then retries the same `tools/call` with the ticket; the stored
 * result is handed back once (the ticket is atomically consumed) and never
 * contains a raw secret — Vaultwarden tools return a short-lived file path.
 */
import type { DatabaseSync } from 'node:sqlite';
import { parseJson, toJson } from '../core/db.js';
import { invalidParams } from '../core/errors.js';
import { newEscalationTicketId, newId, nowIso } from '../core/ids.js';
import { createLogger, type Logger } from '../core/logger.js';
import type {
  ApprovalResult,
  ApprovalService,
  CatalogRepository,
  Supervisor,
} from '../core/ports.js';
import type {
  AuthenticatedKey,
  EscalationStatus,
  EscalationTicket,
  EscalationTicketType,
} from '../core/types.js';

const DEFAULT_TIMEOUT_MS = 60_000;

/** Escalations row including the schema-v2 tool-approval columns. */
export interface EscalationRow {
  id: string;
  ticket_id: string;
  key_id: string;
  tool_id: string | null;
  server_id: string | null;
  reason: string;
  request_payload: string | null;
  status: string;
  ticket_type: string | null;
  tool_arguments: string | null;
  result_json: string | null;
  consumed_at: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  note: string | null;
}

export interface ApprovalServiceDeps {
  db: DatabaseSync;
  repository: CatalogRepository;
  supervisor: Supervisor;
  logger?: Logger;
  /** Timeout for executing the stored call after approval (default 60s). */
  timeoutMs?: number;
}

/**
 * Maps an `escalations` row (v1 or v2 shape) onto the public ticket contract.
 * Exported so the admin Vault Warden endpoint can list pending approvals with
 * exactly the same field semantics as the runtime gate.
 */
export function mapEscalationRow(row: EscalationRow): EscalationTicket {
  const ticketType = (row.ticket_type ?? 'scope') as EscalationTicketType;
  return {
    id: row.id,
    ticketId: row.ticket_id,
    keyId: row.key_id,
    toolId: row.tool_id ?? null,
    serverId: row.server_id ?? null,
    reason: row.reason,
    requestPayload: parseJson<unknown>(row.request_payload, null),
    status: row.status as EscalationStatus,
    ticketType,
    toolArguments: parseJson<unknown>(row.tool_arguments, null),
    result: parseJson<unknown>(row.result_json, undefined),
    consumedAt: row.consumed_at ?? null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? null,
    resolvedBy: row.resolved_by ?? null,
    note: row.note ?? null,
  };
}

export class SqliteApprovalService implements ApprovalService {
  private readonly db: DatabaseSync;
  private readonly repository: CatalogRepository;
  private readonly supervisor: Supervisor;
  private readonly logger: Logger;
  private readonly timeoutMs: number;

  constructor(deps: ApprovalServiceDeps) {
    this.db = deps.db;
    this.repository = deps.repository;
    this.supervisor = deps.supervisor;
    this.logger = deps.logger ?? createLogger('approvals');
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  requiresApproval(serverId: string, toolName: string): boolean {
    const server = this.repository.getServer(serverId);
    if (!server) return false;
    const required = server.approvalRequiredTools ?? [];
    return required.includes(toolName) || required.includes(`${serverId}:${toolName}`);
  }

  createToolApproval(input: {
    key: AuthenticatedKey;
    serverId: string;
    toolId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    requestId: string;
  }): EscalationTicket {
    const record: EscalationTicket = {
      id: newId('esc'),
      ticketId: newEscalationTicketId(),
      keyId: input.key.id,
      toolId: input.toolId,
      serverId: input.serverId,
      reason: 'APPROVAL_REQUIRED',
      requestPayload: { requestId: input.requestId, toolName: input.toolName },
      status: 'pending',
      ticketType: 'tool_approval',
      toolArguments: input.arguments ?? {},
      result: undefined,
      consumedAt: null,
      createdAt: nowIso(),
      resolvedAt: null,
      resolvedBy: null,
      note: null,
    };
    this.db
      .prepare(
        `INSERT INTO escalations
           (id, ticket_id, key_id, tool_id, server_id, reason, request_payload, status,
            ticket_type, tool_arguments, result_json, consumed_at,
            created_at, resolved_at, resolved_by, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending',
                 'tool_approval', ?, NULL, NULL,
                 ?, NULL, NULL, NULL)`,
      )
      .run(
        record.id,
        record.ticketId,
        record.keyId,
        record.toolId,
        record.serverId,
        record.reason,
        toJson(record.requestPayload),
        toJson(record.toolArguments ?? {}),
        record.createdAt,
      );
    this.logger.info('tool approval requested', {
      ticketId: record.ticketId,
      keyId: record.keyId,
      serverId: record.serverId,
      toolId: record.toolId,
    });
    return record;
  }

  takeResult(ticketId: string, keyId: string, toolId: string): ApprovalResult {
    const row = this.loadRow(ticketId);
    if (!row || row.ticket_type !== 'tool_approval') return invalid();
    // A ticket is bound to the key + tool that requested it; presenting someone
    // else's ticket (or the wrong tool) must never reveal its state/result.
    if (row.key_id !== keyId || row.tool_id !== toolId) return invalid();

    const ticket = mapEscalationRow(row);
    if (row.status === 'pending') return { state: 'pending', ticket, result: undefined };
    if (row.status === 'denied') return { state: 'denied', ticket, result: undefined };
    if (row.status === 'expired') return { state: 'expired', ticket, result: undefined };
    if (row.status !== 'approved') return invalid();

    if (row.consumed_at !== null) return { state: 'consumed', ticket, result: undefined };
    // `result_json IS NULL` means the supervisor is still executing the stored
    // call. Report "pending" so the agent retries instead of burning the ticket
    // before a result exists.
    if (row.result_json === null) return { state: 'pending', ticket, result: undefined };

    const consumedAt = nowIso();
    const consumed = this.db
      .prepare(
        `UPDATE escalations
            SET consumed_at = ?
          WHERE ticket_id = ?
            AND status = 'approved'
            AND consumed_at IS NULL
            AND result_json IS NOT NULL`,
      )
      .run(consumedAt, ticketId);
    if (Number(consumed.changes) !== 1) {
      // Lost the race to a concurrent retry: the ticket is spent.
      const current = this.loadRow(ticketId);
      return {
        state: 'consumed',
        ticket: current ? mapEscalationRow(current) : ticket,
        result: undefined,
      };
    }
    const updated = this.loadRow(ticketId);
    const stale = updated ? mapEscalationRow(updated) : { ...ticket, consumedAt };
    return { state: 'approved', ticket: stale, result: ticket.result };
  }

  async approveAndExecute(
    ticketId: string,
    resolvedBy: string,
    note?: string | null,
  ): Promise<{ ticket: EscalationTicket; result: unknown }> {
    const row = this.loadRow(ticketId);
    if (!row || row.ticket_type !== 'tool_approval') {
      throw invalidParams(`Tool approval ticket '${ticketId}' was not found.`);
    }
    const operator = typeof resolvedBy === 'string' ? resolvedBy.trim() : '';
    if (!operator) throw invalidParams('resolvedBy is required.');
    const serverId = row.server_id;
    const toolName = this.toolNameFor(row);
    if (!serverId || !toolName) {
      throw invalidParams(`Tool approval ticket '${ticketId}' has no stored tool call.`);
    }

    // Claim the ticket *before* executing: the conditional UPDATE is the
    // double-execution guard, so at most one caller ever runs the stored call.
    const claimed = this.db
      .prepare(
        `UPDATE escalations
            SET status = 'approved',
                resolved_at = ?,
                resolved_by = ?,
                note = ?,
                result_json = NULL,
                consumed_at = NULL
          WHERE ticket_id = ?
            AND status = 'pending'
            AND ticket_type = 'tool_approval'`,
      )
      .run(nowIso(), operator, note ?? null, ticketId);
    if (Number(claimed.changes) !== 1) {
      const current = this.loadRow(ticketId);
      throw invalidParams(
        `Tool approval ticket '${ticketId}' is already ${current?.status ?? 'resolved'} and cannot be approved again.`,
      );
    }

    const args = this.toolArgumentsFor(row);
    let result: unknown;
    try {
      // Status alone can be stale (e.g. a server row left "running" after a
      // restart), so also require a live client before reusing the process.
      if (this.supervisor.status(serverId) !== 'running' || this.supervisor.client(serverId) === null) {
        await this.supervisor.start(serverId);
      }
      const client = this.supervisor.client(serverId);
      if (!client) throw new Error(`Server '${serverId}' is unavailable.`);
      result = await client.callTool(toolName, args, { timeoutMs: this.timeoutMs });
      // A tool-level isError is still an executed approval: store it verbatim so
      // the agent can retry and see the same outcome.
      this.logger.info('approved tool call executed', { ticketId, serverId, toolName });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = {
        content: [{ type: 'text', text: `Execution failed: ${message}` }],
        isError: true,
      };
      this.logger.warn('approved tool call failed', { ticketId, serverId, toolName, error: message });
    }

    this.db.prepare('UPDATE escalations SET result_json = ? WHERE ticket_id = ?').run(toJson(result), ticketId);
    const updated = this.loadRow(ticketId);
    if (!updated) throw invalidParams(`Tool approval ticket '${ticketId}' was not found.`);
    return { ticket: mapEscalationRow(updated), result };
  }

  deny(ticketId: string, resolvedBy: string, note?: string | null): EscalationTicket {
    const row = this.loadRow(ticketId);
    if (!row || row.ticket_type !== 'tool_approval') {
      throw invalidParams(`Tool approval ticket '${ticketId}' was not found.`);
    }
    const operator = typeof resolvedBy === 'string' ? resolvedBy.trim() : '';
    if (!operator) throw invalidParams('resolvedBy is required.');
    const denied = this.db
      .prepare(
        `UPDATE escalations
            SET status = 'denied', resolved_at = ?, resolved_by = ?, note = ?
          WHERE ticket_id = ?
            AND status = 'pending'
            AND ticket_type = 'tool_approval'`,
      )
      .run(nowIso(), operator, note ?? null, ticketId);
    if (Number(denied.changes) !== 1) {
      const current = this.loadRow(ticketId);
      throw invalidParams(
        `Tool approval ticket '${ticketId}' is already ${current?.status ?? 'resolved'} and cannot be denied.`,
      );
    }
    const updated = this.loadRow(ticketId);
    if (!updated) throw invalidParams(`Tool approval ticket '${ticketId}' was not found.`);
    this.logger.info('tool approval denied', { ticketId, resolvedBy: operator });
    return mapEscalationRow(updated);
  }

  /** Pending tool-approval tickets, optionally scoped to one server (UI helper). */
  listPending(serverId?: string): EscalationTicket[] {
    const rows = (
      serverId
        ? this.db
            .prepare(
              `SELECT * FROM escalations
                WHERE ticket_type = 'tool_approval' AND status = 'pending' AND server_id = ?
                ORDER BY created_at DESC, rowid DESC`,
            )
            .all(serverId)
        : this.db
            .prepare(
              `SELECT * FROM escalations
                WHERE ticket_type = 'tool_approval' AND status = 'pending'
                ORDER BY created_at DESC, rowid DESC`,
            )
            .all()
    ) as unknown as EscalationRow[];
    return rows.map(mapEscalationRow);
  }

  private loadRow(ticketId: string): EscalationRow | null {
    const row = this.db.prepare('SELECT * FROM escalations WHERE ticket_id = ?').get(ticketId) as
      | EscalationRow
      | undefined;
    return row ?? null;
  }

  private toolNameFor(row: EscalationRow): string | null {
    const payload = parseJson<Record<string, unknown>>(row.request_payload, {});
    if (typeof payload.toolName === 'string' && payload.toolName !== '') return payload.toolName;
    if (row.tool_id) {
      const tool = this.repository.getTool(row.tool_id);
      if (tool) return tool.name;
      const prefix = row.server_id ? `${row.server_id}:` : '';
      if (prefix && row.tool_id.startsWith(prefix)) return row.tool_id.slice(prefix.length);
    }
    return null;
  }

  private toolArgumentsFor(row: EscalationRow): Record<string, unknown> {
    const parsed = parseJson<unknown>(row.tool_arguments, {});
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  }
}

function invalid(): ApprovalResult {
  return { state: 'invalid', ticket: null, result: undefined };
}
