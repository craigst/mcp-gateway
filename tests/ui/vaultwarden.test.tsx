// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getVaultWarden: vi.fn(),
    resolveEscalation: vi.fn(),
    protectVaultWarden: vi.fn(),
    getHealth: vi.fn(),
    getSession: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    onUnauthorized: vi.fn(),
    getCredentialProviders: vi.fn(),
    listCredentialItems: vi.fn(),
    revealCredential: vi.fn(),
  },
}));

vi.mock('../../src/ui/lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/lib/api.js')>();
  return { ...actual, api: apiMock };
});

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VaultWardenPage } from '../../src/ui/pages/VaultWarden.js';
import { App } from '../../src/ui/App.js';
import type { AuditEntry, EscalationTicket, ServerRecord } from '../../src/core/types.js';

function ticket(overrides: Partial<EscalationTicket> & { ticketId: string; toolId: string }): EscalationTicket {
  return {
    id: `row-${overrides.ticketId}`,
    keyId: 'key_agent_01',
    serverId: 'srv_vw',
    reason: 'APPROVAL_REQUIRED',
    requestPayload: null,
    status: 'pending',
    ticketType: 'tool_approval',
    toolArguments: { item: 'deploy-key', reason: 'agent needs deploy credential' },
    createdAt: '2026-10-29T17:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    note: null,
    ...overrides,
  };
}

const approveTicket = ticket({ ticketId: 'esc-20261029-ab12', toolId: 'srv_vw:vault_deliver_credential' });
const denyTicket = ticket({ ticketId: 'esc-20261029-cd34', toolId: 'srv_vw:vault_deliver_credential' });

const accessEntry: AuditEntry = {
  id: 91,
  ts: '2026-10-29T17:02:00.000Z',
  requestId: 'req-9',
  keyId: 'key_agent_01',
  method: 'tools/call',
  serverId: 'srv_vw',
  toolId: 'srv_vw:vault_deliver_credential',
  status: 'ok',
  latencyMs: 38.2,
  errorCode: null,
  delegationDepth: 0,
  parentId: null,
  payload: null,
};

const vaultwardenServer: ServerRecord = {
  id: 'srv_vw',
  name: 'vaultwarden',
  runtime: 'node',
  transport: 'stdio',
  status: 'running',
  command: 'node',
  args: ['vaultwarden-mcp.js'],
  url: null,
  env: {},
  manifest: null,
  highPrivilegeTools: ['vault_deliver_credential'],
  approvalRequiredTools: ['vault_deliver_credential'],
  envFile: null,
  delegationSupported: false,
  sourceUrl: null,
  workDir: null,
  lastError: null,
  pid: 9001,
  createdAt: '2026-10-29T17:00:00.000Z',
  updatedAt: '2026-10-29T17:05:00.000Z',
};

const installedOverview = {
  installed: true,
  serverId: 'srv_vw',
  serverName: 'vaultwarden',
  status: 'running',
  tools: [
    {
      name: 'vault_deliver_credential',
      description: 'Deliver a stored credential to the requester as a short-lived file path.',
      highPrivilege: true,
      approvalRequired: true,
    },
    {
      name: 'vault_status',
      description: 'Report vault connectivity and item counts.',
      highPrivilege: false,
      approvalRequired: false,
    },
  ],
  defaults: {
    approvalTools: ['vault_deliver_credential'],
    highPrivilegeTools: ['vault_deliver_credential'],
  },
  pendingApprovals: [approveTicket, denyTicket],
  accessLog: [accessEntry],
};

beforeEach(() => {
  apiMock.getHealth.mockResolvedValue({ status: 'ok', version: '0.2.0', uptimeMs: 1000 });
  apiMock.getSession.mockResolvedValue({ authenticated: true, user: { username: 'operator' } });
  apiMock.onUnauthorized.mockReturnValue(() => {});
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
    ],
    descriptors: [
      { id: 'vaultwarden', name: 'Vaultwarden', description: 'Default', docsHint: '', fields: [] },
    ],
    defaultProvider: 'vaultwarden',
  });
  apiMock.listCredentialItems.mockResolvedValue([]);
  apiMock.revealCredential.mockResolvedValue({
    provider: 'vaultwarden',
    itemId: 'alias',
    field: 'password',
    value: 'secret',
  });
  apiMock.getVaultWarden.mockResolvedValue(installedOverview);
  apiMock.resolveEscalation.mockResolvedValue({
    escalation: { ...approveTicket, status: 'approved' },
    result: { content: [{ type: 'text', text: '/run/gateway/secrets/delivery-abc123' }], isError: false },
  });
  apiMock.protectVaultWarden.mockResolvedValue(vaultwardenServer);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  if (typeof window !== 'undefined') window.location.hash = '';
});

