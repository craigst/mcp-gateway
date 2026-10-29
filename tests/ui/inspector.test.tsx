// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getSession: vi.fn(),
    onUnauthorized: vi.fn(),
    getHealth: vi.fn(),
    getServerInspector: vi.fn(),
    getServerActivity: vi.fn(),
    revealSecret: vi.fn(),
    rpc: vi.fn(),
    rpcDetailed: vi.fn(),
    listServers: vi.fn(),
    listCatalogSources: vi.fn(),
    listServerUpdates: vi.fn(),
    listConfigProfiles: vi.fn(),
    startServer: vi.fn(),
    stopServer: vi.fn(),
    restartServer: vi.fn(),
    testServer: vi.fn(),
    deleteServer: vi.fn(),
    checkServerUpdate: vi.fn(),
    updateServer: vi.fn(),
    migrateEnvFile: vi.fn(),
    serverTools: vi.fn(),
    serverLogs: vi.fn(),
    updateServerPolicy: vi.fn(),
    registerServer: vi.fn(),
  },
}));

vi.mock('../../src/ui/lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/lib/api.js')>();
  return { ...actual, api: apiMock };
});

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../src/ui/App.js';
import { ServerInspectorPage } from '../../src/ui/pages/ServerInspector.js';
import type {
  AuditEntry,
  ServerInspectorOverview,
  ServerRecord,
  ToolDescriptor,
} from '../../src/core/types.js';

const server: ServerRecord = {
  id: 'srv_brain',
  name: 'brain',
  runtime: 'node',
  transport: 'stdio',
  status: 'running',
  command: 'node',
  args: ['brain-mcp.js'],
  url: null,
  env: {},
  manifest: {
    name: 'brain',
    version: '1.0.0',
    runtime: 'node22',
    start_command: 'node brain-mcp.js',
    capabilities: { high_privilege_tools: ['brain_delete'] },
  },
  capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} },
  instructions: 'Search stored notes before writing new ones.',
  highPrivilegeTools: ['brain_delete'],
  approvalRequiredTools: ['brain_delete'],
  configProfileIds: ['cfg_1'],
  delegationSupported: false,
  sourceUrl: 'https://github.com/example/brain-mcp',
  workDir: '/opt/gateway/servers/srv_brain',
  envFile: '/home/example/.config/brain/mcp.env',
  lastError: null,
  pid: 4321,
  createdAt: '2026-10-29T17:00:00.000Z',
  updatedAt: '2026-10-29T19:00:00.000Z',
};

const tool: ToolDescriptor = {
  id: 'srv_brain:brain_whoami',
  name: 'brain_whoami',
  description: 'Report the current brain agent and scope.',
  serverId: 'srv_brain',
  inputSchema: { type: 'object', properties: { verbose: { type: 'boolean' } } },
  highPrivilege: false,
  tags: [],
};

const dangerTool: ToolDescriptor = {
  id: 'srv_brain:brain_delete',
  name: 'brain_delete',
  description: 'Delete a stored note.',
  serverId: 'srv_brain',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  highPrivilege: true,
  tags: [],
};

const auditEntry: AuditEntry = {
  id: 71,
  ts: '2026-10-29T19:02:00.000Z',
  requestId: 'req-7',
  keyId: 'key_agent',
  method: 'tools/call',
  serverId: 'srv_brain',
  toolId: 'srv_brain:brain_whoami',
  status: 'ok',
  latencyMs: 12.5,
  errorCode: null,
  delegationDepth: 0,
  parentId: null,
  payload: { name: 'brain_whoami' },
};

