import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/core/db.js';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import type { ServerManifest, ServerRecord, ToolDescriptor } from '../../src/core/types.js';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';

let db: DatabaseSync;
let repository: SqliteCatalogRepository;

const manifest: ServerManifest = {
  name: 'echo',
  version: '1.2.3',
  runtime: 'node20',
  build_command: 'npm run build',
  start_command: 'node dist/index.js',
  environment: { NODE_ENV: 'production' },
  required_secrets: ['GITHUB_PAT_TOKEN'],
  capabilities: { high_privilege_tools: ['danger_delete'], delegation_supported: true },
};

function makeServer(overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    id: 'srv_echo',
    name: 'echo',
    runtime: 'node',
    transport: 'stdio',
    status: 'stopped',
    command: 'node',
    args: ['tests/fixtures/mcp-echo-server.mjs'],
    url: null,
    env: { NODE_ENV: 'test', TOKEN: 'secret' },
    headers: {},
    manifest,
    highPrivilegeTools: ['danger_delete'],
    delegationSupported: true,
    sourceUrl: 'https://github.com/org/echo-mcp',
    workDir: '/tmp/repos/echo',
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
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql'],
    },
    highPrivilege: false,
    tags: ['database'],
    ...overrides,
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  repository = new SqliteCatalogRepository(db);
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

