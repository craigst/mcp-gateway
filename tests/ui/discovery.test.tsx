// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listServers: vi.fn(),
    listCatalogSources: vi.fn(),
    listCatalogEntries: vi.fn(),
    listDiscoverySources: vi.fn(),
    scanDiscovery: vi.fn(),
    importDiscoveryEntry: vi.fn(),
    serverTools: vi.fn(),
    serverLogs: vi.fn(),
    testServer: vi.fn(),
    updateServerPolicy: vi.fn(),
    startServer: vi.fn(),
    stopServer: vi.fn(),
    restartServer: vi.fn(),
    deleteServer: vi.fn(),
    addCatalogSource: vi.fn(),
    deleteCatalogSource: vi.fn(),
    installCatalogEntry: vi.fn(),
    importCatalogUrl: vi.fn(),
    registerServer: vi.fn(),
  },
}));

vi.mock('../../src/ui/lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/lib/api.js')>();
  return { ...actual, api: apiMock };
});

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CatalogPage } from '../../src/ui/pages/Catalog.js';
import type { HarnessEntry, HarnessSourceInfo, ServerRecord } from '../../src/core/types.js';

const server: ServerRecord = {
  id: 'srv_brain',
  name: 'brain',
  runtime: 'node',
  transport: 'stdio',
  status: 'running',
  command: 'node',
  args: ['/opt/brain-mcp.js'],
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
  pid: 4242,
  createdAt: '2026-10-29T17:00:00.000Z',
  updatedAt: '2026-10-29T17:05:00.000Z',
};

const harnessSources: HarnessSourceInfo[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    configPath: '/home/example/.claude.json',
    exists: true,
    serverCount: 1,
  },
  {
    id: 'opencode',
    label: 'opencode',
    configPath: '/home/example/.config/opencode/opencode.json',
    exists: false,
    serverCount: 0,
  },
];

const discoveredEntry: HarnessEntry = {
  id: 'claude:brain',
  harness: 'claude',
  name: 'brain',
  transport: 'stdio',
  command: 'node',
  args: ['/opt/brain-mcp.js'],
  url: null,
  envKeys: ['BRAIN_API_KEY'],
  envFile: null,
  headerKeys: [],
  enabled: true,
};

beforeEach(() => {
  apiMock.listServers.mockResolvedValue([server]);
  apiMock.listCatalogSources.mockResolvedValue([]);
  apiMock.listCatalogEntries.mockResolvedValue({ source: null, entries: [] });
  apiMock.listDiscoverySources.mockResolvedValue(harnessSources);
  apiMock.scanDiscovery.mockResolvedValue({
    sources: harnessSources,
    entries: [discoveredEntry],
    errors: [{ harness: 'opencode', error: 'config file not found' }],
  });
  apiMock.importDiscoveryEntry.mockResolvedValue(server);
  apiMock.serverTools.mockResolvedValue({
    serverId: 'srv_brain',
    approvalRequiredTools: [],
    highPrivilegeTools: [],
    tools: [],
    total: 0,
  });
  apiMock.serverLogs.mockResolvedValue([]);
  apiMock.testServer.mockResolvedValue({ ok: true, toolCount: 0, tools: [], latencyMs: 1, error: null });
  apiMock.updateServerPolicy.mockResolvedValue(server);
  apiMock.startServer.mockResolvedValue(server);
  apiMock.stopServer.mockResolvedValue(server);
  apiMock.restartServer.mockResolvedValue(server);
  apiMock.deleteServer.mockResolvedValue(true);
  apiMock.addCatalogSource.mockResolvedValue(null);
  apiMock.deleteCatalogSource.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openImportTab(): Promise<void> {
  render(<CatalogPage initialTab="import" />);
  expect(await screen.findByText('Claude Code')).toBeTruthy();
}

async function scan(): Promise<void> {
  fireEvent.click(screen.getAllByRole('button', { name: 'Scan harnesses' })[0] as HTMLElement);
  expect(await screen.findByText('brain')).toBeTruthy();
}

describe('CatalogPage — Import tab (harness discovery)', () => {
  it('renders detected harness cards and scanned entries with env key names', async () => {
    await openImportTab();

    expect(screen.getByText('/home/example/.claude.json')).toBeTruthy();
    expect(screen.getByText('1 configured server')).toBeTruthy();
    expect(screen.getByText('not found')).toBeTruthy();

    await scan();

    expect(screen.getByText('BRAIN_API_KEY')).toBeTruthy();
    expect(screen.getByText('stdio')).toBeTruthy();
    expect(screen.getByText('node /opt/brain-mcp.js')).toBeTruthy();
    // Harness-level errors from the scan are surfaced, not swallowed.
    expect(screen.getByText('config file not found')).toBeTruthy();
    expect(apiMock.scanDiscovery).toHaveBeenCalledWith();
  });

  it('imports a discovered server in one click and shows the created server', async () => {
    await openImportTab();
    await scan();

    const row = screen.getByText('brain').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(apiMock.importDiscoveryEntry).toHaveBeenCalledTimes(1));
    expect(apiMock.importDiscoveryEntry).toHaveBeenCalledWith({
      harness: 'claude',
      name: 'brain',
      transport: 'stdio',
      command: 'node',
      args: ['/opt/brain-mcp.js'],
      url: null,
      env: {},
      envFile: null,
      highPrivilegeTools: [],
      approvalRequiredTools: [],
    });

    expect(await screen.findByRole('button', { name: 'View server' })).toBeTruthy();
    expect(screen.getByText('Imported “brain”')).toBeTruthy();
  });

  it('opens the options dialog to supply env values and approval tools', async () => {
    await openImportTab();
    await scan();

    const row = screen.getByText('brain').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Options' }));

    expect(await screen.findByText('Import “brain”')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('BRAIN_API_KEY value'), { target: { value: 'example-secret' } });
    fireEvent.change(screen.getByPlaceholderText('deliver_credential'), {
      target: { value: 'vault_deliver_credential' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Import server' }));

    await waitFor(() => expect(apiMock.importDiscoveryEntry).toHaveBeenCalledTimes(1));
    expect(apiMock.importDiscoveryEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: 'claude',
        name: 'brain',
        env: { BRAIN_API_KEY: 'example-secret' },
        envFile: null,
        approvalRequiredTools: ['vault_deliver_credential'],
      }),
    );
  });
});