describe('VaultWardenPage — not installed', () => {
  it('shows the install call-to-action and deep-links into the catalog tabs', async () => {
    apiMock.getVaultWarden.mockResolvedValue({
      installed: false,
      defaults: {
        approvalTools: ['vault_deliver_credential'],
        highPrivilegeTools: ['vault_deliver_credential'],
      },
      pendingApprovals: [],
      accessLog: [],
      tools: [],
    });
    const onNavigate = vi.fn();
    render(<VaultWardenPage onNavigate={onNavigate} />);

    expect((await screen.findAllByText('Vault Warden is not installed')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/vaultwarden-mcp/).length).toBeGreaterThan(0);
    expect(screen.getByText('No pending credential requests')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Import from harness' })[0] as HTMLElement);
    expect(onNavigate).toHaveBeenCalledWith('catalog', { catalogTab: 'import' });

    fireEvent.click(screen.getByRole('button', { name: 'Browse catalog' }));
    expect(onNavigate).toHaveBeenCalledWith('catalog', { catalogTab: 'discover' });
  });
});

describe('VaultWarden route', () => {
  it('is reachable from the nav hash and renders the approval queue', async () => {
    window.location.hash = '#/vaultwarden';
    render(<App />);

    expect((await screen.findAllByText('Secrets')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Vault Warden')).length).toBeGreaterThan(0);
    expect(await screen.findByText('Pending credential requests')).toBeTruthy();
    expect(apiMock.getVaultWarden).toHaveBeenCalledTimes(1);
  });
});

describe('VaultWardenPage — installed', () => {
  it('renders tool protection badges, the pending queue and vault access log', async () => {
    render(<VaultWardenPage onNavigate={vi.fn()} />);

    expect((await screen.findAllByText('vault_deliver_credential')).length).toBeGreaterThan(0);
    expect(screen.getByText('High-privilege')).toBeTruthy();
    expect(screen.getByText('Approval required')).toBeTruthy();
    expect(screen.getByText('unprotected')).toBeTruthy();

    // Pending credential request details.
    expect(screen.getByText(/esc-20261029-ab12/)).toBeTruthy();
    expect(screen.getAllByText('key_agent_01').length).toBeGreaterThan(0);
    expect(screen.getAllByText('APPROVAL_REQUIRED').length).toBeGreaterThan(0);

    // Expandable arguments.
    fireEvent.click(screen.getAllByText('Show arguments')[0] as HTMLElement);
    expect(await screen.findByText(/"deploy-key"/)).toBeTruthy();

    // Vault access log row (time, key, status, latency).
    expect(screen.getByText('2026-10-29 17:02:00')).toBeTruthy();
    expect(screen.getByText('38 ms')).toBeTruthy();

    // Apply default protection.
    fireEvent.click(screen.getByRole('button', { name: 'Protect defaults' }));
    await waitFor(() => expect(apiMock.protectVaultWarden).toHaveBeenCalledWith('srv_vw'));
  });

  it('approves a credential request, calls resolve and renders the one-time delivery result', async () => {
    render(<VaultWardenPage onNavigate={vi.fn()} />);

    await screen.findAllByText('vault_deliver_credential');
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0] as HTMLElement);

    await waitFor(() =>
      expect(apiMock.resolveEscalation).toHaveBeenCalledWith('esc-20261029-ab12', 'approved'),
    );
    expect(await screen.findByText('/run/gateway/secrets/delivery-abc123')).toBeTruthy();
    expect(screen.getByText(/delivered once/)).toBeTruthy();
    expect(screen.getByText(/never returned/)).toBeTruthy();
  });

  it('denies a credential request and shows the denied state', async () => {
    apiMock.resolveEscalation.mockResolvedValue({
      escalation: { ...denyTicket, status: 'denied' },
    });
    render(<VaultWardenPage onNavigate={vi.fn()} />);

    await screen.findAllByText('vault_deliver_credential');
    const denyButtons = screen.getAllByRole('button', { name: 'Deny' });
    fireEvent.click(denyButtons[denyButtons.length - 1] as HTMLElement);

    await waitFor(() =>
      expect(apiMock.resolveEscalation).toHaveBeenCalledWith('esc-20261029-cd34', 'denied'),
    );
    expect(await screen.findByText(/Denied — the agent cannot execute this tool call/)).toBeTruthy();
  });
});
