import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/core/db.js';
import type { AuthenticatedKey, CreateKeyInput, ServerRecord, ToolDescriptor } from '../../src/core/types.js';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';
import { DefaultCatalogService } from '../../src/catalog/service.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';
import { RbacPolicyEngine } from '../../src/rbac/policy.js';

let db: DatabaseSync;
let repository: SqliteCatalogRepository;
let keyService: SqliteKeyService;
let catalog: DefaultCatalogService;

function makeServer(overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    id: 'srv_pg',
    name: 'postgres',
    runtime: 'node',
    transport: 'stdio',
    status: 'running',
    command: 'node',
    args: [],
    url: null,
    env: {},
    headers: {},
    manifest: null,
    highPrivilegeTools: ['drop_table'],
    delegationSupported: false,
    sourceUrl: null,
    workDir: null,
    envFile: null,
    approvalRequiredTools: [],
    configProfileIds: [],
    capabilities: {},
    instructions: null,
    prompts: [],
    resources: [],
    lastError: null,
    pid: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTool(
  serverId: string,
  name: string,
  overrides: Partial<ToolDescriptor> = {},
): ToolDescriptor {
  return {
    id: `${serverId}:${name}`,
    name,
    description: `${name} description`,
    serverId,
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } } },
    highPrivilege: false,
    tags: [],
    ...overrides,
  };
}

let keyCounter = 0;

function issueKey(overrides: Partial<CreateKeyInput> = {}): AuthenticatedKey {
  keyCounter += 1;
  return keyService.issue({
    name: `key-${keyCounter}`,
    keyType: 'agent',
    ...overrides,
  }).key;
}

function seedCatalog(): void {
  repository.upsertServer(makeServer());
  repository.upsertTools('srv_pg', [
    makeTool('srv_pg', 'read_query', {
      description: 'Execute read-only SQL SELECT statements',
      tags: ['database', 'sql'],
    }),
    makeTool('srv_pg', 'drop_table', {
      description: 'Drop a table',
      highPrivilege: true,
      tags: ['database', 'danger'],
    }),
  ]);

  repository.upsertServer(
    makeServer({ id: 'srv_gh', name: 'github', highPrivilegeTools: [], delegationSupported: true }),
  );
  repository.upsertTools('srv_gh', [
    makeTool('srv_gh', 'create_issue', {
      description: 'Create a GitHub issue',
      tags: ['github'],
    }),
  ]);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  repository = new SqliteCatalogRepository(db);
  keyService = new SqliteKeyService(db);
  catalog = new DefaultCatalogService(repository, new RbacPolicyEngine());
  seedCatalog();
});

afterEach(() => {
  db.close();
});

describe('DefaultCatalogService zero-trust visibility', () => {
  it('shows an agent key only its granted tools in search and listing', () => {
    const agent = issueKey({
      serverGrants: [{ serverId: 'srv_pg', tools: ['read_query'], highPrivilegeTools: [] }],
    });

    const search = catalog.searchTools(agent, '', 20);
    expect(search.censored).toBe(true);
    expect(search.total).toBe(1);
    expect(search.tools.map((entry) => entry.name)).toEqual(['read_query']);
    expect(search.tools[0]).toMatchObject({
      id: 'srv_pg:read_query',
      name: 'read_query',
      server_id: 'srv_pg',
    });

    const listed = catalog.listTools(agent);
    expect(listed.total).toBe(1);
    expect(listed.tools.map((tool) => tool.name)).toEqual(['read_query']);
    expect(listed.tools[0]?.inputSchema).toEqual({
      type: 'object',
      properties: { sql: { type: 'string' } },
    });
  });

  it('keeps high-privilege tools absent from search and listing when not explicitly granted', () => {
    const agent = issueKey({
      serverGrants: [{ serverId: 'srv_pg', tools: ['read_query'], highPrivilegeTools: [] }],
    });

    expect(catalog.searchTools(agent, 'drop_table', 20).tools).toEqual([]);
    expect(catalog.searchTools(agent, 'danger', 20).tools).toEqual([]);
    expect(catalog.listTools(agent).tools.some((tool) => tool.name === 'drop_table')).toBe(false);
    expect(catalog.getVisibleTool(agent, 'srv_pg:drop_table')).toBeNull();
  });

  it('keeps tools of unpermitted servers invisible everywhere', () => {
    const agent = issueKey({
      serverGrants: [{ serverId: 'srv_pg', tools: ['read_query'], highPrivilegeTools: [] }],
    });

    expect(catalog.searchTools(agent, 'issue', 20).tools).toEqual([]);
    expect(catalog.searchTools(agent, 'github', 20).tools).toEqual([]);
    expect(catalog.listTools(agent).tools.some((tool) => tool.server_id === 'srv_gh')).toBe(false);
    expect(catalog.getVisibleTool(agent, 'srv_gh:create_issue')).toBeNull();
    expect(catalog.listTools(agent, { serverId: 'srv_gh' })).toEqual({ tools: [], total: 0 });
  });

  it('removes unpermitted servers from listPermittedServers and counts only visible tools', () => {
    const agent = issueKey({
      serverGrants: [{ serverId: 'srv_pg', tools: ['read_query'], highPrivilegeTools: [] }],
    });

    expect(catalog.listPermittedServers(agent)).toEqual([
      {
        id: 'srv_pg',
        name: 'postgres',
        runtime: 'node',
        status: 'running',
        delegation_supported: false,
        tool_count: 1,
      },
    ]);
  });

  it('shows an agent with no grants nothing at all', () => {
    const agent = issueKey({ serverGrants: [] });
    expect(catalog.searchTools(agent, '', 20)).toEqual({ tools: [], total: 0, censored: true });
    expect(catalog.listTools(agent)).toEqual({ tools: [], total: 0 });
    expect(catalog.listPermittedServers(agent)).toEqual([]);
    expect(catalog.getVisibleTool(agent, 'srv_pg:read_query')).toBeNull();
  });
});

