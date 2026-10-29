// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listServers: vi.fn(),
    listCatalogSources: vi.fn(),
    listCatalogEntries: vi.fn(),
    addCatalogSource: vi.fn(),
    deleteCatalogSource: vi.fn(),
    installCatalogEntry: vi.fn(),
    importCatalogUrl: vi.fn(),
    testServer: vi.fn(),
    serverTools: vi.fn(),
    updateServerPolicy: vi.fn(),
    startServer: vi.fn(),
    stopServer: vi.fn(),
    restartServer: vi.fn(),
    deleteServer: vi.fn(),
    serverLogs: vi.fn(),
    registerServer: vi.fn(),
    listDiscoverySources: vi.fn(),
    scanDiscovery: vi.fn(),
    importDiscoveryEntry: vi.fn(),
    listServerUpdates: vi.fn(),
    checkUpdates: vi.fn(),
    checkServerUpdate: vi.fn(),
    updateServer: vi.fn(),
    listConfigProfiles: vi.fn(),
    migrateEnvFile: vi.fn(),
    detachConfigProfile: vi.fn(),
    applyConfigProfile: vi.fn(),
  },
}));

vi.mock('../../src/ui/lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/lib/api.js')>();
  return { ...actual, api: apiMock };
});

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CatalogPage } from '../../src/ui/pages/Catalog.js';
import type {
  CatalogEntry,
  CatalogSource,
  ServerRecord,
} from '../../src/core/types.js';

function makeServer(overrides: Partial<ServerRecord> & { id: string; name: string }): ServerRecord {
  return {
    runtime: 'node',
    transport: 'stdio',
    status: 'stopped',
    command: 'node',
    args: ['server.mjs'],
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
    pid: null,
    createdAt: '2026-10-29T17:00:00.000Z',
    updatedAt: '2026-10-29T17:05:00.000Z',
    ...overrides,
  };
}

const echoServer = makeServer({ id: 'srv_echo', name: 'gateway-echo', status: 'running', pid: 2211 });
const brainServer = makeServer({ id: 'srv_brain', name: 'brain', status: 'running', pid: 3311 });

const source: CatalogSource = {
  id: 'cat_ab12',
  label: 'Internal MCP catalog',
  kind: 'dsh-umbrella',
  repoUrl: 'https://github.com/example/private-mcp-catalog',
  ref: 'main',
  subpath: null,
  tokenSecretName: 'CATALOG_cat_ab12_TOKEN',
  createdAt: '2026-10-29T17:00:00.000Z',
  updatedAt: '2026-10-29T17:00:00.000Z',
};

const supportedEntry: CatalogEntry = {
  id: 'brain-mcp',
  sourceId: 'cat_ab12',
  name: 'brain-mcp',
  repoUrl: 'https://github.com/example/brain-mcp',
  ref: 'v1.1.0',
  entry: 'brain-mcp.js',
  kind: 'mcp',
  serverName: 'brain',
  description: 'Knowledge-base MCP server with note search and write tools.',
  installCommand: './scripts/wire.sh --deploy',
  supported: true,
  unsupportedReason: null,
  installedServerId: null,
};

const unsupportedEntry: CatalogEntry = {
  id: 'legacy-mcp',
  sourceId: 'cat_ab12',
  name: 'legacy-mcp',
  repoUrl: 'https://github.com/example/legacy-mcp',
  ref: null,
  entry: null,
  kind: 'mcp',
  serverName: null,
  description: 'Legacy server with no detectable entry point.',
  installCommand: null,
  supported: false,
  unsupportedReason: 'No manifest, package.json bin/main or Python entry detected.',
  installedServerId: null,
};

const installedEntry: CatalogEntry = {
  id: 'installed-mcp',
  sourceId: 'cat_ab12',
  name: 'installed-mcp',
  repoUrl: 'https://github.com/example/installed-mcp',
  ref: 'main',
  entry: 'index.js',
  kind: 'bundle',
  serverName: 'installed',
  description: 'Already running bundle.',
  installCommand: null,
  supported: true,
  unsupportedReason: null,
  installedServerId: 'srv_existing',
};

