// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listKeys: vi.fn(),
    listServers: vi.fn(),
    rpc: vi.fn(),
    createKey: vi.fn(),
    revokeKey: vi.fn(),
    getKey: vi.fn(),
    regenerateMasterKey: vi.fn(),
  },
}));

vi.mock('../../src/ui/lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/lib/api.js')>();
  return { ...actual, api: apiMock };
});

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RbacPage } from '../../src/ui/pages/Rbac.js';
import { ToastProvider } from '../../src/ui/components/Toasts.js';
import { ApiError } from '../../src/ui/lib/api.js';
import type { KeySummary } from '../../src/core/types.js';

const masterKey: KeySummary = {
  id: 'key_master_old',
  name: 'master',
  keyType: 'master',
  keyPrefix: 'mcp_master_old',
  serverGrants: [],
  delegationAllowed: true,
  escalationAllowed: true,
  expiresAt: null,
  revokedAt: null,
  pausedAt: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  lastUsedAt: null,
};

const agentKey: KeySummary = {
  id: 'key_agent_sales',
  name: 'sales-agent',
  keyType: 'agent',
  keyPrefix: 'mcp_ag_sales',
  serverGrants: [{ serverId: 'srv_echo', tools: ['echo'] }],
  delegationAllowed: false,
  escalationAllowed: true,
  expiresAt: null,
  revokedAt: null,
  pausedAt: null,
  createdAt: '2026-10-02T09:00:00.000Z',
  lastUsedAt: null,
};

const regeneratedKey: KeySummary = {
  ...masterKey,
  id: 'key_master_new',
  name: 'master (regenerated)',
  keyPrefix: 'mcp_master_new',
  createdAt: '2026-10-29T19:00:00.000Z',
};

const NEW_PLAINTEXT = 'mcp_master_NEWSECRET0123456789';

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });

  apiMock.listKeys.mockResolvedValue([masterKey, agentKey]);
  apiMock.listServers.mockResolvedValue([]);
  apiMock.rpc.mockResolvedValue({ tools: [], total: 0 });
  apiMock.getKey.mockResolvedValue(masterKey);
  apiMock.revokeKey.mockResolvedValue({ ...masterKey, revokedAt: '2026-10-29T19:00:00.000Z' });
  apiMock.regenerateMasterKey.mockResolvedValue({
    key: regeneratedKey,
    plaintext: NEW_PLAINTEXT,
    revokedCount: 2,
  });
  apiMock.createKey.mockResolvedValue({ key: agentKey, plaintext: 'mcp_ag_COPYME0123456789' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderRbac() {
  return render(
    <ToastProvider>
      <RbacPage />
    </ToastProvider>,
  );
}

async function openRegenerateDialog(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate master key' }));
  return screen.findByRole('dialog', { name: 'Regenerate master key' });
}

describe('RbacPage — master control key', () => {
  it('shows the full-admin warning and active master key count', async () => {
    renderRbac();

    expect(await screen.findByText('Master control key')).toBeTruthy();
    expect(await screen.findByText('Active master keys')).toBeTruthy();
    expect(screen.getByText(/1 master key issued · full-admin/)).toBeTruthy();
    expect(screen.getByText(/Keep exactly one active master key/)).toBeTruthy();
    expect(screen.getByText('sales-agent')).toBeTruthy();
  });

  it('regenerates, adopts the new key, reveals it once and copies it', async () => {
    renderRbac();
    await screen.findByText('sales-agent');

    await openRegenerateDialog();
    expect(screen.getByRole('checkbox', { name: /Keep existing master keys/ })).toHaveProperty('checked', false);

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate key' }));

    await waitFor(() =>
      expect(apiMock.regenerateMasterKey).toHaveBeenCalledWith({ revokePrevious: true }),
    );
    // Rotation is for external AI clients only — the console keeps its session.
    expect(await screen.findByText(NEW_PLAINTEXT)).toBeTruthy();
    expect(screen.getAllByText(/console session is unchanged/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2 previous master keys revoked/).length).toBeGreaterThan(0);
    // Toast carries the revoked count too.
    expect(screen.getAllByText(/Master key regenerated/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(NEW_PLAINTEXT));
    expect(await screen.findByText('Copied')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText(NEW_PLAINTEXT)).toBeNull());
  });

  it('sends revokePrevious:false when keeping existing master keys', async () => {
    renderRbac();
    await screen.findByText('sales-agent');

    await openRegenerateDialog();
    fireEvent.click(screen.getByRole('checkbox', { name: /Keep existing master keys/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate key' }));

    await waitFor(() =>
      expect(apiMock.regenerateMasterKey).toHaveBeenCalledWith({ revokePrevious: false }),
    );
    expect(await screen.findByText(NEW_PLAINTEXT)).toBeTruthy();
  });

  it('shows the API error inline, keeps the old key and never reveals a plaintext', async () => {
    apiMock.regenerateMasterKey.mockRejectedValue(
      new ApiError({ status: 403, code: 403, message: 'Access Denied: master key required' }),
    );
    renderRbac();
    await screen.findByText('sales-agent');

    await openRegenerateDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate key' }));

    expect(await screen.findByText(/Access Denied: master key required/)).toBeTruthy();
    expect(screen.queryByText(NEW_PLAINTEXT)).toBeNull();
    // The confirm dialog stays open so the operator can retry.
    expect(screen.getByRole('dialog', { name: 'Regenerate master key' })).toBeTruthy();
  });

  it('offers clipboard copy on the existing create-key reveal too', async () => {
    renderRbac();
    await screen.findByText('sales-agent');

    fireEvent.click(screen.getByRole('button', { name: 'New key' }));
    fireEvent.change(await screen.findByPlaceholderText('sales-agent'), { target: { value: 'ci-bot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Issue key' }));

    expect(await screen.findByText('API key created')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy key' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('mcp_ag_COPYME0123456789'));
    expect(await screen.findByText('Copied')).toBeTruthy();
  });
});