describe('DefaultCatalogService explicit high-privilege grants', () => {
  it('reveals a high-privilege tool in search and listing when the grant names it', () => {
    const agent = issueKey({
      serverGrants: [{ serverId: 'srv_pg', highPrivilegeTools: ['drop_table'] }],
    });

    const search = catalog.searchTools(agent, 'drop', 20);
    expect(search.tools.map((entry) => entry.name)).toEqual(['drop_table']);
    expect(search.tools[0]?.server_id).toBe('srv_pg');

    const listed = catalog.listTools(agent);
    expect(listed.tools.map((tool) => tool.name)).toEqual(['drop_table', 'read_query']);
    expect(catalog.listPermittedServers(agent)[0]?.tool_count).toBe(2);
    expect(catalog.getVisibleTool(agent, 'srv_pg:drop_table')).not.toBeNull();
  });

  it('does not reveal a high-privilege tool merely because it is whitelisted', () => {
    const agent = issueKey({
      serverGrants: [
        {
          serverId: 'srv_pg',
          tools: ['read_query', 'drop_table'],
          highPrivilegeTools: [],
        },
      ],
    });

    expect(catalog.listTools(agent).tools.map((tool) => tool.name)).toEqual(['read_query']);
    expect(catalog.getVisibleTool(agent, 'srv_pg:drop_table')).toBeNull();
    expect(catalog.listPermittedServers(agent)[0]?.tool_count).toBe(1);
  });

  it('accepts a global tool id in highPrivilegeTools', () => {
    const agent = issueKey({
      serverGrants: [{ serverId: 'srv_pg', highPrivilegeTools: ['srv_pg:drop_table'] }],
    });
    expect(catalog.getVisibleTool(agent, 'srv_pg:drop_table')).not.toBeNull();
  });
});

describe('DefaultCatalogService master key', () => {
  it('sees the complete catalog including high-privilege tools and all servers', () => {
    const master = issueKey({ keyType: 'master' });

    const search = catalog.searchTools(master, '', 20);
    expect(search.censored).toBe(true);
    expect(search.tools.map((entry) => entry.name).sort()).toEqual([
      'create_issue',
      'drop_table',
      'read_query',
    ]);

    expect(catalog.listTools(master).total).toBe(3);

    const servers = catalog.listPermittedServers(master);
    expect(servers.map((server) => server.id).sort()).toEqual(['srv_gh', 'srv_pg']);
    expect(servers.find((server) => server.id === 'srv_pg')?.tool_count).toBe(2);
    expect(servers.find((server) => server.id === 'srv_gh')?.tool_count).toBe(1);
    expect(servers.find((server) => server.id === 'srv_gh')?.delegation_supported).toBe(true);

    expect(catalog.getVisibleTool(master, 'srv_pg:drop_table')).not.toBeNull();
  });

  it('honours search limits over the visible catalog', () => {
    const master = issueKey({ keyType: 'master' });
    expect(catalog.searchTools(master, '', 1).tools).toHaveLength(1);
    expect(catalog.searchTools(master, 'create', 20).tools.map((entry) => entry.name)).toEqual([
      'create_issue',
    ]);
  });
});

describe('DefaultCatalogService.listTools filters', () => {
  it('filters by serverId and returns masked schema projections', () => {
    const master = issueKey({ keyType: 'master' });
    const pg = catalog.listTools(master, { serverId: 'srv_pg' });
    expect(pg.tools.map((tool) => tool.name).sort()).toEqual(['drop_table', 'read_query']);
    for (const tool of pg.tools) {
      expect(Object.keys(tool).sort()).toEqual([
        'description',
        'id',
        'inputSchema',
        'name',
        'server_id',
      ]);
    }
  });
});

describe('DefaultCatalogService.upsertServerFromDiscovery', () => {
  it('registers a discovered server and its tools', () => {
    const server = makeServer({ id: 'srv_new', name: 'new-server', highPrivilegeTools: [] });
    const tools = [
      makeTool('srv_new', 'echo', { description: 'Echo input' }),
      makeTool('srv_new', 'add', { description: 'Add numbers' }),
    ];
    catalog.upsertServerFromDiscovery(server, tools);

    expect(repository.getServer('srv_new')).toEqual(server);
    expect(repository.listToolsByServer('srv_new').map((tool) => tool.name)).toEqual([
      'add',
      'echo',
    ]);

    const master = issueKey({ keyType: 'master' });
    expect(catalog.listPermittedServers(master).some((entry) => entry.id === 'srv_new')).toBe(true);
  });

  it('replaces the previous tool set on re-discovery', () => {
    const master = issueKey({ keyType: 'master' });
    const server = makeServer({ id: 'srv_new', name: 'new-server', highPrivilegeTools: [] });
    catalog.upsertServerFromDiscovery(server, [
      makeTool('srv_new', 'echo'),
      makeTool('srv_new', 'add'),
    ]);
    catalog.upsertServerFromDiscovery(server, [makeTool('srv_new', 'echo')]);

    expect(repository.listToolsByServer('srv_new').map((tool) => tool.name)).toEqual(['echo']);
    expect(catalog.listTools(master, { serverId: 'srv_new' }).total).toBe(1);
  });

  it('fills in tool ids when discovery omits them', () => {
    const server = makeServer({ id: 'srv_new', name: 'new-server', highPrivilegeTools: [] });
    const tool = makeTool('srv_new', 'echo');
    catalog.upsertServerFromDiscovery(server, [{ ...tool, id: '' }]);
    expect(repository.getTool('srv_new:echo')).not.toBeNull();
  });
});