const overview: ServerInspectorOverview = {
  server,
  source: {
    serverId: 'srv_brain',
    sourceKind: 'catalog',
    catalogSourceId: 'cat_1',
    catalogEntryId: 'brain-mcp',
    repoUrl: 'https://github.com/example/brain-mcp',
    requestedRef: 'v1.0.0',
    installedVersion: '1.0.0',
    installedCommit: 'a1b2c3d4e5f6',
    latestVersion: '1.2.0',
    latestCommit: 'd4e5f6a7b8c9',
    latestRef: 'v1.2.0',
    updateAvailable: true,
    checkedAt: '2026-10-29T19:00:00.000Z',
    checkError: null,
    changelogUrl: 'https://github.com/example/brain-mcp/compare/a1b2c3d...d4e5f6a',
  },
  tools: [tool, dangerTool],
  prompts: [
    {
      name: 'summarize',
      description: 'Summarize stored notes on a topic.',
      arguments: [{ name: 'topic', description: 'Topic to summarize', required: true }],
    },
  ],
  resources: [
    { uri: 'brain://notes', name: 'Stored notes', description: 'All notes', mimeType: 'text/plain' },
  ],
  config: {
    env: [{ key: 'BRAIN_URL', masked: true, value: null, source: 'server' }],
    headers: [{ key: 'X-Api-Key', masked: true, value: null, source: 'header' }],
    profiles: [
      {
        id: 'cfg_1',
        name: 'Internal services',
        description: 'Shared brain endpoint',
        entries: [
          { key: 'BRAIN_URL', source: 'encrypted', ref: null },
          { key: 'BRAIN_KEY', source: 'vault-ref', ref: 'BRAIN_KEY' },
        ],
        headers: [],
      },
    ],
    vaultRefs: ['BRAIN_KEY'],
  },
  stats: {
    total: 10,
    ok: 8,
    error: 1,
    denied: 1,
    errorRate: 0.2,
    lastUsedAt: '2026-10-29T19:02:00.000Z',
    avgLatencyMs: 12.5,
    p50LatencyMs: 10,
    p95LatencyMs: 40,
    distinctKeys: 2,
    toolUsage: [
      {
        toolId: 'srv_brain:brain_whoami',
        name: 'brain_whoami',
        count: 6,
        lastUsedAt: '2026-10-29T19:02:00.000Z',
        avgLatencyMs: 12,
      },
    ],
  },
  keysUsed: [
    {
      keyId: 'key_agent',
      keyName: 'ops-agent',
      keyPrefix: 'mcp_ag_ops',
      keyType: 'agent',
      count: 8,
      lastUsedAt: '2026-10-29T19:02:00.000Z',
    },
  ],
  activity: [auditEntry],
};

const activityPage = { summary: overview.stats, entries: [auditEntry], total: 1 };

