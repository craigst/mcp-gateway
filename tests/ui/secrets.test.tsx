// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getCredentialProviders: vi.fn(),
    listCredentialItems: vi.fn(),
    revealCredential: vi.fn(),
    getVaultWarden: vi.fn(),
    resolveEscalation: vi.fn(),
    protectVaultWarden: vi.fn(),
    getSession: vi.fn(),
    onUnauthorized: vi.fn(),
    getHealth: vi.fn(),
  },
}));

vi.mock('../../src/ui/lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/lib/api.js')>();
  return { ...actual, api: apiMock };
});

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SecretsPage } from '../../src/ui/pages/secrets/SecretsPage.js';
import { App } from '../../src/ui/App.js';

const providers = [
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
    message: 'Built-in vault.',
    details: {},
  },
];

const descriptors = [
  { id: 'vaultwarden', name: 'Vaultwarden', description: 'Default password manager', docsHint: '', fields: [] },
  { id: 'onepassword', name: '1Password', description: 'Alternative', docsHint: '', fields: [] },
  { id: 'gateway', name: 'Gateway vault', description: 'Built-in', docsHint: '', fields: [] },
];

const vaultwardenItem = {
  provider: 'vaultwarden',
  id: 'alias-n8n',
  name: 'n8n API key',
  username: null,
  category: 'API',
  urls: ['https://n8n.example'],
  fields: ['password', 'token'],
};

const gatewayItem = {
  provider: 'gateway',
  id: 'GITHUB_TOKEN',
  name: 'GITHUB_TOKEN',
  username: null,
  category: 'gateway-secret',
  urls: [],
  fields: ['value'],
};

beforeEach(() => {
  apiMock.getCredentialProviders.mockResolvedValue({
    providers,
    descriptors,
    defaultProvider: 'vaultwarden',
  });
  apiMock.listCredentialItems.mockImplementation(
    async (provider: string) => (provider === 'gateway' ? [gatewayItem] : [vaultwardenItem]),
  );
  apiMock.revealCredential.mockImplementation(
    async (input: { provider: string; itemId: string; field?: string }) => ({
      provider: input.provider,
      itemId: input.itemId,
      field: input.field ?? null,
      value: input.provider === 'gateway' ? 'ghp_example_secret' : 'hunter2',
    }),
  );
  apiMock.getVaultWarden.mockResolvedValue({
    installed: false,
    defaults: { approvalTools: [], highPrivilegeTools: [] },
    pendingApprovals: [],
    accessLog: [],
    tools: [],
  });
  apiMock.resolveEscalation.mockResolvedValue({ escalation: { status: 'approved' } });
  apiMock.protectVaultWarden.mockResolvedValue({});
  apiMock.getSession.mockResolvedValue({ authenticated: true, user: { username: 'operator' } });
  apiMock.onUnauthorized.mockReturnValue(() => {});
  apiMock.getHealth.mockResolvedValue({ status: 'ok', version: '0.7.0', uptimeMs: 1000 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  if (typeof window !== 'undefined') window.location.hash = '';
});

function renderSecrets(onNavigate = vi.fn()) {
  render(<SecretsPage onNavigate={onNavigate} />);
  return { onNavigate };
}

describe('Secrets page — credential browser', () => {
  it('renders provider tabs with the default selected and lists items', async () => {
    renderSecrets();

    const vaultwardenTab = await screen.findByRole('tab', { name: /Vaultwarden/ });
    expect(vaultwardenTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /1Password/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Gateway vault/ })).toBeTruthy();

    expect(await screen.findByText('n8n API key')).toBeTruthy();
    expect(screen.getByText('API')).toBeTruthy();
    expect(screen.getByText('password')).toBeTruthy();
    expect(apiMock.listCredentialItems).toHaveBeenCalledWith('vaultwarden', { limit: 50 });
  });

  it('searches provider items and shows the gateway built-in vault on its tab', async () => {
    renderSecrets();
    await screen.findByText('n8n API key');

    fireEvent.change(screen.getByLabelText('Search credential items'), { target: { value: 'n8n' } });
    await waitFor(
      () =>
        expect(apiMock.listCredentialItems).toHaveBeenCalledWith(
          'vaultwarden',
          expect.objectContaining({ search: 'n8n' }),
        ),
      { timeout: 2000 },
    );

    fireEvent.click(screen.getByRole('tab', { name: /Gateway vault/ }));
    expect((await screen.findAllByText('GITHUB_TOKEN')).length).toBeGreaterThan(0);
    expect(apiMock.listCredentialItems).toHaveBeenCalledWith('gateway', expect.objectContaining({ limit: 50 }));
  });

  it('reveals an item value (audited) with copy and dismiss', async () => {
    renderSecrets();
    await screen.findByText('n8n API key');

    const row = screen.getByText('n8n API key').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Reveal' }));

    await waitFor(() =>
      expect(apiMock.revealCredential).toHaveBeenCalledWith({
        provider: 'vaultwarden',
        itemId: 'alias-n8n',
        field: 'password',
      }),
    );
    const valueInput = (await screen.findByLabelText('Revealed n8n API key value')) as HTMLInputElement;
    expect(valueInput.value).toBe('hunter2');
    expect(valueInput.readOnly).toBe(true);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByLabelText('Revealed n8n API key value')).toBeNull());
  });

  it('shows a configure CTA when a provider is not configured', async () => {
    const { onNavigate } = renderSecrets();
    await screen.findByText('n8n API key');

    fireEvent.click(screen.getByRole('tab', { name: /1Password/ }));
    expect(await screen.findByText('1Password is not configured')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Configure in Settings → Credentials' }));
    expect(onNavigate).toHaveBeenCalledWith('settings');
  });

  it('keeps the Vault Warden approval panels below the browser', async () => {
    renderSecrets();

    expect(await screen.findByText('n8n API key')).toBeTruthy();
    expect(await screen.findByText('Pending credential requests')).toBeTruthy();
    expect(screen.getAllByText('Vault Warden').length).toBeGreaterThan(0);
    expect(apiMock.getVaultWarden).toHaveBeenCalledTimes(1);
  });
});

describe('Secrets route', () => {
  it('supports #/secrets and the legacy #/vaultwarden alias', async () => {
    window.location.hash = '#/vaultwarden';
    render(<App />);

    expect((await screen.findAllByRole('heading', { name: 'Secrets' })).length).toBeGreaterThan(0);
    expect(await screen.findByText('n8n API key')).toBeTruthy();
    expect(window.location.hash).toBe('#/vaultwarden');
  });
});