describe('SqliteCatalogRepository servers', () => {
  it('round-trips every server field', () => {
    const server = makeServer({ pid: 4321 });
    repository.upsertServer(server);
    expect(repository.getServer(server.id)).toEqual(server);
  });

  it('round-trips a server with null optional fields', () => {
    const server = makeServer({
      id: 'srv_remote',
      name: 'remote',
      runtime: 'remote-agent',
      transport: 'http',
      command: null,
      args: [],
      url: 'http://127.0.0.1:9000/mcp',
      env: {},
      manifest: null,
      highPrivilegeTools: [],
      delegationSupported: false,
      sourceUrl: null,
      workDir: null,
      lastError: 'previous crash',
      pid: null,
    });
    repository.upsertServer(server);
    expect(repository.getServer('srv_remote')).toEqual(server);
  });

  it('looks servers up by name and lists them sorted by name', () => {
    repository.upsertServer(makeServer({ id: 'srv_b', name: 'bravo' }));
    repository.upsertServer(makeServer({ id: 'srv_a', name: 'alpha' }));
    expect(repository.getServerByName('alpha')?.id).toBe('srv_a');
    expect(repository.getServerByName('missing')).toBeNull();
    expect(repository.listServers().map((server) => server.name)).toEqual(['alpha', 'bravo']);
    expect(repository.getServer('missing')).toBeNull();
  });

  it('updates an existing server on upsert', () => {
    repository.upsertServer(makeServer());
    repository.upsertServer(
      makeServer({
        status: 'running',
        args: ['dist/index.js'],
        env: { NODE_ENV: 'production' },
        highPrivilegeTools: [],
        updatedAt: '2026-02-01T00:00:00.000Z',
      }),
    );
    const stored = repository.getServer('srv_echo');
    expect(stored?.status).toBe('running');
    expect(stored?.args).toEqual(['dist/index.js']);
    expect(stored?.env).toEqual({ NODE_ENV: 'production' });
    expect(stored?.highPrivilegeTools).toEqual([]);
    expect(stored?.updatedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(repository.listServers()).toHaveLength(1);
  });

  it('rejects a duplicate server name under a different id', () => {
    repository.upsertServer(makeServer());
    const err = gatewayError(() => repository.upsertServer(makeServer({ id: 'srv_other' })));
    expect(err.code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it('updates status and advances updated_at while preserving created_at', () => {
    repository.upsertServer(makeServer({ updatedAt: '2020-01-01T00:00:00.000Z' }));
    repository.setServerStatus('srv_echo', 'running', { pid: 999 });

    const stored = repository.getServer('srv_echo');
    expect(stored?.status).toBe('running');
    expect(stored?.pid).toBe(999);
    expect(stored?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(Date.parse(stored?.updatedAt ?? '')).toBeGreaterThan(
      Date.parse('2020-01-01T00:00:00.000Z'),
    );
  });

  it('rejects status updates for unknown servers', () => {
    const err = gatewayError(() => repository.setServerStatus('srv_missing', 'running'));
    expect(err.code).toBe(ErrorCodes.INVALID_PARAMS);
  });
});

describe('SqliteCatalogRepository tools', () => {
  it('stores and retrieves tools with JSON columns decoded', () => {
    repository.upsertServer(makeServer());
    const tools = [
      makeTool('srv_echo', 'read_query'),
      makeTool('srv_echo', 'danger_delete', {
        highPrivilege: true,
        tags: ['danger', 'admin'],
        inputSchema: { type: 'object', properties: { table: { type: 'string' } } },
      }),
    ];
    repository.upsertTools('srv_echo', tools);

    // listToolsByServer orders by name: danger_delete before read_query.
    expect(repository.listToolsByServer('srv_echo')).toEqual([tools[1], tools[0]]);
    expect(repository.getTool('srv_echo:danger_delete')).toEqual(tools[1]);
    expect(repository.getToolByName('srv_echo', 'read_query')).toEqual(tools[0]);
    expect(repository.getTool('srv_echo:missing')).toBeNull();
    expect(repository.getToolByName('srv_echo', 'missing')).toBeNull();
    expect(repository.getTool('srv_echo:read_query')?.highPrivilege).toBe(false);
  });

  it('replaces the whole tool set for a server transactionally', () => {
    repository.upsertServer(makeServer());
    repository.upsertTools('srv_echo', [
      makeTool('srv_echo', 'a'),
      makeTool('srv_echo', 'b'),
      makeTool('srv_echo', 'c'),
    ]);
    expect(repository.listToolsByServer('srv_echo')).toHaveLength(3);

    repository.upsertTools('srv_echo', [makeTool('srv_echo', 'b')]);
    const after = repository.listToolsByServer('srv_echo');
    expect(after.map((tool) => tool.name)).toEqual(['b']);
    expect(repository.getTool('srv_echo:a')).toBeNull();
  });

  it('keeps tool sets isolated per server and lists deterministically', () => {
    repository.upsertServer(makeServer({ id: 'srv_a', name: 'alpha' }));
    repository.upsertServer(makeServer({ id: 'srv_b', name: 'bravo' }));
    repository.upsertTools('srv_b', [makeTool('srv_b', 'zeta'), makeTool('srv_b', 'alpha')]);
    repository.upsertTools('srv_a', [makeTool('srv_a', 'middle')]);

    expect(repository.listToolsByServer('srv_b').map((tool) => tool.name)).toEqual([
      'alpha',
      'zeta',
    ]);
    expect(repository.listTools().map((tool) => tool.id)).toEqual([
      'srv_a:middle',
      'srv_b:alpha',
      'srv_b:zeta',
    ]);
  });

  it('deletes all tools for a server', () => {
    repository.upsertServer(makeServer());
    repository.upsertTools('srv_echo', [makeTool('srv_echo', 'a')]);
    repository.deleteTools('srv_echo');
    expect(repository.listToolsByServer('srv_echo')).toEqual([]);
    expect(repository.listTools()).toEqual([]);
  });
});

describe('SqliteCatalogRepository deletion', () => {
  it('cascades tool deletion when a server is deleted', () => {
    repository.upsertServer(makeServer());
    repository.upsertTools('srv_echo', [
      makeTool('srv_echo', 'a'),
      makeTool('srv_echo', 'b'),
    ]);

    repository.deleteServer('srv_echo');

    expect(repository.getServer('srv_echo')).toBeNull();
    expect(repository.getTool('srv_echo:a')).toBeNull();
    expect(repository.listToolsByServer('srv_echo')).toEqual([]);
    expect(repository.listTools()).toEqual([]);
  });

  it('deleting an unknown server is a no-op', () => {
    expect(() => repository.deleteServer('srv_missing')).not.toThrow();
  });

  it('rejects tool inserts for a server that does not exist (foreign key)', () => {
    expect(() => repository.upsertTools('srv_missing', [makeTool('srv_missing', 'a')])).toThrow();
    // The failed transaction must not leave partial rows behind.
    expect(repository.listTools()).toEqual([]);
  });
});
