/**
 * Transient scope escalation tickets (spec §12).
 *
 * When a call is denied because a key lacks scope/high-privilege approval, the gateway
 * creates a pending ticket that a supervisor can approve or deny out-of-band. Tickets
 * are persisted so approvals survive restarts and are auditable.
 */
import type { DatabaseSync } from 'node:sqlite';
import { parseJson, toJson } from '../core/db.js';
import { invalidParams } from '../core/errors.js';
import { newEscalationTicketId, newId, nowIso } from '../core/ids.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { EscalationService } from '../core/ports.js';
import type {
  AuthenticatedKey,
  EscalationStatus,
  EscalationTicket,
  PolicyDenialReason,
} from '../core/types.js';

export interface EscalationServiceOptions {
  logger?: Logger;
}

interface EscalationRow {
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

const RESOLVED_STATUSES: readonly EscalationStatus[] = ['approved', 'denied', 'expired'];

function mapRow(row: EscalationRow): EscalationTicket {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    keyId: row.key_id,
    toolId: row.tool_id ?? null,
    serverId: row.server_id ?? null,
    reason: row.reason,
    requestPayload: parseJson<unknown>(row.request_payload, null),
    status: row.status as EscalationStatus,
    ticketType: row.ticket_type === 'tool_approval' ? 'tool_approval' : 'scope',
    toolArguments: parseJson<unknown>(row.tool_arguments, null),
    result: parseJson<unknown>(row.result_json, null),
    consumedAt: row.consumed_at ?? null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? null,
    resolvedBy: row.resolved_by ?? null,
    note: row.note ?? null,
  };
}

export class SqliteEscalationService implements EscalationService {
  private readonly db: DatabaseSync;
  private readonly logger: Logger;

  constructor(db: DatabaseSync, options: EscalationServiceOptions = {}) {
    this.db = db;
    this.logger = options.logger ?? createLogger('rbac');
  }

  create(input: {
    key: AuthenticatedKey;
    toolId: string | null;
    serverId: string | null;
    reason: PolicyDenialReason;
    requestPayload: unknown;
  }): EscalationTicket {
    const ticketId = newEscalationTicketId();
    const record: EscalationTicket = {
      id: newId('esc'),
      ticketId,
      keyId: input.key.id,
      toolId: input.toolId ?? null,
      serverId: input.serverId ?? null,
      reason: input.reason,
      requestPayload: input.requestPayload ?? null,
      status: 'pending',
      ticketType: 'scope',
      toolArguments: null,
      result: null,
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
            created_at, resolved_at, resolved_by, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL)`,
      )
      .run(
        record.id,
        record.ticketId,
        record.keyId,
        record.toolId,
        record.serverId,
        record.reason,
        toJson(record.requestPayload),
        record.createdAt,
      );
    this.logger.info('escalation ticket created', {
      ticketId: record.ticketId,
      keyId: record.keyId,
      reason: record.reason,
    });
    return record;
  }

  get(ticketId: string): EscalationTicket | null {
    const row = this.db
      .prepare('SELECT * FROM escalations WHERE ticket_id = ?')
      .get(ticketId) as unknown as EscalationRow | undefined;
    return row ? mapRow(row) : null;
  }

  list(status?: EscalationStatus): EscalationTicket[] {
    const statement =
      status === undefined
        ? this.db.prepare('SELECT * FROM escalations ORDER BY created_at DESC, rowid DESC')
        : this.db.prepare(
            'SELECT * FROM escalations WHERE status = ? ORDER BY created_at DESC, rowid DESC',
          );
    const rows = (status === undefined ? statement.all() : statement.all(status)) as unknown as EscalationRow[];
    return rows.map(mapRow);
  }

  resolve(
    ticketId: string,
    status: Exclude<EscalationStatus, 'pending'>,
    resolvedBy: string,
    note?: string | null,
  ): EscalationTicket {
    if (!(RESOLVED_STATUSES as readonly string[]).includes(status)) {
      throw invalidParams(`Invalid escalation resolution status '${String(status)}'.`);
    }
    if (typeof resolvedBy !== 'string' || resolvedBy.trim() === '') {
      throw invalidParams('resolvedBy is required.');
    }
    const current = this.get(ticketId);
    if (!current) throw invalidParams(`Escalation ticket '${ticketId}' was not found.`);
    if (current.status !== 'pending') {
      throw invalidParams(
        `Escalation ticket '${ticketId}' is already ${current.status} and cannot be resolved again.`,
      );
    }
    const resolvedAt = nowIso();
    this.db
      .prepare(
        'UPDATE escalations SET status = ?, resolved_at = ?, resolved_by = ?, note = ? WHERE ticket_id = ?',
      )
      .run(status, resolvedAt, resolvedBy.trim(), note ?? null, ticketId);
    const updated = this.get(ticketId);
    if (!updated) throw invalidParams(`Escalation ticket '${ticketId}' was not found.`);
    this.logger.info('escalation ticket resolved', {
      ticketId,
      status,
      resolvedBy: updated.resolvedBy,
    });
    return updated;
  }
}
