// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getSettings: vi.fn(),
    listBackups: vi.fn(),
    changePassword: vi.fn(),
    createBackup: vi.fn(),
    downloadBackup: vi.fn(),
    deleteBackup: vi.fn(),
    restoreBackup: vi.fn(),
    reinstallServer: vi.fn(),
    createKey: vi.fn(),
    getCredentialProviders: vi.fn(),
    configureCredentialProvider: vi.fn(),
    clearCredentialProvider: vi.fn(),
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
import { SettingsPage } from '../../src/ui/pages/Settings.js';
import type { BackupMetadata, GatewaySettingsInfo } from '../../src/core/types.js';

const settingsInfo: GatewaySettingsInfo = {
  version: '0.6.0',
  host: '0.0.0.0',
  port: 8080,
  dataDir: '/var/lib/mcp-gateway',
  dbPath: '/var/lib/mcp-gateway/gateway.db',
  reposDir: '/var/lib/mcp-gateway/repos',
  uiDistDir: 'ui/dist',
  vaultEnabled: true,
  gitImportEnabled: true,
  gitImportAllowedPrefixes: ['https://github.com/example/'],
  delegationMaxDepth: 3,
  autostart: 'none',
  logLevel: 'info',
  uiUsername: 'operator',
  userCount: 1,
  sessionCount: 2,
  setupRequired: false,
};

const backup: BackupMetadata = {
  id: 'b1',
  fileName: 'gateway-2026-10-29.mcpbak',
  createdAt: '2026-10-29T20:00:00.000Z',
  sizeBytes: 204800,
  gatewayVersion: '0.6.0',
  includeAudit: true,
  counts: {
    users: 1,
    keys: 3,
    servers: 2,
    tools: 7,
    profiles: 1,
    catalogSources: 1,
    secrets: 2,
    auditEntries: 42,
  },
};

const createdBackup: BackupMetadata = { ...backup, id: 'b2', fileName: 'gateway-new.mcpbak' };

const restoreResult = {
  usersRestored: 1,
  keysRestored: 3,
  serversRestored: 2,
  toolsRestored: 7,
  profilesRestored: 1,
  catalogSourcesRestored: 1,
  secretsRestored: 2,
  auditEntriesRestored: 42,
  reinstallRequired: [{ serverId: 'srv_brain', name: 'brain' }],
};

const reinstallResult = {
  server: { id: 'srv_brain', name: 'brain' },
  before: { version: '1.0.0', commit: 'a1b2c3d' },
  after: { version: '1.2.0', commit: 'd4e5f6a' },
  test: { ok: true, toolCount: 3, tools: ['brain_whoami'], latencyMs: 5, error: null },
  changed: true,
};

const credentialProviders = {
  providers: [
    {
      id: 'vaultwarden',
      name: 'Vaultwarden',
      kind: 'password-manager',
      configured: true,
      isDefault: true,
      available: true,
      state: 'connected',
      message: 'Connected to the Vaultwarden API.',
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
      message: 'Add a Connect host and service-account token.',
      details: {},
    },
    {
      id: 'gateway',
      name: 'Gateway vault',
      kind: 'builtin',
      configured: true,
      isDefault: false,
      available: true,
      state: 'connected',
      message: 'Built-in AES-256-GCM vault.',
      details: {},
    },
  ],
  descriptors: [
    {
      id: 'vaultwarden',
      name: 'Vaultwarden',
      description: 'Default password/API manager.',
      docsHint: 'Create an API key in Vaultwarden and paste it here.',
      fields: [
        { key: 'baseUrl', label: 'Host URL', secret: false, required: true, placeholder: 'https://vault.example' },
        { key: 'apiToken', label: 'API token', secret: true, required: true, hint: 'write-only' },
      ],
    },
    {
      id: 'onepassword',
      name: '1Password',
      description: 'Connect host + service-account token.',
      docsHint: 'Use a 1Password Connect host and service-account token.',
      fields: [
        { key: 'connectHost', label: 'Connect host', secret: false, required: true, placeholder: 'https://connect.example' },
        { key: 'serviceAccountToken', label: 'Service account token', secret: true, required: true },
      ],
    },
    {
      id: 'gateway',
      name: 'Gateway vault',
      description: 'Built-in encrypted vault.',
      docsHint: 'Manage secrets from the Vault page.',
      fields: [],
    },
  ],
  defaultProvider: 'vaultwarden',
};

