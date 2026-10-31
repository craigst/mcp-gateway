// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getComputerUseConnectors: vi.fn(),
    createComputerUseEnrollment: vi.fn(),
    revokeComputerUseEnrollment: vi.fn(),
    openComputerUseTerminal: vi.fn(),
    sendComputerUseTerminal: vi.fn(),
    readComputerUseTerminal: vi.fn(),
    closeComputerUseTerminal: vi.fn(),
    listComputerUseComputers: vi.fn(),
    getComputerUseStats: vi.fn(),
    createHostComputer: vi.fn(),
    updateComputerUseConnector: vi.fn(),
    removeComputerUseConnector: vi.fn(),
    computerUseLiveDesktopUrl: vi.fn(),
  },
}));

vi.mock('../../src/ui/lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/lib/api.js')>();
  return { ...actual, api: apiMock };
});

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '../../src/ui/components/Toasts.js';
import { ConnectorsPage } from '../../src/ui/pages/connectors/ConnectorsPage.js';
import type {
  ComputerUseAvailability,
  ComputerUseBrokerInfo,
  ComputerUseComputerInfo,
  ComputerUseComputersResponse,
  ComputerUseConnectorsResponse,
  ComputerUseDeviceInfo,
  ComputerUseEnrollmentInfo,
  ComputerUseEnrollmentResponse,
  ComputerUseHostComputer,
  ComputerUseStats,
} from '../../src/core/types.js';

const NOW = Date.now();

const brokerOnline: ComputerUseBrokerInfo = {
  configured: true,
  reachable: true,
  url: 'https://127.0.0.1:7443',
  version: '1.4.0',
  tls: true,
  computers: 1,
  devices: 2,
  connectorsOnline: 1,
  checkedAt: '2026-10-29T23:00:00.000Z',
  error: null,
};

const brokerUnreachable: ComputerUseBrokerInfo = {
  configured: true,
  reachable: false,
  url: 'https://127.0.0.1:7443',
  version: null,
  tls: true,
  computers: null,
  devices: null,
  connectorsOnline: null,
  checkedAt: '2026-10-29T23:00:00.000Z',
  error: 'connect ECONNREFUSED 127.0.0.1:7443',
};

function makeDevice(overrides: Partial<ComputerUseDeviceInfo> & { id: string; name: string }): ComputerUseDeviceInfo {
  return {
    state: 'online',
    location: 'office',
    tags: ['linux'],
    capabilities: ['exec.argv', 'fs.read', 'term.open', 'term.read', 'term.send', 'term.close'],
    meta: { hostname: 'alpha-host', platform: 'Ubuntu 24.04', version: '1.2.0' },
    lastSeen: new Date(NOW - 30_000).toISOString(),
    terminalCapable: true,
    ...overrides,
  };
}

const alphaDevice = makeDevice({ id: 'dev-alpha', name: 'alpha-pc' });

const betaDevice = makeDevice({
  id: 'dev-beta',
  name: 'beta-pc',
  state: 'offline',
  terminalCapable: false,
  capabilities: ['exec.argv'],
  meta: { hostname: 'beta-host', platform: 'Debian 12' },
  lastSeen: new Date(NOW - 3_600_000).toISOString(),
  tags: [],
});

const enrollment: ComputerUseEnrollmentInfo = {
  id: 'enr-001',
  kind: 'device',
  createdAt: new Date(NOW - 2 * 60_000).toISOString(),
  expiresAt: new Date(NOW + 12 * 60_000).toISOString(),
};

const connectorsResponse: ComputerUseConnectorsResponse = {
  broker: brokerOnline,
  devices: [alphaDevice, betaDevice],
  enrollments: [enrollment],
  publicBrokerUrl: 'https://broker.example.lan',
  counts: { devices: 2, online: 1, pendingEnrollments: 1 },
};

const unreachableResponse: ComputerUseConnectorsResponse = {
  broker: brokerUnreachable,
  devices: [],
  enrollments: [],
  publicBrokerUrl: null,
  counts: { devices: 0, online: 0, pendingEnrollments: 0 },
};

const terminalCommand =
  'curl -fsSL https://broker.example.lan/connect.sh | sudo bash -s -- --token tok_secret --name workstation-01 --terminal';