beforeEach(() => {
  apiMock.getSession.mockResolvedValue({ authenticated: true, user: { username: 'operator' } });
  apiMock.onUnauthorized.mockReturnValue(() => {});
  apiMock.getHealth.mockResolvedValue({ status: 'ok', version: '0.4.0', uptimeMs: 1000 });
  apiMock.getServerInspector.mockResolvedValue(overview);
  apiMock.getServerActivity.mockResolvedValue(activityPage);
  apiMock.revealSecret.mockImplementation(async (_serverId: string, input: { key: string }) => ({
    key: input.key,
    value: input.key === 'BRAIN_URL' ? 'http://10.0.0.5:8080' : 'super-secret-value',
  }));
  apiMock.rpc.mockResolvedValue({ resourceTemplates: [] });
  apiMock.rpcDetailed.mockResolvedValue({
    id: 'ui-1',
    method: 'tools/call',
    result: { content: [{ type: 'text', text: 'done' }], isError: false },
    roundTripMs: 12,
    gatewayOverheadMs: 1.2,
    subServerMs: 3.4,
  });
  apiMock.listServers.mockResolvedValue([server]);
  apiMock.listCatalogSources.mockResolvedValue([]);
  apiMock.listServerUpdates.mockResolvedValue([]);
  apiMock.listConfigProfiles.mockResolvedValue([]);
  apiMock.startServer.mockResolvedValue(server);
  apiMock.stopServer.mockResolvedValue(server);
  apiMock.restartServer.mockResolvedValue(server);
  apiMock.testServer.mockResolvedValue({ ok: true, toolCount: 2, tools: ['brain_whoami'], latencyMs: 5, error: null });
  apiMock.deleteServer.mockResolvedValue(true);
  apiMock.checkServerUpdate.mockResolvedValue({
    serverId: 'srv_brain',
    serverName: 'brain',
    status: 'update-available',
    updateAvailable: true,
    fromVersion: '1.0.0',
    toVersion: '1.2.0',
    fromCommit: 'a1b2c3d4e5f6',
    toCommit: 'd4e5f6a7b8c9',
    latestRef: 'v1.2.0',
    checkedAt: '2026-10-29T19:10:00.000Z',
    error: null,
  });
  apiMock.serverTools.mockResolvedValue({
    serverId: 'srv_brain',
    approvalRequiredTools: [],
    highPrivilegeTools: [],
    tools: [],
    total: 0,
  });
  apiMock.serverLogs.mockResolvedValue([]);
  apiMock.updateServerPolicy.mockResolvedValue(server);
  apiMock.registerServer.mockResolvedValue(server);
  apiMock.migrateEnvFile.mockResolvedValue({ id: 'cfg_migrated', name: 'Migrated brain config' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  if (typeof window !== 'undefined') window.location.hash = '';
});

function renderInspector() {
  return render(<ServerInspectorPage serverId="srv_brain" onBack={() => {}} />);
}

describe('Server inspector routing', () => {
  it('opens #/server/<id> from the Installed table and can go back', async () => {
    window.location.hash = '#/catalog';
    render(<App />);

    const nameButton = await screen.findByRole('button', { name: 'brain' });
    fireEvent.click(nameButton);

    await waitFor(() => expect(window.location.hash).toBe('#/server/srv_brain'));
    expect(await screen.findByText('Tools / prompts / resources')).toBeTruthy();
    expect(apiMock.getServerInspector).toHaveBeenCalledWith('srv_brain');

    fireEvent.click(screen.getByRole('button', { name: '← Back to catalog' }));
    await waitFor(() => expect(window.location.hash).toBe('#/catalog'));
    expect(await screen.findByRole('tab', { name: /Installed/ })).toBeTruthy();
  });

  it('renders directly from the #/server/<id> hash', async () => {
    window.location.hash = '#/server/srv_brain';
    render(<App />);

    expect(await screen.findByText('Tools / prompts / resources')).toBeTruthy();
    expect(screen.getByRole('button', { name: '← Back to catalog' })).toBeTruthy();
    expect(apiMock.getServerInspector).toHaveBeenCalledWith('srv_brain');
  });
});

describe('ServerInspector page tabs', () => {
  it('renders the overview, tools, prompts/resources, configuration and activity tabs', async () => {
    renderInspector();

    expect(await screen.findByText('Tools / prompts / resources')).toBeTruthy();
    expect(screen.getByText('Source & updates')).toBeTruthy();
    expect(screen.getByText('Manifest')).toBeTruthy();
    expect(screen.getByText('Capabilities')).toBeTruthy();
    expect(screen.getByText('Instructions')).toBeTruthy();
    expect(screen.getByText(/Search stored notes before writing/)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /Tools/ }));
    expect(await screen.findByText('brain_whoami')).toBeTruthy();
    expect(screen.getByText('brain_delete')).toBeTruthy();
    expect(screen.getByText('High-privilege')).toBeTruthy();
    expect(screen.getByText('Approval required')).toBeTruthy();
    expect(screen.getByText('6 calls')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /Prompts & Resources/ }));
    expect(await screen.findByText('summarize')).toBeTruthy();
    expect(screen.getByText('brain://notes')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /Configuration/ }));
    expect((await screen.findAllByText('BRAIN_URL')).length).toBeGreaterThan(0);
    expect(screen.getByText('Internal services')).toBeTruthy();
    expect(screen.getByText('vault: BRAIN_KEY')).toBeTruthy();
    expect(screen.getByText('Legacy env file detected')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /Activity/ }));
    expect(await screen.findByText('P95 latency')).toBeTruthy();
    expect(screen.getByText('ops-agent')).toBeTruthy();
  });

  it('runs a tool from the Try panel and shows the result', async () => {
    renderInspector();
    await screen.findByText('Tools / prompts / resources');

    fireEvent.click(screen.getByRole('tab', { name: /Tools/ }));
    const row = (await screen.findByText('brain_whoami')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Try' }));

    fireEvent.change(screen.getByLabelText('Tool arguments JSON'), {
      target: { value: '{"verbose":true}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run tool' }));

    await waitFor(() =>
      expect(apiMock.rpcDetailed).toHaveBeenCalledWith('tools/call', {
        name: 'brain_whoami',
        serverId: 'srv_brain',
        arguments: { verbose: true },
      }),
    );
    expect(await screen.findByText(/12 ms round trip/)).toBeTruthy();
    expect(screen.getByText(/done/)).toBeTruthy();
    await waitFor(() => expect(apiMock.getServerInspector).toHaveBeenCalledTimes(2));
  });

  it('gets a prompt and reads a resource via JSON-RPC', async () => {
    renderInspector();
    await screen.findByText('Tools / prompts / resources');
    fireEvent.click(screen.getByRole('tab', { name: /Prompts & Resources/ }));

    const promptRow = (await screen.findByText('summarize')).closest('tr') as HTMLElement;
    fireEvent.click(within(promptRow).getByRole('button', { name: 'Get prompt' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Fetch prompt' }));

    await waitFor(() =>
      expect(apiMock.rpcDetailed).toHaveBeenCalledWith('prompts/get', {
        name: 'summarize',
        serverId: 'srv_brain',
        arguments: { topic: '' },
      }),
    );

    const resourceRow = screen.getByText('brain://notes').closest('tr') as HTMLElement;
    fireEvent.click(within(resourceRow).getByRole('button', { name: 'Read' }));

    await waitFor(() =>
      expect(apiMock.rpcDetailed).toHaveBeenCalledWith('resources/read', {
        uri: 'brain://notes',
        serverId: 'srv_brain',
      }),
    );
  });

  it('reveals masked env values and profile entries through the audited endpoint', async () => {
    renderInspector();
    await screen.findByText('Tools / prompts / resources');
    fireEvent.click(screen.getByRole('tab', { name: /Configuration/ }));

    const envCard = (await screen.findByText('Server environment')).closest('section') as HTMLElement;
    const envRow = (within(envCard).getByText('BRAIN_URL')).closest('li') as HTMLElement;
    fireEvent.click(within(envRow).getByRole('button', { name: 'Reveal' }));

    await waitFor(() =>
      expect(apiMock.revealSecret).toHaveBeenCalledWith('srv_brain', { kind: 'env', key: 'BRAIN_URL' }),
    );
    expect(await screen.findByText('http://10.0.0.5:8080')).toBeTruthy();

    const profileCard = screen.getByText('Internal services').closest('article') as HTMLElement;
    fireEvent.click(within(profileCard).getAllByRole('button', { name: 'Reveal' })[0] as HTMLElement);
    await waitFor(() =>
      expect(apiMock.revealSecret).toHaveBeenCalledWith('srv_brain', {
        kind: 'profile',
        key: 'BRAIN_URL',
        profileId: 'cfg_1',
      }),
    );
  });

  it('filters activity by status preset and key', async () => {
    renderInspector();
    await screen.findByText('Tools / prompts / resources');
    fireEvent.click(screen.getByRole('tab', { name: /Activity/ }));

    await waitFor(() =>
      expect(apiMock.getServerActivity).toHaveBeenCalledWith(
        'srv_brain',
        expect.objectContaining({ limit: 25, offset: 0 }),
      ),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Failed' }));
    await waitFor(() => {
      const calls = apiMock.getServerActivity.mock.calls as Array<[string, { status?: string }]>;
      const statuses = calls.map((call) => call[1]?.status).filter(Boolean);
      expect(statuses).toContain('error');
      expect(statuses).toContain('denied');
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Denied' }));
    await waitFor(() =>
      expect(apiMock.getServerActivity).toHaveBeenLastCalledWith(
        'srv_brain',
        expect.objectContaining({ status: 'denied', limit: 25, offset: 0 }),
      ),
    );

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0] as HTMLElement, { target: { value: 'key_agent' } });
    await waitFor(() =>
      expect(apiMock.getServerActivity).toHaveBeenLastCalledWith(
        'srv_brain',
        expect.objectContaining({ keyId: 'key_agent', status: 'denied' }),
      ),
    );
  });
});