const masterKey = {
  id: 'key_master_new',
  name: 'external-master',
  keyType: 'master',
  keyPrefix: 'mcp_master_new',
  serverGrants: [],
  delegationAllowed: true,
  escalationAllowed: true,
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-10-29T20:00:00.000Z',
  lastUsedAt: null,
};

beforeEach(() => {
  apiMock.getSettings.mockResolvedValue({
    settings: settingsInfo,
    account: { username: 'operator', sessionCount: 2 },
  });
  apiMock.listBackups.mockResolvedValue([backup]);
  apiMock.changePassword.mockResolvedValue({ ok: true });
  apiMock.createBackup.mockResolvedValue(createdBackup);
  apiMock.downloadBackup.mockResolvedValue({ blob: new Blob(['encrypted']), fileName: createdBackup.fileName });
  apiMock.deleteBackup.mockResolvedValue(true);
  apiMock.restoreBackup.mockResolvedValue(restoreResult);
  apiMock.reinstallServer.mockResolvedValue(reinstallResult);
  apiMock.createKey.mockResolvedValue({ key: masterKey, plaintext: 'mcp_master_SETTINGSKEY0123' });
  apiMock.getCredentialProviders.mockResolvedValue(credentialProviders);
  apiMock.configureCredentialProvider.mockResolvedValue(credentialProviders.providers[1]);
  apiMock.clearCredentialProvider.mockResolvedValue(credentialProviders.providers[1]);
  apiMock.testCredentialProvider.mockResolvedValue(credentialProviders.providers[0]);
  apiMock.setDefaultCredentialProvider.mockResolvedValue('onepassword');
  apiMock.listCredentialItems.mockResolvedValue([]);
  apiMock.revealCredential.mockResolvedValue({
    provider: 'vaultwarden',
    itemId: 'alias-n8n',
    field: 'password',
    value: 'revealed-value',
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderSettings(onReturnToLogin = vi.fn()) {
  const onNavigate = vi.fn();
  render(
    <SettingsPage
      username="operator"
      onNavigate={onNavigate}
      onReturnToLogin={onReturnToLogin}
    />,
  );
  return { onReturnToLogin, onNavigate };
}

describe('Settings page', () => {
  it('renders account, system information and the backup list', async () => {
    renderSettings();

    expect(await screen.findByText('System')).toBeTruthy();
    expect(screen.getByText('Backups')).toBeTruthy();
    expect(screen.getByText('0.6.0')).toBeTruthy();
    expect(screen.getByText('0.0.0.0:8080')).toBeTruthy();
    expect(screen.getByText('/var/lib/mcp-gateway/gateway.db')).toBeTruthy();
    expect(screen.getByText('Vault')).toBeTruthy();
    expect(screen.getAllByText('enabled').length).toBeGreaterThan(0);
    expect(screen.getByText(/https:\/\/github\.com\/example\//)).toBeTruthy();
    expect(screen.getByText('gateway-2026-10-29.mcpbak')).toBeTruthy();
    expect(screen.getByText(/2 servers/)).toBeTruthy();
    expect(screen.getAllByText(/AES-256-GCM/).length).toBeGreaterThan(0);
    expect(apiMock.getSettings).toHaveBeenCalledTimes(1);
    expect(apiMock.listBackups).toHaveBeenCalledTimes(1);
  });

  it('creates an encrypted backup and downloads it automatically', async () => {
    renderSettings();
    await screen.findByText('gateway-2026-10-29.mcpbak');

    fireEvent.click(screen.getByRole('button', { name: 'Create backup' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create encrypted backup' });
    fireEvent.change(within(dialog).getByLabelText('Account password'), {
      target: { value: 'correct-horse' },
    });
    expect(
      (within(dialog).getByRole('checkbox', { name: /Include audit log/ }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create backup' }));

    await waitFor(() =>
      expect(apiMock.createBackup).toHaveBeenCalledWith({ password: 'correct-horse', includeAudit: true }),
    );
    await waitFor(() => expect(apiMock.downloadBackup).toHaveBeenCalledWith('b2'));
    await waitFor(() => expect(apiMock.listBackups).toHaveBeenCalledTimes(2));
  });

  it('downloads and deletes existing backups', async () => {
    renderSettings();
    await screen.findByText('gateway-2026-10-29.mcpbak');

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(apiMock.downloadBackup).toHaveBeenCalledWith('b1'));

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete backup' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete backup' }));

    await waitFor(() => expect(apiMock.deleteBackup).toHaveBeenCalledWith('b1'));
    await waitFor(() => expect(apiMock.listBackups).toHaveBeenCalledTimes(2));
  });

  it('restores a backup, reinstalls missing servers and returns to login', async () => {
    const { onReturnToLogin } = renderSettings();
    await screen.findByText('gateway-2026-10-29.mcpbak');

    fireEvent.click(screen.getByRole('button', { name: 'Restore backup' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore from backup' });

    const file = new File([JSON.stringify({ format: 'mcp-gateway-backup', version: 1 })], 'gw.mcpbak', {
      type: 'application/json',
    });
    fireEvent.change(within(dialog).getByLabelText('Backup file'), { target: { files: [file] } });
    fireEvent.change(within(dialog).getByLabelText(/Backup password/), {
      target: { value: 'backup-pass' },
    });
    fireEvent.change(within(dialog).getByLabelText('Type RESTORE to confirm'), {
      target: { value: 'RESTORE' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore backup' }));

    await waitFor(() => expect(apiMock.restoreBackup).toHaveBeenCalledTimes(1));
    expect(apiMock.restoreBackup.mock.calls[0]?.[0]).toMatchObject({
      password: 'backup-pass',
      backup: { format: 'mcp-gateway-backup', version: 1 },
    });
    expect(await screen.findByText('Backup restored')).toBeTruthy();
    expect(screen.getByText('brain')).toBeTruthy();
    expect(screen.getByText(/Restoring users invalidates/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Reinstall' }));
    await waitFor(() => expect(apiMock.reinstallServer).toHaveBeenCalledWith('srv_brain'));
    expect(await screen.findByText(/Rebuilt v1\.2\.0/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }));
    await waitFor(() => expect(onReturnToLogin).toHaveBeenCalledTimes(1));
  });

  it('changes the password and returns to login', async () => {
    const { onReturnToLogin } = renderSettings();
    await screen.findByText('System');

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'old-password' } });
    fireEvent.change(screen.getByLabelText(/^New password/), { target: { value: 'new-password-123' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'new-password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() =>
      expect(apiMock.changePassword).toHaveBeenCalledWith('old-password', 'new-password-123'),
    );
    await waitFor(() => expect(onReturnToLogin).toHaveBeenCalledTimes(1));
  });

  it('renders credential providers and changes the default provider', async () => {
    const { onNavigate } = renderSettings();

    expect(await screen.findByText('Credentials')).toBeTruthy();
    expect(screen.getByText('Vaultwarden', { selector: 'p' })).toBeTruthy();
    expect(screen.getAllByText('1Password').length).toBeGreaterThan(0);
    expect(screen.getByText('Gateway vault', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('built-in')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Open Secrets →' })[0] as HTMLElement);
    expect(onNavigate).toHaveBeenCalledWith('secrets');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'onepassword' } });
    await waitFor(() => expect(apiMock.setDefaultCredentialProvider).toHaveBeenCalledWith('onepassword'));
  });

  it('configures a provider from its descriptor fields and tests it', async () => {
    renderSettings();
    await screen.findByText('Credentials');

    const card = screen.getByText('1Password', { selector: 'p' }).closest('article') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Configure' }));

    const dialog = await screen.findByRole('dialog', { name: 'Configure 1Password' });
    fireEvent.change(within(dialog).getByLabelText('Connect host'), {
      target: { value: 'https://connect.example' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Service account token/), {
      target: { value: 'ops-token' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save provider' }));

    await waitFor(() =>
      expect(apiMock.configureCredentialProvider).toHaveBeenCalledWith('onepassword', {
        connectHost: 'https://connect.example',
        serviceAccountToken: 'ops-token',
      }),
    );

    const vaultwardenCard = screen.getByText('Vaultwarden', { selector: 'p' }).closest('article') as HTMLElement;
    fireEvent.click(within(vaultwardenCard).getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(apiMock.testCredentialProvider).toHaveBeenCalledWith('vaultwarden'));
  });

  it('creates a master API key from the settings quick action', async () => {
    renderSettings();
    await screen.findByText('System');

    fireEvent.click(screen.getByRole('button', { name: 'Create master key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create master API key' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));

    await waitFor(() => expect(apiMock.createKey).toHaveBeenCalledTimes(1));
    expect(apiMock.createKey.mock.calls[0]?.[0]).toMatchObject({ keyType: 'master' });
    expect(await screen.findByText('mcp_master_SETTINGSKEY0123')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy key' })).toBeTruthy();
  });
});