const enrollmentResponse: ComputerUseEnrollmentResponse = {
  enrollment: {
    id: 'enr-new',
    kind: 'device',
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
    token: 'tok_secret',
  },
  install: {
    command: terminalCommand,
    brokerUrl: 'https://broker.example.lan',
    connectorUrl: 'wss://broker.example.lan/connector',
    caUrl: 'https://broker.example.lan/ca.crt',
    allowTerminal: true,
    expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
  },
};

const newDevice = makeDevice({
  id: 'dev-new',
  name: 'workstation-01',
  state: 'online',
  meta: { hostname: 'workstation-01', platform: 'Ubuntu 24.04' },
});

const connectedResponse: ComputerUseConnectorsResponse = {
  ...connectorsResponse,
  devices: [...connectorsResponse.devices, newDevice],
  counts: { devices: 3, online: 2, pendingEnrollments: 0 },
};

// ---------------------------------------------------------------------------
// v0.12 physical computers (host fleet, stats, one-line install, connector)
// ---------------------------------------------------------------------------

const availableAvailability: ComputerUseAvailability = {
  available: true,
  state: 'available',
  reason: null,
  until: null,
  updatedAt: '2026-10-29T22:00:00.000Z',
  updatedBy: 'operator',
};

function makeHostComputer(
  overrides: Partial<ComputerUseComputerInfo> & { id: string; name: string },
): ComputerUseComputerInfo {
  return {
    template: 'physical-host',
    provider: 'host',
    state: 'online',
    viewer: 'rfbtouch',
    error: null,
    createdAt: '2026-10-30T20:00:00.000Z',
    ttlAt: null,
    desktop: { viewer: 'rfbtouch', width: 2560, height: 1440 },
    connector: { state: 'online', version: '1.0.0', lastSeen: new Date(NOW - 10_000).toISOString() },
    control: { held: false, holder: null, heldSince: null, expiresAt: null },
    availability: availableAvailability,
    liveUrl: null,
    ...overrides,
  };
}

const studioComputer = makeHostComputer({ id: 'host-studio', name: 'studio-pc' });

const containerComputer: ComputerUseComputerInfo = {
  ...makeHostComputer({ id: 'comp-alpha', name: 'Desktop Alpha' }),
  template: 'ubuntu-desktop',
  provider: 'docker',
  viewer: 'vnc',
  desktop: { viewer: 'vnc', width: 1920, height: 1080 },
};

const emptyFleet: ComputerUseComputersResponse = {
  broker: brokerOnline,
  availability: availableAvailability,
  computers: [],
};

const hostFleet: ComputerUseComputersResponse = {
  broker: brokerOnline,
  availability: availableAvailability,
  computers: [studioComputer, containerComputer],
};

const studioStats: ComputerUseStats = {
  hostname: 'studio-pc.local',
  os: 'Ubuntu 24.04',
  uptimeSeconds: 7_500,
  load: [0.42, 0.3, 0.2],
  cpu: { cores: 8, percent: 12 },
  memory: {
    totalBytes: 16 * 1024 ** 3,
    usedBytes: 8 * 1024 ** 3,
    availableBytes: 8 * 1024 ** 3,
    percent: 48,
  },
  swap: { totalBytes: 2 * 1024 ** 3, usedBytes: 0, percent: 0 },
  disk: { path: '/', totalBytes: 512 * 1024 ** 3, usedBytes: 312 * 1024 ** 3, percent: 61 },
  addresses: [
    { iface: 'lo', address: '127.0.0.1' },
    { iface: 'enp0s31f6', address: '10.10.1.20' },
  ],
  collectedAt: new Date(NOW - 3_000).toISOString(),
};

const hostInstallCommand =
  "curl -fsSLk 'https://10.10.1.4:7443/install/install-connector.sh' | bash -s -- --broker 'wss://10.10.1.4:7443/connector' --enroll 'tok_host' --kind computer --backend wayland --name 'studio-pc'";

const hostComputerResponse: ComputerUseHostComputer = {
  computer: studioComputer,
  install: {
    command: hostInstallCommand,
    brokerUrl: 'https://10.10.1.4:7443',
    connectorUrl: 'wss://10.10.1.4:7443/connector',
    caUrl: 'https://10.10.1.4:7443/install/broker-ca.pem',
    expiresAt: new Date(NOW + 15 * 60_000).toISOString(),
  },
};

