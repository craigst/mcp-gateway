import { describe, expect, it } from 'vitest';
import type {
  AuthenticatedKey,
  KeyType,
  ServerGrant,
  ToolDescriptor,
  ToolGuardrail,
} from '../../src/core/types.js';
import { RbacPolicyEngine } from '../../src/rbac/policy.js';

const policy = new RbacPolicyEngine();

function keyTypeOrDefault(keyType?: KeyType): KeyType {
  return keyType ?? 'agent';
}

function key(overrides: Partial<AuthenticatedKey> = {}): AuthenticatedKey {
  return {
    id: 'key_test',
    name: 'test-key',
    keyType: keyTypeOrDefault(overrides.keyType),
    keyPrefix: 'mcp_ag_abcde',
    serverGrants: [],
    delegationAllowed: false,
    escalationAllowed: false,
    expiresAt: null,
    revokedAt: null,
    pausedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    metadata: {},
    ...overrides,
  };
}

function tool(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    id: 'srv_pg:read_query',
    name: 'read_query',
    description: 'Run a read-only query',
    serverId: 'srv_pg',
    inputSchema: { type: 'object' },
    highPrivilege: false,
    tags: [],
    ...overrides,
  };
}

function highPrivilegeTool(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return tool({
    id: 'srv_pg:drop_table',
    name: 'drop_table',
    description: 'Drop a table',
    highPrivilege: true,
    ...overrides,
  });
}

function grant(overrides: Partial<ServerGrant> = {}): ServerGrant {
  return { serverId: 'srv_pg', ...overrides };
}

describe('RbacPolicyEngine.isServerPermitted', () => {
  it('requires an explicit server grant for non-master keys', () => {
    const agent = key({ serverGrants: [grant()] });
    expect(policy.isServerPermitted(agent, 'srv_pg')).toBe(true);
    expect(policy.isServerPermitted(agent, 'srv_github')).toBe(false);
    expect(policy.isServerPermitted(key(), 'srv_pg')).toBe(false);
  });

  it('lets the master key see every server', () => {
    const master = key({ keyType: 'master' });
    expect(policy.isServerPermitted(master, 'srv_pg')).toBe(true);
    expect(policy.isServerPermitted(master, 'srv_anything')).toBe(true);
  });
});

describe('RbacPolicyEngine.isToolPermitted', () => {
  it('denies every tool when the server is not granted', () => {
    expect(policy.isToolPermitted(key(), tool())).toBe(false);
    expect(policy.isToolPermitted(key({ serverGrants: [grant({ serverId: 'srv_other' })] }), tool())).toBe(
      false,
    );
  });

  it('treats a null/omitted whitelist as "all non-high-privilege tools"', () => {
    const omitted = key({ serverGrants: [grant()] });
    const explicitNull = key({ serverGrants: [grant({ tools: null })] });
    expect(policy.isToolPermitted(omitted, tool())).toBe(true);
    expect(policy.isToolPermitted(explicitNull, tool())).toBe(true);
  });

  it('enforces a tool whitelist by name or by global tool id', () => {
    const byName = key({ serverGrants: [grant({ tools: ['read_query'] })] });
    const byId = key({ serverGrants: [grant({ tools: ['srv_pg:read_query'] })] });
    expect(policy.isToolPermitted(byName, tool())).toBe(true);
    expect(policy.isToolPermitted(byId, tool())).toBe(true);
    expect(policy.isToolPermitted(byName, tool({ name: 'write_query', id: 'srv_pg:write_query' }))).toBe(
      false,
    );
    expect(policy.isToolPermitted(key({ serverGrants: [grant({ tools: [] })] }), tool())).toBe(
      false,
    );
  });

  it('masks high-privilege tools unless explicitly named', () => {
    const wildcard = key({ serverGrants: [grant()] });
    expect(policy.isToolPermitted(wildcard, highPrivilegeTool())).toBe(false);

    const whitelistedButNotHighPriv = key({
      serverGrants: [grant({ tools: ['drop_table', 'read_query'], highPrivilegeTools: [] })],
    });
    expect(policy.isToolPermitted(whitelistedButNotHighPriv, highPrivilegeTool())).toBe(false);

    const byName = key({ serverGrants: [grant({ highPrivilegeTools: ['drop_table'] })] });
    const byId = key({ serverGrants: [grant({ highPrivilegeTools: ['srv_pg:drop_table'] })] });
    expect(policy.isToolPermitted(byName, highPrivilegeTool())).toBe(true);
    expect(policy.isToolPermitted(byId, highPrivilegeTool())).toBe(true);
    // The explicit high-privilege grant does not restrict the regular whitelist.
    expect(policy.isToolPermitted(byName, tool())).toBe(true);
  });

  it('gives the master key visibility into high-privilege tools', () => {
    const master = key({ keyType: 'master' });
    expect(policy.isToolPermitted(master, tool())).toBe(true);
    expect(policy.isToolPermitted(master, highPrivilegeTool())).toBe(true);
  });
});

