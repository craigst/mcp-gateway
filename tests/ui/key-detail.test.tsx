// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listKeys: vi.fn(),
    listServers: vi.fn(),
    rpc: vi.fn(),
    createKey: vi.fn(),
    revokeKey: vi.fn(),
    updateKey: vi.fn(),
    pauseKey: vi.fn(),
    resumeKey: vi.fn(),
    getKeyAccess: vi.fn(),
    getKeyActivity: vi.fn(),
    listDelegations: vi.fn(),
    listEscalations: vi.fn(),
    queryAudit: vi.fn(),
    serverLogs: vi.fn(),
  },
}));

vi.mock('../../src/ui/lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/lib/api.js')>();
  return { ...actual, api: apiMock };
});

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RbacPage } from '../../src/ui/pages/Rbac.js';
import type {
  AuditEntry,
  KeyAccessView,
  KeyActivityPage,
  KeySummary,
} from '../../src/core/types.js';

const agentKey: KeySummary = {
  id: 'key_agent',
  name: 'sales-agent',
  keyType: 'agent',
  keyPrefix: 'mcp_ag_sales',
  serverGrants: [
    {
      serverId: 'srv_echo',
      tools: ['echo', 'danger'],
      highPrivilegeTools: ['danger'],
      guardrails: [{ kind: 'regex_applied_to_arguments', pattern: 'DROP' }],
      paused: false,
    },
  ],
  delegationAllowed: false,
  escalationAllowed: true,
  expiresAt: '2027-01-01T00:00:00.000Z',
  revokedAt: null,
  pausedAt: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  lastUsedAt: '2026-10-29T19:00:00.000Z',
};

const pausedKey: KeySummary = {
  ...agentKey,
  id: 'key_paused',
  name: 'paused-bot',
  keyPrefix: 'mcp_ag_paused',
  serverGrants: [],
  pausedAt: '2026-10-29T18:00:00.000Z',
};

const auditEntry: AuditEntry = {
  id: 301,
  ts: '2026-10-29T19:02:00.000Z',
  requestId: 'req-3',
  keyId: 'key_agent',
  method: 'tools/call',
  serverId: 'srv_echo',
  toolId: 'srv_echo:echo',
  status: 'ok',
  latencyMs: 8.4,
  errorCode: null,
  delegationDepth: 0,
  parentId: null,
  payload: { name: 'echo' },
};

function activityPage(overrides: Partial<KeyActivityPage> = {}): KeyActivityPage {
  return {
    key: agentKey,
    stats: {
      total: 10,
      ok: 8,
      error: 1,
      denied: 1,
      lastUsedAt: '2026-10-29T19:02:00.000Z',
      avgLatencyMs: 8.4,
      p50LatencyMs: 6,
      p95LatencyMs: 20,
      distinctServers: 1,
      distinctTools: 2,
      serverUsage: [{ serverId: 'srv_echo', name: 'gateway-echo', count: 10 }],
      toolUsage: [
        { toolId: 'srv_echo:echo', name: 'echo', count: 8, lastUsedAt: '2026-10-29T19:02:00.000Z' },
      ],
    },
    entries: [auditEntry],
    total: 1,
    ...overrides,
  };
}

const accessView: KeyAccessView = {
  key: agentKey,
  grants: [
    {
      serverId: 'srv_echo',
      serverName: 'gateway-echo',
      serverStatus: 'running',
      paused: false,
      tools: [
        {
          name: 'echo',
          description: 'Echo back the input.',
          highPrivilege: false,
          approvalRequired: false,
          granted: true,
          paused: false,
          available: true,
        },
        {
          name: 'danger',
          description: 'Delete a record.',
          highPrivilege: true,
          approvalRequired: true,
          granted: true,
          paused: false,
          available: true,
        },
        {
          name: 'other',
          description: 'Not granted to this key.',
          highPrivilege: false,
          approvalRequired: false,
          granted: false,
          paused: false,
          available: true,
        },
      ],
    },
  ],
};