const connectorUpdateResult = {
  ok: true,
  version: '1.1.0',
  connectorVersion: '1.0.0',
  result: { updated: true },
};

const connectorRemoveResult = {
  ok: true,
  connectorRemoved: true,
  computerRemoved: true,
};

beforeEach(() => {
  apiMock.getComputerUseConnectors.mockResolvedValue(connectorsResponse);
  apiMock.createComputerUseEnrollment.mockResolvedValue(enrollmentResponse);
  apiMock.revokeComputerUseEnrollment.mockResolvedValue(true);
  apiMock.openComputerUseTerminal.mockResolvedValue('sess-42');
  apiMock.readComputerUseTerminal.mockResolvedValue({ session: 'sess-42', lines: [], changed: false });
  apiMock.sendComputerUseTerminal.mockResolvedValue(true);
  apiMock.closeComputerUseTerminal.mockResolvedValue(true);
  apiMock.listComputerUseComputers.mockResolvedValue(emptyFleet);
  apiMock.getComputerUseStats.mockResolvedValue(studioStats);
  apiMock.createHostComputer.mockResolvedValue(hostComputerResponse);
  apiMock.updateComputerUseConnector.mockResolvedValue(connectorUpdateResult);
  apiMock.removeComputerUseConnector.mockResolvedValue(connectorRemoveResult);
  apiMock.computerUseLiveDesktopUrl.mockImplementation(
    (computerId: string) =>
      `/mcp/v1/admin/computer-use/computers/${computerId}/live-desktop`,
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Connectors page', () => {
  it('renders broker status, pending pairings and enrolled devices', async () => {
    render(
      <ToastProvider>
        <ConnectorsPage />
      </ToastProvider>,
    );

    // Broker status card: configured + reachable + version + TLS.
    expect(await screen.findByText('Broker status')).toBeTruthy();
    expect(screen.getByText('1.4.0')).toBeTruthy();
    expect(screen.getByText('https://127.0.0.1:7443')).toBeTruthy();
    expect(screen.getByText('https://broker.example.lan')).toBeTruthy();

    // Pending pairing row with its kind + revoke action.
    expect(screen.getByRole('heading', { name: 'Pending pairings' })).toBeTruthy();
    expect(screen.getByText('Linux PC')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke pairing enr-001' })).toBeTruthy();

    // Device cards: state, metadata, capabilities and terminal affordances.
    expect(screen.getByRole('article', { name: 'Connector alpha-pc' })).toBeTruthy();
    expect(screen.getByText('alpha-host · Ubuntu 24.04')).toBeTruthy();
    expect(screen.getByText('interactive terminal')).toBeTruthy();
    expect(screen.getByText('term.open')).toBeTruthy();
    const alphaCard = screen.getByRole('article', { name: 'Connector alpha-pc' });
    expect(
      within(alphaCard).getByRole('link', { name: /Broker UI/ }).getAttribute('href'),
    ).toBe('https://broker.example.lan/');

    const alphaTerminal = screen.getByRole('button', { name: 'Open terminal on alpha-pc' }) as HTMLButtonElement;
    expect(alphaTerminal.disabled).toBe(false);

    const betaTerminal = screen.getByRole('button', { name: 'Open terminal on beta-pc' }) as HTMLButtonElement;
    expect(betaTerminal.disabled).toBe(true);
    expect(screen.getByText(/does not advertise terminal support/)).toBeTruthy();

    expect(apiMock.getComputerUseConnectors).toHaveBeenCalledTimes(1);
  });

  it('adds a Linux PC, shows the install command and notices the new device', async () => {
    // First read = baseline device list; every later read already includes the
    // machine that has just claimed the pairing token.
    apiMock.getComputerUseConnectors
      .mockReset()
      .mockResolvedValueOnce(connectorsResponse)
      .mockResolvedValue(connectedResponse);

    render(
      <ToastProvider>
        <ConnectorsPage />
      </ToastProvider>,
    );
    await screen.findByRole('article', { name: 'Connector alpha-pc' });

    fireEvent.click(screen.getByRole('button', { name: 'Add Linux PC' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a Linux PC' });

    const nameInput = within(dialog).getByLabelText(/Machine name/) as HTMLInputElement;
    expect(nameInput.value).toBe('linux-pc');
    fireEvent.change(nameInput, { target: { value: 'workstation-01' } });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate pairing' }));

    await waitFor(() =>
      expect(apiMock.createComputerUseEnrollment).toHaveBeenCalledWith({
        kind: 'device',
        name: 'workstation-01',
        ttlSeconds: 3600,
        allowTerminal: true,
      }),
    );

    // Phase two: the copyable one-line installer, expiry and CA download.
    expect(await within(dialog).findByText(terminalCommand)).toBeTruthy();
    expect(within(dialog).getByText(/Waiting for workstation-01 to connect/)).toBeTruthy();
    expect(
      within(dialog).getByRole('link', { name: /Download broker CA/ }).getAttribute('href'),
    ).toBe('https://broker.example.lan/ca.crt');
    expect(within(dialog).getByRole('button', { name: 'Copy install command' })).toBeTruthy();

    // The 3 s poll (first tick runs immediately) sees the new device: toast + close + refresh.
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add a Linux PC' })).toBeNull(),
    );
    expect(await screen.findByText(/workstation-01 connected to the broker/)).toBeTruthy();
    await waitFor(() =>
      expect(apiMock.getComputerUseConnectors.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
  });

  it('revokes a pending pairing after confirmation', async () => {
    render(
      <ToastProvider>
        <ConnectorsPage />
      </ToastProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke pairing enr-001' }));
    const dialog = await screen.findByRole('dialog', { name: /Revoke pairing enr-001/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke pairing' }));

    await waitFor(() => expect(apiMock.revokeComputerUseEnrollment).toHaveBeenCalledWith('enr-001'));
    await waitFor(() => expect(apiMock.getComputerUseConnectors).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog', { name: /Revoke pairing enr-001/ })).toBeNull();
  });

  it('opens a terminal, reads output and sends a command', async () => {
    apiMock.readComputerUseTerminal
      .mockReset()
      .mockResolvedValueOnce({
        session: 'sess-42',
        lines: ['user@alpha:~$ ls'],
        changed: true,
      })
      .mockResolvedValue({
        session: 'sess-42',
        lines: ['user@alpha:~$ ls', 'file-a.txt', 'file-b.txt'],
        changed: true,
      });

    render(
      <ToastProvider>
        <ConnectorsPage />
      </ToastProvider>,
    );

    await screen.findByRole('article', { name: 'Connector alpha-pc' });
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal on alpha-pc' }));

    const dialog = await screen.findByRole('dialog', { name: 'Terminal — alpha-pc' });
    expect(apiMock.openComputerUseTerminal).toHaveBeenCalledWith('dev-alpha', { rows: 30, cols: 120 });

    const output = within(dialog).getByLabelText('Terminal output from alpha-pc');
    await waitFor(() => expect(output.textContent).toContain('user@alpha:~$ ls'));

    fireEvent.change(within(dialog).getByLabelText('Terminal command'), {
      target: { value: 'ls -la' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(apiMock.sendComputerUseTerminal).toHaveBeenCalledWith('dev-alpha', {
        session: 'sess-42',
        input: 'ls -la',
        enter: true,
      }),
    );
    await waitFor(() => expect(output.textContent).toContain('file-a.txt'));
    expect(apiMock.readComputerUseTerminal).toHaveBeenCalledWith('dev-alpha', {
      session: 'sess-42',
      lines: 500,
      waitSeconds: 1,
    });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(apiMock.closeComputerUseTerminal).toHaveBeenCalledWith('dev-alpha', 'sess-42'),
    );
  });

  it('explains an unreachable broker and blocks pairing', async () => {
    apiMock.getComputerUseConnectors.mockResolvedValue(unreachableResponse);

    render(
      <ToastProvider>
        <ConnectorsPage />
      </ToastProvider>,
    );

    expect((await screen.findAllByText('Broker unreachable')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('connect ECONNREFUSED 127.0.0.1:7443').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/unreachable, so pairing commands cannot be generated/)).toBeTruthy();

    const addButton = screen.getByRole('button', { name: 'Add Linux PC' }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);

    expect(screen.queryByRole('button', { name: /Revoke pairing/ })).toBeNull();
    expect(screen.getByText('No pending pairings')).toBeTruthy();
  });
});

describe('Connectors page — physical computers (v0.12)', () => {
  it('lists host computers with live stats and hides container desktops', async () => {
    apiMock.listComputerUseComputers.mockResolvedValue(hostFleet);

    render(
      <ToastProvider>
        <ConnectorsPage />
      </ToastProvider>,
    );

    const card = await screen.findByRole('article', { name: 'Physical computer studio-pc' });

    // Compact stats strip: CPU / memory / disk / uptime.
    expect(await within(card).findByText('12%')).toBeTruthy();
    expect(within(card).getByText('48%')).toBeTruthy();
    expect(within(card).getByText('61%')).toBeTruthy();
    expect(within(card).getByText('2h 5m')).toBeTruthy();
    expect(within(card).getByText(/studio-pc\.local/)).toBeTruthy();
    expect(within(card).getByText(/10\.10\.1\.20/)).toBeTruthy();
    expect(within(card).getByText('connector v1.0.0')).toBeTruthy();

    // Remote-desktop host only: the container desktop is not listed here.
    expect(screen.queryByText('Desktop Alpha')).toBeNull();

    // Live desktop hand-off and connector lifecycle actions.
    const liveLink = within(card).getByRole('link', { name: 'Open live desktop for studio-pc' });
    expect(liveLink.getAttribute('href')).toBe(
      '/mcp/v1/admin/computer-use/computers/host-studio/live-desktop',
    );
    expect(within(card).getByRole('button', { name: 'Update connector on studio-pc' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Remove connector on studio-pc' })).toBeTruthy();
    await waitFor(() => expect(apiMock.getComputerUseStats).toHaveBeenCalledWith('host-studio'));
  });

  it('creates a physical computer and shows the one-line bash installer', async () => {
    apiMock.listComputerUseComputers.mockResolvedValue(hostFleet);

    render(
      <ToastProvider>
        <ConnectorsPage />
      </ToastProvider>,
    );
    await screen.findByRole('article', { name: 'Physical computer studio-pc' });

    fireEvent.click(screen.getByRole('button', { name: 'Add physical computer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add physical computer' });

    const nameInput = within(dialog).getByLabelText(/Computer name/) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'render-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create install command' }));

    await waitFor(() => expect(apiMock.createHostComputer).toHaveBeenCalledWith('render-01'));

    const command = await within(dialog).findByLabelText('Physical computer install command');
    expect(command.textContent).toContain(hostInstallCommand);
    expect(command.textContent).toContain('--kind computer --backend wayland');
    expect(within(dialog).getByText(/single-use/i)).toBeTruthy();
    expect(within(dialog).getByText(/systemd --user/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Copy install command' })).toBeTruthy();

    // Closing refreshes the list so the new (offline) host shows up.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add physical computer' })).toBeNull(),
    );
    await waitFor(() =>
      expect(apiMock.listComputerUseComputers.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
  });

  it('updates a host connector after confirmation and shows the new version', async () => {
    apiMock.listComputerUseComputers.mockResolvedValue(hostFleet);

    render(
      <ToastProvider>
        <ConnectorsPage />
      </ToastProvider>,
    );
    const card = await screen.findByRole('article', { name: 'Physical computer studio-pc' });

    fireEvent.click(within(card).getByRole('button', { name: 'Update connector on studio-pc' }));
    const dialog = await screen.findByRole('dialog', { name: /Update connector on studio-pc/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update connector' }));

    await waitFor(() =>
      expect(apiMock.updateComputerUseConnector).toHaveBeenCalledWith('host-studio'),
    );
    expect(await screen.findByText(/is now running connector v1\.1\.0/)).toBeTruthy();
    await waitFor(() =>
      expect(apiMock.listComputerUseComputers.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
  });

  it('removes a host connector and optionally the computer', async () => {
    apiMock.listComputerUseComputers.mockResolvedValue(hostFleet);

    render(
      <ToastProvider>
        <ConnectorsPage />
      </ToastProvider>,
    );
    const card = await screen.findByRole('article', { name: 'Physical computer studio-pc' });

    fireEvent.click(within(card).getByRole('button', { name: 'Remove connector on studio-pc' }));
    const dialog = await screen.findByRole('dialog', { name: /Remove connector from studio-pc/ });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove connector' }));

    await waitFor(() =>
      expect(apiMock.removeComputerUseConnector).toHaveBeenCalledWith('host-studio', {
        removeComputer: true,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Remove connector from studio-pc/ })).toBeNull(),
    );
    await waitFor(() =>
      expect(apiMock.listComputerUseComputers.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
  });
});
