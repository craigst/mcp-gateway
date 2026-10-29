import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/core/db.js';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import type { AuthenticatedKey } from '../../src/core/types.js';
import { SqliteEscalationService } from '../../src/rbac/escalations.js';

let db: DatabaseSync;
let escalations: SqliteEscalationService;

const key: AuthenticatedKey = {
  id: 'key_agent',
  name: 'sales-agent',
  keyType: 'agent',
  keyPrefix: 'mcp_ag_abcde',
  serverGrants: [],
  delegationAllowed: false,
  escalationAllowed: true,
  expiresAt: null,
  revokedAt: null,
  pausedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: null,
  metadata: {},
};

beforeEach(() => {
  db = openDatabase(':memory:');
  escalations = new SqliteEscalationService(db);
});

afterEach(() => {
  db.close();
});

function gatewayError(fn: () => unknown): GatewayError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }
  throw new Error('Expected the function to throw a GatewayError.');
}

function createTicket(toolId = 'srv_pg:drop_table') {
  return escalations.create({
    key,
    toolId,
    serverId: 'srv_pg',
    reason: 'HIGH_PRIVILEGE_RESTRICTION',
    requestPayload: { toolId, arguments: { sql: 'DROP TABLE users' } },
  });
}

describe('SqliteEscalationService.create', () => {
  it('creates a pending ticket with a dated ticket id and the request payload', () => {
    const ticket = createTicket();

    expect(ticket.id).toMatch(/^esc_[0-9a-f]+$/);
    expect(ticket.ticketId).toMatch(/^esc-\d{8}-[0-9a-f]{4}$/);
    expect(ticket.status).toBe('pending');
    expect(ticket.keyId).toBe(key.id);
    expect(ticket.toolId).toBe('srv_pg:drop_table');
    expect(ticket.serverId).toBe('srv_pg');
    expect(ticket.reason).toBe('HIGH_PRIVILEGE_RESTRICTION');
    expect(ticket.requestPayload).toEqual({
      toolId: 'srv_pg:drop_table',
      arguments: { sql: 'DROP TABLE users' },
    });
    expect(ticket.resolvedAt).toBeNull();
    expect(ticket.resolvedBy).toBeNull();
    expect(ticket.note).toBeNull();
    expect(Date.parse(ticket.createdAt)).not.toBeNaN();
  });

  it('creates unique ticket ids', () => {
    const ids = new Set(Array.from({ length: 10 }, () => createTicket().ticketId));
    expect(ids.size).toBe(10);
  });
});

describe('SqliteEscalationService.get / list', () => {
  it('reads a ticket by its ticket id, or returns null', () => {
    const ticket = createTicket();
    expect(escalations.get(ticket.ticketId)).toEqual(ticket);
    expect(escalations.get('esc-19700101-0000')).toBeNull();
  });

  it('persists across service instances sharing the database', () => {
    const ticket = createTicket();
    const otherService = new SqliteEscalationService(db);
    expect(otherService.get(ticket.ticketId)).toEqual(ticket);
  });

  it('lists all tickets and filters by status', () => {
    const first = createTicket('a');
    const second = createTicket('b');
    const third = createTicket('c');

    expect(escalations.list()).toHaveLength(3);
    expect(escalations.list('pending')).toHaveLength(3);

    escalations.resolve(second.ticketId, 'approved', 'supervisor@example.com', 'looks fine');

    expect(escalations.list()).toHaveLength(3);
    expect(escalations.list('pending').map((ticket) => ticket.ticketId).sort()).toEqual(
      [first.ticketId, third.ticketId].sort(),
    );
    expect(escalations.list('approved').map((ticket) => ticket.ticketId)).toEqual([
      second.ticketId,
    ]);
    expect(escalations.list('denied')).toEqual([]);
  });
});

describe('SqliteEscalationService.resolve', () => {
  it('resolves a pending ticket with resolver and note', () => {
    const ticket = createTicket();
    const resolved = escalations.resolve(
      ticket.ticketId,
      'approved',
      'supervisor@example.com',
      'approved after review',
    );

    expect(resolved.status).toBe('approved');
    expect(resolved.resolvedBy).toBe('supervisor@example.com');
    expect(resolved.note).toBe('approved after review');
    expect(resolved.resolvedAt).not.toBeNull();
    expect(Date.parse(resolved.resolvedAt ?? '')).not.toBeNaN();
    expect(escalations.get(ticket.ticketId)).toEqual(resolved);
  });

  it('supports denying a ticket without a note', () => {
    const ticket = createTicket();
    const resolved = escalations.resolve(ticket.ticketId, 'denied', 'supervisor@example.com');
    expect(resolved.status).toBe('denied');
    expect(resolved.note).toBeNull();
  });

  it('rejects resolving a ticket twice', () => {
    const ticket = createTicket();
    escalations.resolve(ticket.ticketId, 'approved', 'supervisor@example.com');
    const err = gatewayError(() =>
      escalations.resolve(ticket.ticketId, 'denied', 'supervisor@example.com'),
    );
    expect(err.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(err.message).toContain('already approved');
    // The original resolution is unchanged.
    expect(escalations.get(ticket.ticketId)?.status).toBe('approved');
  });

  it('rejects unknown tickets', () => {
    const err = gatewayError(() =>
      escalations.resolve('esc-19700101-0000', 'approved', 'supervisor@example.com'),
    );
    expect(err.code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it('rejects invalid resolution inputs', () => {
    const ticket = createTicket();
    expect(
      gatewayError(() =>
        escalations.resolve(ticket.ticketId, 'pending' as never, 'supervisor@example.com'),
      ).code,
    ).toBe(ErrorCodes.INVALID_PARAMS);
    expect(
      gatewayError(() => escalations.resolve(ticket.ticketId, 'approved', '   ')).code,
    ).toBe(ErrorCodes.INVALID_PARAMS);
  });
});
