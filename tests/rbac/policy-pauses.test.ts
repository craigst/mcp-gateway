import { describe, expect, it } from 'vitest';
import type { AuthenticatedKey, ServerGrant, ToolDescriptor } from '../../src/core/types.js';
import { RbacPolicyEngine } from '../../src/rbac/policy.js';

const policy = new RbacPolicyEngine();

function key(grants: ServerGrant[]): AuthenticatedKey {
  return {
    id: 'key_test',
    name: 'test-key',
    keyType: 'agent',
    keyPrefix: 'mcp_ag_abcde',
    serverGrants: grants,
    delegationAllowed: false,
    escalationAllowed: false,
    expiresAt: null,
    revokedAt: null,
    pausedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    metadata: {},
  };
}

function tool(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    id: 'srv_a:read_query',
    name: 'read_query',
    description: 'Read',
    serverId: 'srv_a',
    inputSchema: { type: 'object' },
    highPrivilege: false,
    tags: [],
    ...overrides,
  };
}

describe('RbacPolicyEngine pause enforcement', () => {
  it('denies every call on a paused server grant with SERVER_PAUSED', () => {
    const scoped = key([{ serverId: 'srv_a', tools: null, paused: true }]);
    for (const candidate of [
      tool(),
      tool({ id: 'srv_a:write_query', name: 'write_query' }),
    ]) {
      const decision = policy.evaluateCall(scoped, candidate, {});
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('SERVER_PAUSED');
      expect(decision.detail).toContain('srv_a');
    }
  });

  it('does not affect other server grants', () => {
    const scoped = key([
      { serverId: 'srv_a', paused: true },
      { serverId: 'srv_b' },
    ]);
    expect(policy.evaluateCall(scoped, tool(), {}).reason).toBe('SERVER_PAUSED');
    const other = tool({ id: 'srv_b:read', name: 'read', serverId: 'srv_b' });
    expect(policy.evaluateCall(scoped, other, {})).toEqual({ allowed: true });
  });

  it('denies only the paused tool and keeps its siblings callable', () => {
    const scoped = key([
      { serverId: 'srv_a', tools: null, pausedTools: ['read_query', 'srv_a:write_query'] },
    ]);

    const pausedByName = policy.evaluateCall(scoped, tool(), {});
    expect(pausedByName.allowed).toBe(false);
    expect(pausedByName.reason).toBe('TOOL_PAUSED');
    expect(pausedByName.detail).toContain('read_query');

    const pausedById = policy.evaluateCall(
      scoped,
      tool({ id: 'srv_a:write_query', name: 'write_query' }),
      {},
    );
    expect(pausedById.reason).toBe('TOOL_PAUSED');

    const sibling = policy.evaluateCall(
      scoped,
      tool({ id: 'srv_a:list_tables', name: 'list_tables' }),
      {},
    );
    expect(sibling).toEqual({ allowed: true });
  });

  it('pauses high-privilege tools that are otherwise explicitly granted', () => {
    const scoped = key([
      {
        serverId: 'srv_a',
        tools: null,
        highPrivilegeTools: ['danger_delete'],
        pausedTools: ['danger_delete'],
      },
    ]);
    const danger = tool({ id: 'srv_a:danger_delete', name: 'danger_delete', highPrivilege: true });
    const decision = policy.evaluateCall(scoped, danger, {});
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('TOOL_PAUSED');
  });

  it('still reports high-privilege restrictions before tool pauses', () => {
    const scoped = key([{ serverId: 'srv_a', highPrivilegeTools: [], pausedTools: ['danger'] }]);
    const danger = tool({ id: 'srv_a:danger', name: 'danger', highPrivilege: true });
    const decision = policy.evaluateCall(scoped, danger, {});
    expect(decision.reason).toBe('HIGH_PRIVILEGE_RESTRICTION');
  });

  it('applies pause flags from grants on the master key too', () => {
    const master: AuthenticatedKey = {
      ...key([{ serverId: 'srv_a', paused: true }]),
      keyType: 'master',
    };
    expect(policy.evaluateCall(master, tool(), {}).reason).toBe('SERVER_PAUSED');

    const toolPaused: AuthenticatedKey = {
      ...key([{ serverId: 'srv_a', pausedTools: ['read_query'] }]),
      keyType: 'master',
    };
    expect(policy.evaluateCall(toolPaused, tool(), {}).reason).toBe('TOOL_PAUSED');
    // Without a matching grant the master key still has full access.
    expect(policy.evaluateCall({ ...master, serverGrants: [] }, tool(), {})).toEqual({
      allowed: true,
    });
  });

  it('keeps paused grants visible (availability restriction, not visibility masking)', () => {
    const scoped = key([{ serverId: 'srv_a', paused: true, pausedTools: ['read_query'] }]);
    expect(policy.isServerPermitted(scoped, 'srv_a')).toBe(true);
    expect(policy.isToolPermitted(scoped, tool())).toBe(true);
  });
});
