// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listServers: vi.fn(),
    listCatalogSources: vi.fn(),
    listServerUpdates: vi.fn(),
    checkUpdates: vi.fn(),
    checkServerUpdate: vi.fn(),
    updateServer: vi.fn(),
    serverTools: vi.fn(),
    listConfigProfiles: vi.fn(),
    serverLogs: vi.fn(),
    testServer: vi.fn(),
    updateServerPolicy: vi.fn(),
    startServer: vi.fn(),
    stopServer: vi.fn(),
    restartServer: vi.fn(),
    deleteServer: vi.fn(),
    registerServer: vi.fn(),
  },
}));

vi.mock('../../src/ui/lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/lib/api.js')>();
  return { ...actual, api: apiMock };
});

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CatalogPage } from '../../src/ui/pages/Catalog.js';
import type {
  ServerRecord,
  ServerSourceInfo,
  UpdateCheckResult,
} from '../../src/core/types.js';

function makeServer(overrides: Partial<ServerRecord> & { id: string; name: string }): ServerRecord {
  return {
    runtime: 'node',
    transport: 'stdio',
    status: 'running',
    command: 'node',
    args: ['server.js'],
    url: null,
    env: {},
    manifest: null,
    highPrivilegeTools: [],
    approvalRequiredTools: [],
    envFile: null,
    delegationSupported: false,
    sourceUrl: null,
    workDir: null,
    lastError: null,
    pid: 100,
    createdAt: '2026-10-29T17:00:00.000Z',
    updatedAt: '2026-10-29T17:05:00.000Z',
    ...overrides,
  };
}

const brainServer = makeServer({
  id: 'srv_brain',
  name: 'brain',
  manifest: { name: 'brain', version: '1.0.0', runtime: 'node', start_command: 'node server.js' },
});
const echoServer = makeServer({
  id: 'srv_echo',
  name: 'gateway-echo',
  manifest: { name: 'gateway-echo', version: '2.0.0', runtime: 'node', start_command: 'node echo.js' },
});
const localServer = makeServer({ id: 'srv_local', name: 'local-tool' });

const brainSource: ServerSourceInfo = {
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
  changelogUrl: 'https://github.com/example/brain-mcp/compare/a1b2c3d4e5f6...d4e5f6a7b8c9',
};

const echoSource: ServerSourceInfo = {
  serverId: 'srv_echo',
  sourceKind: 'catalog',
  catalogSourceId: 'cat_1',
  catalogEntryId: 'echo-mcp',
  repoUrl: 'https://github.com/example/echo-mcp',
  requestedRef: 'main',
  installedVersion: '2.0.0',
  installedCommit: 'fff000000000',
  latestVersion: '2.0.0',
  latestCommit: 'fff000000000',
  latestRef: 'main',
  updateAvailable: false,
  checkedAt: '2026-10-29T19:00:00.000Z',
  checkError: null,
  changelogUrl: null,
};

function checkResult(overrides: Partial<UpdateCheckResult>): UpdateCheckResult {
  return {
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
    ...overrides,
  };
}

