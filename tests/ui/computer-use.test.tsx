// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getComputerUseOverview: vi.fn(),
    listComputerUseComputers: vi.fn(),
    updateComputerUseSettings: vi.fn(),
    setComputerUseAvailability: vi.fn(),
    syncComputerUse: vi.fn(),
    startComputerUseComputer: vi.fn(),
    stopComputerUseComputer: vi.fn(),
    computerUseFrameUrl: vi.fn(),
    computerUseLiveDesktopUrl: vi.fn(
      (id: string) => `/mcp/v1/admin/computer-use/computers/${id}/live-desktop`,
    ),
    getComputerUseActivity: vi.fn(),
  },
}));

vi.mock('../../src/ui/lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/lib/api.js')>();
  return { ...actual, api: apiMock };
});

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ComputerUsePage } from '../../src/ui/pages/computer-use/ComputerUsePage.js';
import type {
  AuditEntry,
  ComputerUseAvailability,
  ComputerUseBrokerInfo,
  ComputerUseComputerInfo,
  ComputerUseComputersResponse,
  ComputerUseOverview,
  ComputerUseSettingsInfo,
} from '../../src/core/types.js';

const availableAvailability: ComputerUseAvailability = {
  available: true,
  state: 'available',
  reason: null,
  until: null,
  updatedAt: '2026-10-29T22:00:00.000Z',
  updatedBy: 'operator',
};

const pausedAvailability: ComputerUseAvailability = {
  available: false,
  state: 'paused',
  reason: 'Patching the GPU driver',
  until: '2026-10-30T06:00:00.000Z',
  updatedAt: '2026-10-29T22:30:00.000Z',
  updatedBy: 'operator',
};

const brokerOnline: ComputerUseBrokerInfo = {
  configured: true,
  reachable: true,
  url: 'https://127.0.0.1:7443',
  version: '1.4.0',
  tls: true,
  computers: 2,
  devices: 1,
  connectorsOnline: 2,
  checkedAt: '2026-10-29T23:00:00.000Z',
  error: null,
};

const brokerUnconfigured: ComputerUseBrokerInfo = {
  configured: false,
  reachable: false,
  url: null,
  version: null,
  tls: false,
  computers: null,
  devices: null,
  connectorsOnline: null,
  checkedAt: null,
  error: null,
};

const settingsInfo: ComputerUseSettingsInfo = {
  brokerUrl: 'https://127.0.0.1:7443',
  publicBrokerUrl: 'https://broker.example.lan',
  caFile: null,
  tokenConfigured: true,
  tokenSource: 'vault',
  enabled: true,
  updatedAt: '2026-10-29T21:00:00.000Z',
};

const unconfiguredSettings: ComputerUseSettingsInfo = {
  brokerUrl: null,
  publicBrokerUrl: null,
  caFile: null,
  tokenConfigured: false,
  tokenSource: null,
  enabled: true,
  updatedAt: null,
};

function makeComputer(
  overrides: Partial<ComputerUseComputerInfo> & { id: string; name: string },
): ComputerUseComputerInfo {
  return {
    template: 'ubuntu-desktop',
    provider: 'docker',
    state: 'ready',
    viewer: 'vnc',
    error: null,
    createdAt: '2026-10-29T20:00:00.000Z',
    ttlAt: null,
    desktop: { viewer: 'vnc', width: 1920, height: 1080 },
    connector: { state: 'online', version: '1.0.0', lastSeen: '2026-10-29T23:00:00.000Z' },
    control: { held: false, holder: null, heldSince: null, expiresAt: null },
    availability: availableAvailability,
    liveUrl: `https://broker.example.lan/#/d/${overrides.id}`,
    ...overrides,
  };
}

const alphaComputer = makeComputer({ id: 'comp-alpha', name: 'Desktop Alpha' });

const betaComputer = makeComputer({
  id: 'comp-beta',
  name: 'Desktop Beta',
  state: 'stopped',
  liveUrl: null,
  connector: null,
  availability: pausedAvailability,
  control: {
    held: true,
    holder: 'agent:ops',
    heldSince: '2026-10-29T22:45:00.000Z',
    expiresAt: null,
  },
});

