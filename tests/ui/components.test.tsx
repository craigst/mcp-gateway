// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getHealth: vi.fn(),
    getMetrics: vi.fn(),
    listKeys: vi.fn(),
    listServers: vi.fn(),
    listDelegations: vi.fn(),
    listEscalations: vi.fn(),
    rpc: vi.fn(),
    rpcDetailed: vi.fn(),
    createKey: vi.fn(),
    revokeKey: vi.fn(),
    queryAudit: vi.fn(),
    serverLogs: vi.fn(),
  },
}));

vi.mock('../../src/ui/lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/lib/api.js')>();
  return { ...actual, api: apiMock };
});

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DashboardPage } from '../../src/ui/pages/Dashboard.js';
import { RbacPage } from '../../src/ui/pages/Rbac.js';
import { PlaygroundPage } from '../../src/ui/pages/Playground.js';
import { Layout } from '../../src/ui/components/Layout.js';
import type { MetricsSnapshot } from '../../src/core/ports.js';
import type { KeySummary, ServerRecord } from '../../src/core/types.js';

function metricsSnapshot(): MetricsSnapshot {
  return {
    uptimeMs: 125_000,
    requests: { total: 1000, ok: 970, denied: 20, error: 10 },
    requestsPerMinute: 42.5,
    errorRate: 0.025,
    latencyMs: { p50: 8.2, p95: 21.4, p99: 140 },
    servers: { running: 1, total: 1 },
    process: { cpuPercent: 12.34, rssBytes: 52_428_800, heapUsedBytes: 10_485_760 },
    delegations: { total: 7, approved: 6, denied: 1 },
  };
}

const keySummary: KeySummary = {
  id: 'key_01',
  name: 'sales-agent',
  keyType: 'agent',
  keyPrefix: 'mcp_ag_ab12',
  serverGrants: [{ serverId: 'echo-v1', tools: ['echo'] }],
  delegationAllowed: false,
  escalationAllowed: true,
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-10-29T17:00:00.000Z',
  lastUsedAt: null,
};

const serverRecord: ServerRecord = {
  id: 'echo-v1',
  name: 'gateway-echo',
  runtime: 'node',
  transport: 'stdio',
  status: 'running',
  command: 'node',
  args: ['echo.mjs'],
  url: null,
  env: {},
  manifest: null,
  highPrivilegeTools: ['danger_delete'],
  delegationSupported: false,
  sourceUrl: null,
  workDir: null,
  lastError: null,
  pid: 4321,
  createdAt: '2026-10-29T17:00:00.000Z',
  updatedAt: '2026-10-29T17:05:00.000Z',
};

beforeEach(() => {
  apiMock.getHealth.mockResolvedValue({ status: 'ok', version: '0.1.0', uptimeMs: 1000 });
  apiMock.getMetrics.mockResolvedValue(metricsSnapshot());
  apiMock.listKeys.mockResolvedValue([keySummary]);
  apiMock.listServers.mockResolvedValue([serverRecord]);
  apiMock.rpc.mockResolvedValue({ tools: [], total: 0 });
  apiMock.rpcDetailed.mockResolvedValue({
    id: 'ui-1',
    method: 'tools/list',
    result: { tools: [] },
    roundTripMs: 5,
    gatewayOverheadMs: 1.4,
    subServerMs: 2,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DashboardPage', () => {
  it('renders stat tiles from the mocked metrics endpoint', async () => {
    render(<DashboardPage />);

    expect(await screen.findByText('Requests / min')).toBeTruthy();
    expect(await screen.findByText('42.5')).toBeTruthy();
    expect(await screen.findByText('2.5%')).toBeTruthy();
    expect(await screen.findByText('50.0 MB')).toBeTruthy();
    expect(apiMock.getMetrics).toHaveBeenCalledTimes(1);
    // Server status list is populated from the admin API.
    expect(await screen.findByText('gateway-echo')).toBeTruthy();
  });
});

describe('RbacPage', () => {
  it('renders the key table and opens the create-key dialog', async () => {
    render(<RbacPage />);

    expect(await screen.findByText('sales-agent')).toBeTruthy();
    expect(await screen.findByText(/mcp_ag_ab12/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /new key/i }));

    expect(await screen.findByText('Create API key')).toBeTruthy();
    // Scope grid is populated from the admin servers endpoint.
    expect(await screen.findByText('gateway-echo')).toBeTruthy();
  });
});

describe('PlaygroundPage', () => {
  it('sends a JSON-RPC request when Run is clicked', async () => {
    render(<PlaygroundPage />);

    fireEvent.click(screen.getByRole('button', { name: /^run$/i }));

    await waitFor(() => expect(apiMock.rpcDetailed).toHaveBeenCalledTimes(1));
    const call = apiMock.rpcDetailed.mock.calls[0] as [string, unknown];
    expect(call[0]).toBe('tools/list');
    expect(call[1]).toEqual({});
    expect(await screen.findByText('200 OK')).toBeTruthy();
  });
});

describe('Layout', () => {
  it('renders the navigation shell, children and gateway connection state', async () => {
    render(
      <Layout current="dashboard" onNavigate={() => {}} user="operator" onSignOut={() => {}}>
        <div>page content</div>
      </Layout>,
    );

    expect(screen.getByText('page content')).toBeTruthy();
    for (const label of ['Dashboard', 'Catalog', 'Configurations', 'Secrets', 'RBAC', 'Vault', 'Audit', 'Delegation', 'Playground', 'Settings']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(await screen.findByText('Gateway online')).toBeTruthy();
    expect(screen.getAllByText('operator').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Sign out' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('Set API key')).toBeNull();
  });
});