const installResult = {
  server: {
    ...brainServer,
    id: 'srv_brain',
    name: 'brain',
  },
  test: {
    ok: true,
    toolCount: 2,
    tools: ['brain_whoami', 'brain_search'],
    latencyMs: 42.1,
    error: null,
  },
  buildLogTail: ['npm install --omit=dev', 'build ok'],
};

beforeEach(() => {
  apiMock.listServers.mockResolvedValue([echoServer, brainServer]);
  apiMock.listCatalogSources.mockResolvedValue([source]);
  apiMock.listCatalogEntries.mockResolvedValue({
    source,
    entries: [supportedEntry, unsupportedEntry, installedEntry],
  });
  apiMock.addCatalogSource.mockResolvedValue({
    ...source,
    id: 'cat_new',
    label: 'Private plugins',
    kind: 'github-repo',
    repoUrl: 'https://github.com/example/private-plugins',
  });
  apiMock.deleteCatalogSource.mockResolvedValue(true);
  apiMock.installCatalogEntry.mockResolvedValue(installResult);
  apiMock.importCatalogUrl.mockResolvedValue(installResult);
  apiMock.testServer.mockResolvedValue({
    ok: true,
    toolCount: 2,
    tools: ['brain_whoami'],
    latencyMs: 12.5,
    error: null,
  });
  apiMock.serverTools.mockResolvedValue({
    serverId: 'srv_brain',
    approvalRequiredTools: [],
    highPrivilegeTools: [],
    tools: [
      {
        id: 'srv_brain:brain_whoami',
        name: 'brain_whoami',
        description: 'Who am I',
        highPrivilege: false,
        approvalRequired: false,
      },
    ],
    total: 1,
  });
  apiMock.updateServerPolicy.mockResolvedValue(brainServer);
  apiMock.startServer.mockResolvedValue({ ...brainServer, status: 'running' });
  apiMock.stopServer.mockResolvedValue({ ...brainServer, status: 'stopped' });
  apiMock.restartServer.mockResolvedValue(brainServer);
  apiMock.deleteServer.mockResolvedValue(true);
  apiMock.serverLogs.mockResolvedValue([]);
  apiMock.registerServer.mockResolvedValue(brainServer);
  apiMock.listDiscoverySources.mockResolvedValue([]);
  apiMock.scanDiscovery.mockResolvedValue({ sources: [], entries: [], errors: [] });
  apiMock.importDiscoveryEntry.mockResolvedValue(brainServer);
  apiMock.listServerUpdates.mockResolvedValue([]);
  apiMock.checkUpdates.mockResolvedValue([]);
  apiMock.checkServerUpdate.mockRejectedValue(new Error('not configured'));
  apiMock.updateServer.mockRejectedValue(new Error('not configured'));
  apiMock.listConfigProfiles.mockResolvedValue([]);
  apiMock.migrateEnvFile.mockRejectedValue(new Error('not configured'));
  apiMock.detachConfigProfile.mockResolvedValue(true);
  apiMock.applyConfigProfile.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderCatalog() {
  return render(<CatalogPage />);
}

describe('CatalogPage — Installed and Discover tabs', () => {
  it('lists installed servers and shows compatible and unsupported catalog entries', async () => {
    renderCatalog();

    expect(await screen.findByText('gateway-echo')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /Discover/ }));

    expect(await screen.findByText('brain-mcp')).toBeTruthy();
    expect(screen.getByText('legacy-mcp')).toBeTruthy();
    expect(screen.getByText(/No manifest, package.json/)).toBeTruthy();

    const legacyRow = screen.getByText('legacy-mcp').closest('tr');
    expect(legacyRow).not.toBeNull();
    const legacyInstall = within(legacyRow as HTMLElement).getByRole('button', { name: 'Install' });
    expect((legacyInstall as HTMLButtonElement).disabled).toBe(true);

    const installedRow = screen.getByText('installed-mcp').closest('tr');
    expect(within(installedRow as HTMLElement).getByText('installed')).toBeTruthy();
    expect(
      (within(installedRow as HTMLElement).getByRole('button', { name: 'Installed' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('validates env rows then installs an entry and shows the test result', async () => {
    renderCatalog();
    await screen.findByText('gateway-echo');

    fireEvent.click(screen.getByRole('tab', { name: /Discover/ }));
    const entryRow = (await screen.findByText('brain-mcp')).closest('tr') as HTMLElement;
    fireEvent.click(within(entryRow).getByRole('button', { name: 'Install' }));

    expect(await screen.findByText('Install brain-mcp')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));

    const keyInputs = screen.getAllByLabelText('Environment variable name');
    fireEvent.change(keyInputs[0] as HTMLElement, { target: { value: '1BAD' } });
    fireEvent.change(screen.getByLabelText('Environment variable value'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Install server' }));

    expect(await screen.findByText('Invalid environment variable name: 1BAD')).toBeTruthy();
    expect(apiMock.installCatalogEntry).not.toHaveBeenCalled();

    fireEvent.change(screen.getAllByLabelText('Environment variable name')[0] as HTMLElement, {
      target: { value: 'BRAIN_API_KEY' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Install server' }));

    await waitFor(() => expect(apiMock.installCatalogEntry).toHaveBeenCalledTimes(1));
    const installCall = apiMock.installCatalogEntry.mock.calls[0] as [
      Record<string, unknown>,
      { signal?: AbortSignal },
    ];
    expect(installCall[0]).toEqual({
      sourceId: 'cat_ab12',
      entryId: 'brain-mcp',
      name: 'brain',
      env: { BRAIN_API_KEY: 'secret' },
      envFile: null,
      start: true,
      test: true,
    });
    expect(installCall[1].signal).toBeDefined();

    expect(await screen.findByText('Installed and tested')).toBeTruthy();
    expect(screen.getByText('brain_whoami')).toBeTruthy();
    expect(screen.getByText(/npm install --omit=dev/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'View server' }));

    // Switches back to Installed and opens the server drawer (tool policy view).
    await waitFor(() => expect(apiMock.serverTools).toHaveBeenCalledWith('srv_brain'));
    expect(await screen.findByText('Tools & approval policy')).toBeTruthy();
  });

  it('explains how to connect a private catalog when there are no sources', async () => {
    apiMock.listCatalogSources.mockResolvedValue([]);
    renderCatalog();
    await screen.findByText('gateway-echo');

    fireEvent.click(screen.getByRole('tab', { name: /Discover/ }));

    expect(await screen.findByText('No catalog sources connected')).toBeTruthy();
    expect(screen.getByText(/AES-256 vault/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Connect a catalog source' }));
    expect(await screen.findByPlaceholderText('Internal MCP catalog')).toBeTruthy();
  });
});

describe('CatalogPage — Sources tab', () => {
  it('adds a token-backed private catalog source with the token only in the request body', async () => {
    renderCatalog();
    await screen.findByText('gateway-echo');

    fireEvent.click(screen.getByRole('tab', { name: /Sources/ }));
    expect(await screen.findByText('Internal MCP catalog')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Internal MCP catalog'), {
      target: { value: 'Private plugins' },
    });
    fireEvent.change(screen.getByPlaceholderText('https://github.com/example/private-mcp-catalog'), {
      target: { value: 'https://github.com/example/private-plugins' },
    });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'github-repo' } });
    fireEvent.change(screen.getByPlaceholderText('ghp_…'), { target: { value: 'ghp_test_token' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));

    await waitFor(() => expect(apiMock.addCatalogSource).toHaveBeenCalledTimes(1));
    expect(apiMock.addCatalogSource).toHaveBeenCalledWith({
      label: 'Private plugins',
      kind: 'github-repo',
      repoUrl: 'https://github.com/example/private-plugins',
      ref: 'main',
      subpath: null,
      token: 'ghp_test_token',
    });
    expect(await screen.findByText(/stored encrypted in the vault/)).toBeTruthy();
  });

  it('shows the empty state and entry count on source cards', async () => {
    renderCatalog();
    await screen.findByText('gateway-echo');

    fireEvent.click(screen.getByRole('tab', { name: /Sources/ }));
    expect(await screen.findByText('Internal MCP catalog')).toBeTruthy();
    // The card loads an entry count for the existing source.
    expect(await screen.findByText(/3 entries/)).toBeTruthy();

    cleanup();
    apiMock.listCatalogSources.mockResolvedValue([]);
    renderCatalog();
    await screen.findByText('gateway-echo');
    fireEvent.click(screen.getByRole('tab', { name: /Sources/ }));
    expect(await screen.findByText('No catalog sources yet')).toBeTruthy();
  });
});