const overview: ComputerUseOverview = {
  settings: settingsInfo,
  broker: brokerOnline,
  availability: availableAvailability,
  server: {
    id: 'srv_computer_use',
    name: 'computer-use',
    status: 'running',
    toolCount: 2,
    lastError: null,
  },
  tools: [
    {
      name: 'computer_screenshot',
      description: 'Capture a frame from a computer desktop.',
      highPrivilege: false,
      approvalRequired: false,
      readOnly: true,
    },
    {
      name: 'computer_click',
      description: 'Click at desktop coordinates.',
      highPrivilege: true,
      approvalRequired: true,
      readOnly: false,
    },
  ],
  counts: { computers: 2, available: 1, paused: 1, ready: 1, connectorsOnline: 2 },
};

const unconfiguredOverview: ComputerUseOverview = {
  settings: unconfiguredSettings,
  broker: brokerUnconfigured,
  availability: availableAvailability,
  server: { id: null, name: 'computer-use', status: 'absent', toolCount: 0, lastError: null },
  tools: [],
  counts: { computers: 0, available: 0, paused: 0, ready: 0, connectorsOnline: 0 },
};

const computersResponse: ComputerUseComputersResponse = {
  broker: brokerOnline,
  availability: availableAvailability,
  computers: [alphaComputer, betaComputer],
};

const unconfiguredComputers: ComputerUseComputersResponse = {
  broker: brokerUnconfigured,
  availability: availableAvailability,
  computers: [],
};

function makeAuditEntry(overrides: Partial<AuditEntry> & { id: number }): AuditEntry {
  return {
    ts: '2026-10-29T23:05:00.000Z',
    requestId: 'req-1',
    keyId: 'key_agent',
    method: 'tools/call',
    serverId: 'srv_computer_use',
    toolId: 'computer_screenshot',
    status: 'ok',
    latencyMs: 42,
    errorCode: null,
    delegationDepth: 0,
    parentId: null,
    payload: null,
    ...overrides,
  };
}

const activity: AuditEntry[] = [
  makeAuditEntry({ id: 1 }),
  makeAuditEntry({ id: 2, status: 'denied', errorCode: -32001, latencyMs: 3 }),
];

