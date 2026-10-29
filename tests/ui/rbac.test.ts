import { describe, expect, it } from 'vitest';
import {
  buildScopeMatrix,
  describeGrants,
  hasFormErrors,
  isHighPrivilegeGranted,
  summarizeGrants,
  validateKeyForm,
} from '../../src/ui/lib/rbac.js';
import type { ServerGrant, ServerRecord } from '../../src/core/types.js';

function makeServer(overrides: Partial<ServerRecord> & { id: string; name: string }): ServerRecord {
  return {
    runtime: 'node',
    transport: 'stdio',
    status: 'running',
    command: null,
    args: [],
    url: null,
    env: {},
    manifest: null,
    highPrivilegeTools: [],
    delegationSupported: false,
    sourceUrl: null,
    workDir: null,
    lastError: null,
    pid: 1,
    createdAt: '2026-10-29T17:00:00.000Z',
    updatedAt: '2026-10-29T17:00:00.000Z',
    ...overrides,
  };
}

const postgres = makeServer({
  id: 'postgres-mcp-v1',
  name: 'postgres',
  highPrivilegeTools: ['drop_table'],
});
const echo = makeServer({ id: 'echo-v1', name: 'echo' });

const tools = [
  { id: 'postgres-mcp-v1:postgres_read_query', name: 'postgres_read_query', serverId: 'postgres-mcp-v1' },
  { id: 'postgres-mcp-v1:drop_table', name: 'drop_table', serverId: 'postgres-mcp-v1' },
  { id: 'echo-v1:echo', name: 'echo', serverId: 'echo-v1' },
];

describe('summarizeGrants', () => {
  it('normalises missing tool lists to "all tools" and counts guardrails', () => {
    const grants: ServerGrant[] = [
      { serverId: 'postgres-mcp-v1', tools: null },
      {
        serverId: 'echo-v1',
        tools: ['echo'],
        highPrivilegeTools: ['danger_delete'],
        guardrails: [{ kind: 'regex_applied_to_arguments', pattern: 'DROP' }],
      },
    ];

    const summary = summarizeGrants(grants);
    expect(summary).toHaveLength(2);
    expect(summary[0]).toMatchObject({ serverId: 'postgres-mcp-v1', toolCount: null, tools: null });
    expect(summary[1]).toMatchObject({
      serverId: 'echo-v1',
      toolCount: 1,
      highPrivilegeTools: ['danger_delete'],
      guardrailCount: 1,
    });
    expect(summarizeGrants(null)).toEqual([]);
  });

  it('renders a compact one-line description', () => {
    expect(describeGrants([])).toBe('No grants');
    expect(describeGrants([{ serverId: 'echo-v1', tools: ['echo'] }])).toContain('echo-v1 (1 tool)');
  });
});

describe('isHighPrivilegeGranted', () => {
  const grant: ServerGrant = {
    serverId: 'postgres-mcp-v1',
    tools: ['postgres_read_query'],
    highPrivilegeTools: ['drop_table'],
  };

  it('matches full tool ids and bare tool names', () => {
    expect(isHighPrivilegeGranted(grant, 'postgres-mcp-v1:drop_table')).toBe(true);
    expect(isHighPrivilegeGranted(grant, 'drop_table')).toBe(true);
  });

  it('does not imply high-privilege access from a normal grant', () => {
    expect(isHighPrivilegeGranted(grant, 'postgres_read_query')).toBe(false);
    expect(isHighPrivilegeGranted(grant, 'postgres-mcp-v1:postgres_read_query')).toBe(false);
    expect(isHighPrivilegeGranted(null, 'drop_table')).toBe(false);
    expect(isHighPrivilegeGranted({ serverId: 'echo-v1', tools: null }, 'danger_delete')).toBe(false);
  });
});

describe('buildScopeMatrix', () => {
  it('builds one row per server with effective grant state per tool', () => {
    const grants: ServerGrant[] = [
      {
        serverId: 'postgres-mcp-v1',
        tools: ['postgres_read_query'],
        highPrivilegeTools: ['drop_table'],
      },
    ];
    const matrix = buildScopeMatrix([postgres, echo], tools, grants);

    expect(matrix).toHaveLength(2);
    const pgRow = matrix[0];
    expect(pgRow).toBeDefined();
    expect(pgRow?.serverGranted).toBe(true);
    expect(pgRow?.toolCount).toBe(2);
    expect(pgRow?.grantedCount).toBe(2);

    const readCell = pgRow?.cells.find((cell) => cell.toolName === 'postgres_read_query');
    expect(readCell).toMatchObject({ granted: true, highPrivilege: false });
    const dropCell = pgRow?.cells.find((cell) => cell.toolName === 'drop_table');
    expect(dropCell).toMatchObject({ granted: true, highPrivilege: true, highPrivilegeGranted: true });

    const echoRow = matrix[1];
    expect(echoRow?.serverGranted).toBe(false);
    expect(echoRow?.cells.every((cell) => cell.granted === false)).toBe(true);
  });

  it('treats a null tool whitelist as all non-high-privilege tools', () => {
    const matrix = buildScopeMatrix([postgres], tools, [{ serverId: 'postgres-mcp-v1', tools: null }]);
    const pgRow = matrix[0];
    const readCell = pgRow?.cells.find((cell) => cell.toolName === 'postgres_read_query');
    const dropCell = pgRow?.cells.find((cell) => cell.toolName === 'drop_table');
    expect(readCell?.granted).toBe(true);
    // High-privilege tools are never implied by tools: null.
    expect(dropCell?.granted).toBe(false);
  });

  it('marks tools with an explicit highPrivilege flag even when the server list is stale', () => {
    const flaggedTools = [
      { id: 'echo-v1:danger_delete', name: 'danger_delete', serverId: 'echo-v1', highPrivilege: true },
    ];
    const matrix = buildScopeMatrix([echo], flaggedTools, [
      { serverId: 'echo-v1', tools: null, highPrivilegeTools: ['danger_delete'] },
    ]);
    const cell = matrix[0]?.cells[0];
    expect(cell).toMatchObject({ highPrivilege: true, highPrivilegeGranted: true, granted: true });
  });
});

describe('validateKeyForm', () => {
  const valid = {
    name: 'sales-agent',
    keyType: 'agent' as const,
    serverGrants: [{ serverId: 'echo-v1', tools: ['echo'] }],
    delegationAllowed: false,
    escalationAllowed: true,
    expiresInSeconds: 86_400,
  };

  it('accepts a well-formed key', () => {
    const errors = validateKeyForm(valid);
    expect(errors).toEqual({});
    expect(hasFormErrors(errors)).toBe(false);
  });

  it('rejects missing names and bad expiries', () => {
    const errors = validateKeyForm({ ...valid, name: '   ', expiresInSeconds: 'soon' });
    expect(errors.name).toBe('Name is required');
    expect(errors.expiresInSeconds).toBeTruthy();
    expect(hasFormErrors(errors)).toBe(true);

    expect(validateKeyForm({ ...valid, expiresInSeconds: 0 }).expiresInSeconds).toBeTruthy();
    expect(validateKeyForm({ ...valid, expiresInSeconds: 1.5 }).expiresInSeconds).toBeTruthy();
  });

  it('rejects duplicate server grants and invalid key types', () => {
    const duplicate = validateKeyForm({
      ...valid,
      serverGrants: [{ serverId: 'echo-v1' }, { serverId: 'echo-v1' }],
    });
    expect(duplicate.serverGrants).toBeTruthy();

    const badType = validateKeyForm({ ...valid, keyType: 'robot' as never });
    expect(badType.keyType).toBeTruthy();
  });
});