beforeEach(() => {
  apiMock.listServers.mockResolvedValue([brainServer, echoServer, localServer]);
  apiMock.listCatalogSources.mockResolvedValue([]);
  apiMock.listServerUpdates.mockResolvedValue([brainSource, echoSource]);
  apiMock.listConfigProfiles.mockResolvedValue([]);
  apiMock.checkUpdates.mockResolvedValue([
    checkResult({}),
    checkResult({
      serverId: 'srv_echo',
      serverName: 'gateway-echo',
      status: 'up-to-date',
      updateAvailable: false,
      fromVersion: '2.0.0',
      toVersion: '2.0.0',
      fromCommit: 'fff000000000',
      toCommit: 'fff000000000',
    }),
  ]);
  apiMock.checkServerUpdate.mockResolvedValue(checkResult({}));
  apiMock.updateServer.mockResolvedValue({
    server: brainServer,
    before: { version: '1.0.0', commit: 'a1b2c3d4e5f6' },
    after: { version: '1.2.0', commit: 'd4e5f6a7b8c9' },
    test: { ok: true, toolCount: 2, tools: ['brain_search', 'brain_write'], latencyMs: 3.1, error: null },
    changed: true,
  });
  apiMock.serverTools.mockResolvedValue({
    serverId: 'srv_brain',
    approvalRequiredTools: [],
    highPrivilegeTools: [],
    tools: [],
    total: 0,
  });
  apiMock.serverLogs.mockResolvedValue([]);
  apiMock.testServer.mockResolvedValue({ ok: true, toolCount: 2, tools: [], latencyMs: 1, error: null });
  apiMock.updateServerPolicy.mockResolvedValue(brainServer);
  apiMock.startServer.mockResolvedValue(brainServer);
  apiMock.stopServer.mockResolvedValue(brainServer);
  apiMock.restartServer.mockResolvedValue(brainServer);
  apiMock.deleteServer.mockResolvedValue(true);
  apiMock.registerServer.mockResolvedValue(brainServer);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderInstalled() {
  return render(<CatalogPage initialTab="installed" />);
}

describe('Installed tab — update manager', () => {
  it('shows installed version and update status badges (available / up to date / local)', async () => {
    renderInstalled();

    expect(await screen.findByText('brain')).toBeTruthy();
    expect(await screen.findByText('update → v1.2.0')).toBeTruthy();
    expect(screen.getByText('up to date')).toBeTruthy();
    expect(screen.getByText('local')).toBeTruthy();
    // Version column: tracked versions come from the update source.
    expect(screen.getByText('v1.0.0')).toBeTruthy();
    expect(screen.getByText('v2.0.0')).toBeTruthy();
    expect(apiMock.listServerUpdates).toHaveBeenCalledTimes(1);

    const brainRow = screen.getByText('brain').closest('tr') as HTMLElement;
    expect(within(brainRow).getByText('Check')).toBeTruthy();
    expect(within(brainRow).getByRole('button', { name: 'Update' })).toBeTruthy();
    const localRow = screen.getByText('local-tool').closest('tr') as HTMLElement;
    expect(within(localRow).queryByRole('button', { name: 'Update' })).toBeNull();
  });

  it('checks all tracked servers and can re-check a single row', async () => {
    renderInstalled();
    await screen.findByText('brain');

    fireEvent.click(screen.getByRole('button', { name: 'Check all' }));

    await waitFor(() => expect(apiMock.checkUpdates).toHaveBeenCalledTimes(1));
    expect(apiMock.checkUpdates.mock.calls[0]).toEqual([]);
    await waitFor(() => expect(apiMock.listServerUpdates).toHaveBeenCalledTimes(2));

    const brainRow = screen.getByText('brain').closest('tr') as HTMLElement;
    fireEvent.click(within(brainRow).getByRole('button', { name: 'Check' }));

    await waitFor(() => expect(apiMock.checkServerUpdate).toHaveBeenCalledWith('srv_brain'));
  });

  it('confirms an update with version/commit/changelog details and calls updateServer', async () => {
    renderInstalled();
    await screen.findByText('brain');

    const brainRow = screen.getByText('brain').closest('tr') as HTMLElement;
    fireEvent.click(within(brainRow).getByRole('button', { name: 'Update' }));

    expect(await screen.findByText('Update “brain”')).toBeTruthy();
    expect(screen.getByText('v1.2.0')).toBeTruthy();
    expect(screen.getByText(/commits a1b2c3d → d4e5f6a/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Changelog/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Update now' }));

    await waitFor(() =>
      expect(apiMock.updateServer).toHaveBeenCalledWith('srv_brain', { restart: true, test: true }),
    );
    expect(await screen.findByText('Update complete')).toBeTruthy();
    expect(screen.getByText(/2 tools/)).toBeTruthy();
    // The server list and update state are refreshed after a successful update.
    await waitFor(() => expect(apiMock.listServers).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(apiMock.listServerUpdates).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText('Update “brain”')).toBeNull());
  });

  it('shows a check error badge with the error tooltip text', async () => {
    apiMock.listServerUpdates.mockResolvedValue([
      { ...brainSource, checkError: 'clone failed: repository not found' },
    ]);
    renderInstalled();

    expect(await screen.findByText('error')).toBeTruthy();
    expect(screen.getByText('clone failed: repository not found')).toBeTruthy();
  });
});
