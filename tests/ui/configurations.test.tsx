// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listConfigProfiles: vi.fn(),
    listServers: vi.fn(),
    listVaultSecrets: vi.fn(),
    createConfigProfile: vi.fn(),
    updateConfigProfile: vi.fn(),
    deleteConfigProfile: vi.fn(),
    applyConfigProfile: vi.fn(),
    detachConfigProfile: vi.fn(),
    migrateEnvFile: vi.fn(),
    listCatalogSources: vi.fn(),
    listServerUpdates: vi.fn(),
    serverTools: vi.fn(),
    serverLogs: vi.fn(),
    testServer: vi.fn(),
    updateServerPolicy: vi.fn(),
    startServer: vi.fn(),
    stopServer: vi.fn(),
    restartServer: vi.fn(),
    deleteServer: vi.fn(),
    registerServer: vi.fn(),
    checkUpdates: vi.fn(),
    checkServerUpdate: vi.fn(),
    updateServer: vi.fn(),
    getCredentialProviders: vi.fn(),
    configureCredentialProvider: vi.fn(),
    testCredentialProvider: vi.fn(),
    setDefaultCredentialProvider: vi.fn(),
    listCredentialItems: vi.fn(),
    revealCredential: vi.fn(),
  },
}));

vi.mock('../../src/ui/lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/lib/api.js')>();
  return { ...actual, api: apiMock };
});

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfigurationsPage } from '../../src/ui/pages/Configurations.js';
import { CatalogPage } from '../../src/ui/pages/Catalog.js';
import type {
  ConfigProfileApplyResult,
  ConfigProfileSummary,
  ServerRecord,
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
    configProfileIds: [],
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

const n8nServer = makeServer({
  id: 'srv_n8n',
  name: 'n8n',
  envFile: '/home/example/.config/n8n/mcp.env',
  configProfileIds: ['cfg_1'],
});
const otherServer = makeServer({ id: 'srv_other', name: 'other-tool', status: 'stopped' });
const thirdServer = makeServer({ id: 'srv_third', name: 'third-tool', status: 'stopped' });

function makeProfile(overrides: Partial<ConfigProfileSummary> = {}): ConfigProfileSummary {
  return {
    id: 'cfg_1',
    name: 'Internal services',
    description: 'Shared n8n endpoint + API key',
    entries: [
      { key: 'N8N_BASE_URL', source: 'encrypted', ref: null },
      { key: 'N8N_API_KEY', source: 'vault-ref', ref: 'N8N_API_KEY' },
    ],
    headers: [{ key: 'X-Api-Key', source: 'vault-ref', ref: 'N8N_API_KEY' }],
    createdAt: '2026-10-29T18:00:00.000Z',
    updatedAt: '2026-10-29T18:30:00.000Z',
    attachedServerIds: ['srv_n8n'],
    ...overrides,
  };
}

const profile = makeProfile();

function applyResult(overrides: Partial<ConfigProfileApplyResult> = {}): ConfigProfileApplyResult {
  return {
    serverId: 'srv_n8n',
    serverName: 'n8n',
    applied: true,
    restarted: true,
    test: { ok: true, toolCount: 5, tools: ['n8n_list', 'n8n_run'], latencyMs: 2.4, error: null },
    error: null,
    ...overrides,
  };
}

beforeEach(() => {
  apiMock.listConfigProfiles.mockResolvedValue([profile]);
  apiMock.listServers.mockResolvedValue([n8nServer, otherServer, thirdServer]);
  apiMock.listVaultSecrets.mockResolvedValue({
    enabled: true,
    secrets: [
      { name: 'N8N_API_KEY', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
      { name: 'DB_URL', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
    ],
  });
  apiMock.createConfigProfile.mockImplementation(async (input: { name: string }) =>
    makeProfile({ id: 'cfg_new', name: input.name, attachedServerIds: [] }),
  );
  apiMock.updateConfigProfile.mockImplementation(async (id: string, input: { name: string }) =>
    makeProfile({ id, name: input.name }),
  );
  apiMock.deleteConfigProfile.mockResolvedValue(true);
  apiMock.applyConfigProfile.mockResolvedValue([
    applyResult({}),
    applyResult({ serverId: 'srv_other', serverName: 'other-tool' }),
  ]);
  apiMock.detachConfigProfile.mockResolvedValue(true);
  apiMock.migrateEnvFile.mockResolvedValue(makeProfile({ id: 'cfg_migrated', name: 'Migrated n8n config' }));
  apiMock.listCatalogSources.mockResolvedValue([]);
  apiMock.listServerUpdates.mockResolvedValue([]);
  apiMock.serverTools.mockResolvedValue({
    serverId: 'srv_n8n',
    approvalRequiredTools: [],
    highPrivilegeTools: [],
    tools: [],
    total: 0,
  });
  apiMock.serverLogs.mockResolvedValue([]);
  apiMock.testServer.mockResolvedValue({ ok: true, toolCount: 1, tools: [], latencyMs: 1, error: null });
  apiMock.updateServerPolicy.mockResolvedValue(n8nServer);
  apiMock.startServer.mockResolvedValue(n8nServer);
  apiMock.stopServer.mockResolvedValue(n8nServer);
  apiMock.restartServer.mockResolvedValue(n8nServer);
  apiMock.deleteServer.mockResolvedValue(true);
  apiMock.registerServer.mockResolvedValue(n8nServer);
  apiMock.checkUpdates.mockResolvedValue([]);
  apiMock.checkServerUpdate.mockRejectedValue(new Error('not configured'));
  apiMock.updateServer.mockRejectedValue(new Error('not configured'));
  apiMock.getCredentialProviders.mockResolvedValue({
    providers: [
      {
        id: 'vaultwarden',
        name: 'Vaultwarden',
        kind: 'password-manager',
        configured: true,
        isDefault: true,
        available: true,
        state: 'connected',
        message: 'connected',
        details: {},
      },
      {
        id: 'onepassword',
        name: '1Password',
        kind: 'password-manager',
        configured: false,
        isDefault: false,
        available: true,
        state: 'not-configured',
        message: '',
        details: {},
      },
    ],
    descriptors: [
      { id: 'vaultwarden', name: 'Vaultwarden', description: 'Default', docsHint: '', fields: [] },
      { id: 'onepassword', name: '1Password', description: 'Alternative', docsHint: '', fields: [] },
    ],
    defaultProvider: 'vaultwarden',
  });
  apiMock.listCredentialItems.mockResolvedValue([
    {
      provider: 'vaultwarden',
      id: 'alias-n8n',
      name: 'n8n API key',
      username: null,
      category: 'API',
      urls: [],
      fields: ['password', 'token'],
    },
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Configurations page', () => {
  it('lists profiles with encrypted/vault counts and no env-file field', async () => {
    render(<ConfigurationsPage />);

    expect(await screen.findByText('Internal services')).toBeTruthy();
    expect(screen.getByText('Shared n8n endpoint + API key')).toBeTruthy();
    expect(screen.getByText('2 env')).toBeTruthy();
    expect(screen.getByText('1 encrypted')).toBeTruthy();
    expect(screen.getByText('1 vault ref')).toBeTruthy();
    expect(screen.getByText('1 attached')).toBeTruthy();

    // Gateway-managed only: no env-file input anywhere.
    expect(screen.queryByText('Env file')).toBeNull();
    expect(screen.queryByPlaceholderText(/mcp\.env/)).toBeNull();
  });

  it('creates a profile with an encrypted value and a vault reference', async () => {
    render(<ConfigurationsPage />);
    await screen.findByText('Internal services');

    fireEvent.click(screen.getByRole('button', { name: 'New profile' }));
    expect(await screen.findByText('New configuration profile')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Internal services'), { target: { value: 'Test profile' } });

    // Row 1: encrypted value (write-only password input).
    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));
    fireEvent.change(screen.getByLabelText('Environment variable key'), { target: { value: 'N8N_API_URL' } });
    const valueInput = screen.getByLabelText('Environment variable value') as HTMLInputElement;
    expect(valueInput.type).toBe('password');
    fireEvent.change(valueInput, { target: { value: 'http://10.0.0.5:5678' } });
    expect(screen.getByText('encrypted')).toBeTruthy();

    // Row 2: reference an existing Vault-page secret.
    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));
    const keyInputs = screen.getAllByLabelText('Environment variable key');
    fireEvent.change(keyInputs[1] as HTMLElement, { target: { value: 'N8N_API_KEY' } });
    const sourceSelects = screen.getAllByLabelText('Environment variable value source');
    fireEvent.change(sourceSelects[1] as HTMLElement, { target: { value: 'vault-ref' } });
    fireEvent.change(screen.getByLabelText('Environment variable vault secret'), {
      target: { value: 'N8N_API_KEY' },
    });
    expect(screen.getByText('vault: N8N_API_KEY')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));

    await waitFor(() => expect(apiMock.createConfigProfile).toHaveBeenCalledTimes(1));
    expect(apiMock.createConfigProfile).toHaveBeenCalledWith({
      name: 'Test profile',
      description: null,
      entries: [
        { key: 'N8N_API_URL', value: 'http://10.0.0.5:5678' },
        { key: 'N8N_API_KEY', secretRef: 'N8N_API_KEY' },
      ],
      headers: [],
    });
  });

  it('edits an existing profile showing keys/sources only and rotates a blank value', async () => {
    render(<ConfigurationsPage />);
    await screen.findByText('Internal services');

    fireEvent.click(within(screen.getByText('Internal services').closest('article') as HTMLElement).getByRole('button', { name: 'Edit' }));

    expect(await screen.findByText('Edit Internal services')).toBeTruthy();
    const keyInputs = screen.getAllByLabelText('Environment variable key') as HTMLInputElement[];
    expect(keyInputs.map((input) => input.value)).toEqual(['N8N_BASE_URL', 'N8N_API_KEY']);
    const valueInput = screen.getByLabelText('Environment variable value') as HTMLInputElement;
    expect(valueInput.value).toBe('');
    expect(valueInput.placeholder).toBe('leave blank to keep current');

    fireEvent.change(valueInput, { target: { value: 'http://10.0.0.9:5678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() => expect(apiMock.updateConfigProfile).toHaveBeenCalledTimes(1));
    expect(apiMock.updateConfigProfile).toHaveBeenCalledWith('cfg_1', {
      name: 'Internal services',
      description: 'Shared n8n endpoint + API key',
      entries: [
        { key: 'N8N_BASE_URL', value: 'http://10.0.0.9:5678' },
        { key: 'N8N_API_KEY', secretRef: 'N8N_API_KEY' },
      ],
      headers: [{ key: 'X-Api-Key', secretRef: 'N8N_API_KEY' }],
    });
  });

  it('applies a profile to multiple selected servers with restart/test toggles', async () => {
    render(<ConfigurationsPage />);
    await screen.findByText('Internal services');

    fireEvent.click(within(screen.getByText('Internal services').closest('article') as HTMLElement).getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Apply “Internal services”')).toBeTruthy();

    // Attached server starts selected; add another.
    expect((screen.getByRole('checkbox', { name: /n8n/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /other-tool/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Apply profile' }));

    await waitFor(() => expect(apiMock.applyConfigProfile).toHaveBeenCalledTimes(1));
    expect(apiMock.applyConfigProfile).toHaveBeenCalledWith('cfg_1', {
      serverIds: expect.arrayContaining(['srv_n8n', 'srv_other']),
      restart: true,
      test: true,
    });
    expect(await screen.findByText('Profile applied')).toBeTruthy();
    expect(screen.getAllByText('attached').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/5 tools/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText('Apply “Internal services”')).toBeNull());
  });

  it('builds a credentialRef payload from a password-manager item row', async () => {
    render(<ConfigurationsPage />);
    await screen.findByText('Internal services');

    fireEvent.click(screen.getByRole('button', { name: 'New profile' }));
    await screen.findByText('New configuration profile');
    fireEvent.change(screen.getByPlaceholderText('Internal services'), { target: { value: 'PM profile' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));
    fireEvent.change(screen.getByLabelText('Environment variable key'), { target: { value: 'N8N_TOKEN' } });
    fireEvent.change(screen.getByLabelText('Environment variable value source'), {
      target: { value: 'credential-ref' },
    });

    // Provider defaults to Vaultwarden; pick the alias and a field.
    const itemSelect = await screen.findByLabelText('Environment variable credential item');
    await waitFor(() =>
      expect(within(itemSelect).getByRole('option', { name: /n8n API key/ })).toBeTruthy(),
    );
    fireEvent.change(itemSelect, { target: { value: 'alias-n8n' } });
    fireEvent.change(screen.getByLabelText('Environment variable credential field'), {
      target: { value: 'token' },
    });
    expect(screen.getByText('vaultwarden: alias-n8n')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));

    await waitFor(() => expect(apiMock.createConfigProfile).toHaveBeenCalledTimes(1));
    expect(apiMock.createConfigProfile).toHaveBeenCalledWith({
      name: 'PM profile',
      description: null,
      entries: [
        {
          key: 'N8N_TOKEN',
          credentialRef: { provider: 'vaultwarden', itemId: 'alias-n8n', field: 'token' },
        },
      ],
      headers: [],
    });
    expect(apiMock.listCredentialItems).toHaveBeenCalled();
  });

  it('deletes a profile after confirmation', async () => {
    render(<ConfigurationsPage />);
    await screen.findByText('Internal services');

    fireEvent.click(within(screen.getByText('Internal services').closest('article') as HTMLElement).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Delete configuration profile')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete profile' }));

    await waitFor(() => expect(apiMock.deleteConfigProfile).toHaveBeenCalledWith('cfg_1'));
    await waitFor(() => expect(apiMock.listConfigProfiles).toHaveBeenCalledTimes(2));
  });
});

describe('Server drawer — updates and configuration profiles', () => {
  it('shows attached chips, applies a profile, detaches and migrates a legacy env file', async () => {
    render(<CatalogPage initialTab="installed" />);
    await screen.findByText('n8n');

    const row = screen.getByText('n8n').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Details' }));

    expect(await screen.findByText('Configuration profiles')).toBeTruthy();
    expect(await screen.findByText('Source & updates')).toBeTruthy();
    expect(screen.getByText('Legacy env file detected')).toBeTruthy();
    expect(screen.queryByText('Env file')).toBeNull();

    // Attached chip + detach.
    expect(screen.getByText('Internal services')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Detach Internal services' }));
    await waitFor(() => expect(apiMock.detachConfigProfile).toHaveBeenCalledWith('cfg_1', 'srv_n8n'));

    // Apply & test from the drawer (wait out the profile-list refresh after detach).
    fireEvent.click(await screen.findByRole('button', { name: 'Apply & test' }));
    await waitFor(() =>
      expect(apiMock.applyConfigProfile).toHaveBeenCalledWith('cfg_1', {
        serverIds: ['srv_n8n'],
        restart: true,
        test: true,
      }),
    );
    expect((await screen.findAllByText(/5 tools/)).length).toBeGreaterThan(0);

    // Legacy env file migration.
    fireEvent.click(screen.getByRole('button', { name: 'Migrate to encrypted profile' }));
    await waitFor(() => expect(apiMock.migrateEnvFile).toHaveBeenCalledWith('srv_n8n'));
  });
});