describe('RbacPolicyEngine.evaluateCall', () => {
  it('reports SERVER_NOT_PERMITTED before anything else', () => {
    const decision = policy.evaluateCall(key(), highPrivilegeTool(), {});
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('SERVER_NOT_PERMITTED');
  });

  it('reports HIGH_PRIVILEGE_RESTRICTION for un-granted high-privilege tools', () => {
    const decision = policy.evaluateCall(key({ serverGrants: [grant()] }), highPrivilegeTool(), {});
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('HIGH_PRIVILEGE_RESTRICTION');
  });

  it('reports TOOL_NOT_PERMITTED for whitelisted-out tools', () => {
    const scoped = key({ serverGrants: [grant({ tools: ['read_query'] })] });
    const decision = policy.evaluateCall(scoped, tool({ name: 'write', id: 'srv_pg:write' }), {});
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('TOOL_NOT_PERMITTED');
  });

  it('allows a granted tool and applies grant guardrails', () => {
    const denyDdl: ToolGuardrail = {
      kind: 'regex_applied_to_arguments',
      pattern: '\\bDROP\\b',
      message: 'no DDL',
    };
    const scoped = key({
      serverGrants: [grant({ tools: ['read_query'], guardrails: [denyDdl] })],
    });

    expect(policy.evaluateCall(scoped, tool(), { sql: 'SELECT 1' })).toEqual({ allowed: true });

    const denied = policy.evaluateCall(scoped, tool(), { sql: 'DROP TABLE t' });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('GUARDRAIL_VIOLATION');
    expect(denied.detail).toContain('no DDL');
  });

  it('applies high-privilege guardrails only to the targeted tool', () => {
    const rule: ToolGuardrail = {
      kind: 'regex_applied_to_arguments',
      pattern: 'truncate',
      tool: 'drop_table',
    };
    const scoped = key({
      serverGrants: [grant({ highPrivilegeTools: ['drop_table'], guardrails: [rule] })],
    });
    expect(policy.evaluateCall(scoped, highPrivilegeTool(), { sql: 'truncate x' }).allowed).toBe(
      false,
    );
    expect(policy.evaluateCall(scoped, tool(), { sql: 'truncate x' }).allowed).toBe(true);
  });

  it('applies json_schema guardrails on the matched grant', () => {
    const scoped = key({
      serverGrants: [
        grant({
          tools: ['read_query'],
          guardrails: [
            {
              kind: 'json_schema',
              message: 'sql must be a string',
              schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
            },
          ],
        }),
      ],
    });
    expect(policy.evaluateCall(scoped, tool(), { sql: 'SELECT 1' }).allowed).toBe(true);
    const denied = policy.evaluateCall(scoped, tool(), { sql: 5 });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('GUARDRAIL_VIOLATION');
  });

  it('allows the master key everywhere', () => {
    const master = key({ keyType: 'master' });
    expect(policy.evaluateCall(master, tool(), {})).toEqual({ allowed: true });
    expect(policy.evaluateCall(master, highPrivilegeTool(), {})).toEqual({ allowed: true });
  });
});

describe('RbacPolicyEngine flags', () => {
  it('reads delegation and escalation permissions from the key', () => {
    expect(policy.canDelegate(key())).toBe(false);
    expect(policy.canDelegate(key({ delegationAllowed: true }))).toBe(true);
    expect(policy.canEscalate(key())).toBe(false);
    expect(policy.canEscalate(key({ escalationAllowed: true }))).toBe(true);
  });
});

describe('RbacPolicyEngine.guardrailsFor', () => {
  const rules: ToolGuardrail[] = [
    { kind: 'regex_applied_to_arguments', pattern: 'drop' },
  ];

  it('returns the matching grant guardrails', () => {
    const scoped = key({ serverGrants: [grant({ guardrails: rules })] });
    expect(policy.guardrailsFor(scoped, tool())).toEqual(rules);
  });

  it('returns an empty list when there is no matching grant', () => {
    expect(policy.guardrailsFor(key(), tool())).toEqual([]);
    expect(policy.guardrailsFor(key({ serverGrants: [grant({ serverId: 'other' })] }), tool())).toEqual(
      [],
    );
  });
});