beforeEach(() => {
  apiMock.listKeys.mockResolvedValue([agentKey, pausedKey]);
  apiMock.listServers.mockResolvedValue([]);
  apiMock.rpc.mockResolvedValue({ tools: [], total: 0 });
  apiMock.getKeyActivity.mockResolvedValue(activityPage());
  apiMock.getKeyAccess.mockResolvedValue(accessView);
  apiMock.updateKey.mockImplementation(async (id: string, input: Record<string, unknown>) => ({
    ...(id === pausedKey.id ? pausedKey : agentKey),
    ...input,
  }));
  apiMock.pauseKey.mockImplementation(async (id: string) => ({
    ...(id === pausedKey.id ? pausedKey : agentKey),
    pausedAt: '2026-10-29T20:00:00.000Z',
  }));
  apiMock.resumeKey.mockImplementation(async (id: string) => ({
    ...(id === pausedKey.id ? pausedKey : agentKey),
    pausedAt: null,
  }));
  apiMock.revokeKey.mockImplementation(async (id: string) => ({
    ...(id === pausedKey.id ? pausedKey : agentKey),
    revokedAt: '2026-10-29T20:10:00.000Z',
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openDetail(name = 'sales-agent'): Promise<void> {
  render(<RbacPage />);
  expect(await screen.findByText(name)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name }));
  expect(await screen.findByRole('tab', { name: 'Access' })).toBeTruthy();
}

async function openAccessTab(): Promise<void> {
  await openDetail();
  fireEvent.click(screen.getByRole('tab', { name: 'Access' }));
  expect(await screen.findByText('Key-level access')).toBeTruthy();
  expect(await screen.findByText('gateway-echo')).toBeTruthy();
}

describe('Key detail drawer', () => {
  it('opens from the key name and shows paused badges in the list', async () => {
    render(<RbacPage />);
    await screen.findByText('sales-agent');
    expect(screen.getByText('paused')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'sales-agent' }));

    expect(await screen.findByRole('tab', { name: 'Activity' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Access' })).toBeTruthy();
    expect(await screen.findByText('Requests')).toBeTruthy();
    expect(apiMock.getKeyActivity).toHaveBeenCalledWith(
      'key_agent',
      expect.objectContaining({ limit: 25, offset: 0 }),
    );
    expect(apiMock.getKeyAccess).not.toHaveBeenCalled();
  });

  it('renames a key inline with PATCH name and updates the header', async () => {
    await openDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Rename key' }));
    fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'renamed-agent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(apiMock.updateKey).toHaveBeenCalledWith('key_agent', { name: 'renamed-agent' }),
    );
    expect((await screen.findAllByText('renamed-agent')).length).toBeGreaterThan(0);
    await waitFor(() => expect(apiMock.listKeys).toHaveBeenCalledTimes(2));
  });

  it('renders activity tiles and applies status presets', async () => {
    await openDetail();

    expect(await screen.findByText('Requests')).toBeTruthy();
    expect(screen.getByText('P95 latency')).toBeTruthy();
    expect(screen.getByText('srv_echo:echo')).toBeTruthy();
    expect(screen.getByText('gateway-echo (10)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Denied' }));
    await waitFor(() =>
      expect(apiMock.getKeyActivity).toHaveBeenLastCalledWith(
        'key_agent',
        expect.objectContaining({ status: 'denied', limit: 25, offset: 0 }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Failed' }));
    await waitFor(() => {
      const calls = apiMock.getKeyActivity.mock.calls as Array<[string, { status?: string }]>;
      const statuses = calls.map((call) => call[1]?.status).filter(Boolean);
      expect(statuses).toContain('error');
      expect(statuses).toContain('denied');
    });
  });

  it('pauses all access for the key from the Access tab', async () => {
    await openAccessTab();

    fireEvent.click(screen.getByRole('button', { name: 'Pause all access' }));

    await waitFor(() => expect(apiMock.pauseKey).toHaveBeenCalledWith('key_agent'));
    expect((await screen.findAllByText(/This key is paused — all calls are refused/)).length).toBeGreaterThan(0);
    expect(await screen.findByRole('button', { name: 'Resume all access' })).toBeTruthy();
  });

  it('pauses a whole server grant while preserving the stored grant fields', async () => {
    await openAccessTab();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Pause whole server grant' }));

    await waitFor(() => expect(apiMock.updateKey).toHaveBeenCalledTimes(1));
    expect(apiMock.updateKey).toHaveBeenCalledWith('key_agent', {
      serverGrants: [
        {
          serverId: 'srv_echo',
          tools: ['echo', 'danger'],
          highPrivilegeTools: ['danger'],
          guardrails: [{ kind: 'regex_applied_to_arguments', pattern: 'DROP' }],
          paused: true,
        },
      ],
    });
  });

  it('pauses a single granted tool via pausedTools and leaves other grants intact', async () => {
    await openAccessTab();

    const toolRow = (await screen.findByText('danger')).closest('li') as HTMLElement;
    fireEvent.click(within(toolRow).getByRole('checkbox', { name: 'Pause tool' }));

    await waitFor(() => expect(apiMock.updateKey).toHaveBeenCalledTimes(1));
    expect(apiMock.updateKey).toHaveBeenCalledWith('key_agent', {
      serverGrants: [
        {
          serverId: 'srv_echo',
          tools: ['echo', 'danger'],
          highPrivilegeTools: ['danger'],
          guardrails: [{ kind: 'regex_applied_to_arguments', pattern: 'DROP' }],
          paused: false,
          pausedTools: ['danger'],
        },
      ],
    });
  });
});
