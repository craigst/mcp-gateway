// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getSession: vi.fn(),
    onUnauthorized: vi.fn(),
    getHealth: vi.fn(),
    getMetrics: vi.fn(),
    listServers: vi.fn(),
    listServerUpdates: vi.fn(),
    listCatalogSources: vi.fn(),
    setupAccount: vi.fn(),
    setupRestore: vi.fn(),
    createKey: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
  },
}));

vi.mock('../../src/ui/lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/lib/api.js')>();
  return { ...actual, api: apiMock };
});

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../../src/ui/App.js';
import type { MetricsSnapshot } from '../../src/core/ports.js';

function metricsSnapshot(): MetricsSnapshot {
  return {
    uptimeMs: 125_000,
    requests: { total: 10, ok: 9, denied: 1, error: 0 },
    requestsPerMinute: 2,
    errorRate: 0,
    latencyMs: { p50: 5, p95: 10, p99: 20 },
    servers: { running: 1, total: 1 },
    process: { cpuPercent: 1, rssBytes: 1024, heapUsedBytes: 512 },
    delegations: { total: 1, approved: 1, denied: 0 },
  };
}

const masterKey = {
  id: 'key_master_setup',
  name: 'initial-master',
  keyType: 'master',
  keyPrefix: 'mcp_master_setup',
  serverGrants: [],
  delegationAllowed: true,
  escalationAllowed: true,
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-10-29T20:00:00.000Z',
  lastUsedAt: null,
};

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

beforeEach(() => {
  apiMock.getSession.mockResolvedValue({ authenticated: false, setupRequired: true, restoreSupported: true });
  apiMock.onUnauthorized.mockReturnValue(() => {});
  apiMock.getHealth.mockResolvedValue({ status: 'ok', version: '0.6.0', uptimeMs: 1000 });
  apiMock.getMetrics.mockResolvedValue(metricsSnapshot());
  apiMock.listServers.mockResolvedValue([]);
  apiMock.listServerUpdates.mockResolvedValue([]);
  apiMock.listCatalogSources.mockResolvedValue([]);
  apiMock.setupAccount.mockResolvedValue({
    user: { username: 'operator' },
    expiresAt: '2026-10-30T00:00:00.000Z',
  });
  apiMock.setupRestore.mockResolvedValue(restoreResult);
  apiMock.createKey.mockResolvedValue({ key: masterKey, plaintext: 'mcp_master_SETUPKEY0123456789' });
  apiMock.login.mockResolvedValue({ user: { username: 'operator' } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  if (typeof window !== 'undefined') window.location.hash = '';
});

async function completeAccountStep(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Create operator account' }));
  fireEvent.change(await screen.findByPlaceholderText('operator'), { target: { value: 'operator' } });
  const passwords = screen.getAllByLabelText(/password/i);
  fireEvent.change(passwords[0] as HTMLElement, { target: { value: 'correct-horse' } });
  fireEvent.change(passwords[1] as HTMLElement, { target: { value: 'correct-horse' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  await waitFor(() => expect(apiMock.setupAccount).toHaveBeenCalledWith('operator', 'correct-horse'));
  expect(await screen.findByText('Optional: API key for AI clients')).toBeTruthy();
}

describe('First-run setup wizard', () => {
  it('renders the wizard instead of login when /auth/me reports setupRequired', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Set up your MCP Gateway' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Create operator account' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Restore from backup' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(apiMock.getSession).toHaveBeenCalledTimes(1);
  });

  it('creates the account, skips the API key step and opens the dashboard', async () => {
    render(<App />);
    await completeAccountStep();

    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByText("You're all set")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open dashboard' }));

    expect(await screen.findByText('Requests / min')).toBeTruthy();
    expect(screen.getAllByText('operator').length).toBeGreaterThan(0);
  });

  it('validates the account form and generates an optional master key', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create operator account' }));

    fireEvent.change(await screen.findByPlaceholderText('operator'), { target: { value: 'op' } });
    const passwords = screen.getAllByLabelText(/password/i);
    fireEvent.change(passwords[0] as HTMLElement, { target: { value: 'short' } });
    fireEvent.change(passwords[1] as HTMLElement, { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Password must be at least 8 characters.')).toBeTruthy();
    expect(apiMock.setupAccount).not.toHaveBeenCalled();

    fireEvent.change(screen.getAllByLabelText(/password/i)[0] as HTMLElement, {
      target: { value: 'correct-horse' },
    });
    fireEvent.change(screen.getAllByLabelText(/password/i)[1] as HTMLElement, {
      target: { value: 'correct-horse' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(apiMock.setupAccount).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole('button', { name: 'Generate master API key' }));
    await waitFor(() => expect(apiMock.createKey).toHaveBeenCalledTimes(1));
    expect(apiMock.createKey.mock.calls[0]?.[0]).toMatchObject({
      name: 'initial-master',
      keyType: 'master',
    });
    expect(await screen.findByText('mcp_master_SETUPKEY0123456789')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy key' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText("You're all set")).toBeTruthy();
  });

  it('restores from an encrypted backup and then shows the login page', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Restore from backup' }));

    const file = new File([JSON.stringify({ format: 'mcp-gateway-backup', version: 1 })], 'gateway.mcpbak', {
      type: 'application/json',
    });
    fireEvent.change(screen.getByLabelText('Backup file'), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText(/Backup password/), { target: { value: 'backup-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Restore from backup' }));

    await waitFor(() => expect(apiMock.setupRestore).toHaveBeenCalledTimes(1));
    expect(apiMock.setupRestore.mock.calls[0]?.[0]).toEqual({ format: 'mcp-gateway-backup', version: 1 });
    expect(apiMock.setupRestore.mock.calls[0]?.[1]).toBe('backup-pass');

    expect(await screen.findByText('Backup restored')).toBeTruthy();
    expect(screen.getByText('brain')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go to sign in' }));

    expect(await screen.findByRole('heading', { name: 'Gateway Console' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});