beforeEach(() => {
  apiMock.getComputerUseOverview.mockResolvedValue(overview);
  apiMock.listComputerUseComputers.mockResolvedValue(computersResponse);
  apiMock.getComputerUseActivity.mockResolvedValue(activity);
  apiMock.setComputerUseAvailability.mockResolvedValue(overview);
  apiMock.updateComputerUseSettings.mockResolvedValue(overview);
  apiMock.syncComputerUse.mockResolvedValue(overview);
  apiMock.startComputerUseComputer.mockResolvedValue(alphaComputer);
  apiMock.stopComputerUseComputer.mockResolvedValue(betaComputer);
  apiMock.computerUseFrameUrl.mockImplementation(
    (computerId: string, maxWidth = 480) =>
      `/mcp/v1/admin/computer-use/computers/${computerId}/frame?maxWidth=${maxWidth}`,
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Computer Use page', () => {
  it('renders the overview, broker status and the live fleet', async () => {
    render(<ComputerUsePage />);

    expect(await screen.findByText('Available to agents')).toBeTruthy();
    expect(screen.getByText(/2 computers · 1 ready · 2 connectors online/)).toBeTruthy();
    expect(screen.getByText('v1.4.0')).toBeTruthy();
    expect(screen.getByText('https://127.0.0.1:7443')).toBeTruthy();

    expect(await screen.findByText('Desktop Alpha')).toBeTruthy();
    expect(screen.getByText('Desktop Beta')).toBeTruthy();
    expect(screen.getByText('Patching the GPU driver')).toBeTruthy();
    expect(screen.getByAltText('Live screen of Desktop Alpha')).toBeTruthy();
    expect(screen.queryByAltText('Live screen of Desktop Beta')).toBeNull();
    expect(
      screen.getByRole('link', { name: /Open live desktop/ }).getAttribute('href'),
    ).toBe('/mcp/v1/admin/computer-use/computers/comp-alpha/live-desktop');

    expect((await screen.findAllByText('computer_screenshot')).length).toBeGreaterThan(0);
    expect(screen.getByText('high privilege')).toBeTruthy();
    expect(screen.getByText('approval required')).toBeTruthy();
    expect(await screen.findByText('Recent activity')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open larger live preview of Desktop Alpha' }));
    const preview = await screen.findByRole('dialog', { name: 'Live preview of Desktop Alpha' });
    expect(within(preview).getByAltText('Large live preview of Desktop Alpha')).toBeTruthy();
    await waitFor(() => expect(apiMock.computerUseFrameUrl).toHaveBeenCalledWith('comp-alpha', 1280));
    fireEvent.click(within(preview).getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByRole('dialog', { name: 'Live preview of Desktop Alpha' })).toBeNull();

    expect(apiMock.getComputerUseOverview).toHaveBeenCalledTimes(1);
    expect(apiMock.listComputerUseComputers).toHaveBeenCalledTimes(1);
    expect(apiMock.getComputerUseActivity).toHaveBeenCalledWith(50);
    expect(apiMock.computerUseFrameUrl).toHaveBeenCalledWith('comp-alpha', 480);
  });

  it('pauses all computer use from the availability card', async () => {
    render(<ComputerUsePage />);
    await screen.findByText('Available to agents');

    fireEvent.click(screen.getByRole('button', { name: 'Pause agent computer use' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pause agent computer use' });
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), {
      target: { value: 'Maintenance window' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pause' }));

    await waitFor(() => expect(apiMock.setComputerUseAvailability).toHaveBeenCalledTimes(1));
    expect(apiMock.setComputerUseAvailability).toHaveBeenCalledWith({
      scope: 'global',
      available: false,
      reason: 'Maintenance window',
      until: null,
    });
    await waitFor(() => expect(apiMock.getComputerUseOverview).toHaveBeenCalledTimes(2));
  });

  it('toggles availability per computer from the fleet tiles', async () => {
    render(<ComputerUsePage />);
    await screen.findByText('Desktop Alpha');

    const alphaCard = screen.getByRole('article', { name: 'Computer Desktop Alpha' });
    fireEvent.click(within(alphaCard).getByRole('switch'));

    const pauseDialog = await screen.findByRole('dialog', { name: 'Pause agent use on Desktop Alpha' });
    fireEvent.click(within(pauseDialog).getByRole('button', { name: 'Pause' }));
    await waitFor(() =>
      expect(apiMock.setComputerUseAvailability).toHaveBeenCalledWith({
        scope: 'computer',
        computerId: 'comp-alpha',
        available: false,
        reason: null,
        until: null,
      }),
    );

    const betaCard = screen.getByRole('article', { name: 'Computer Desktop Beta' });
    fireEvent.click(within(betaCard).getByRole('switch'));
    await waitFor(() =>
      expect(apiMock.setComputerUseAvailability).toHaveBeenLastCalledWith({
        scope: 'computer',
        computerId: 'comp-beta',
        available: true,
      }),
    );
  });

  it('explains an unconfigured broker and opens the settings dialog', async () => {
    apiMock.getComputerUseOverview.mockResolvedValue(unconfiguredOverview);
    apiMock.listComputerUseComputers.mockResolvedValue(unconfiguredComputers);

    render(<ComputerUsePage />);

    expect(await screen.findByText('Computer Broker not configured')).toBeTruthy();
    expect(screen.getByText('No computers to show')).toBeTruthy();
    expect(screen.getByText('MCP_COMPUTER_BROKER_URL')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Configure broker' }));
    const dialog = await screen.findByRole('dialog', { name: 'Computer use settings' });
    expect(within(dialog).getByLabelText(/^Broker URL/)).toBeTruthy();
    expect(within(dialog).getByLabelText(/token/i)).toBeTruthy();
  });

  it('syncs the broker and refreshes the overview', async () => {
    render(<ComputerUsePage />);
    await screen.findByText('Available to agents');

    fireEvent.click(screen.getByRole('button', { name: 'Sync broker' }));
    await waitFor(() => expect(apiMock.syncComputerUse).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(apiMock.getComputerUseOverview).toHaveBeenCalledTimes(2));
  });
});
