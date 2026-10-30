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
  ComputerUseBrokerInfo,
  ComputerUseConnectorsResponse,
  ComputerUseDeviceInfo,
  ComputerUseEnrollmentInfo,
  ComputerUseEnrollmentResponse,
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

beforeEach(() => {
  apiMock.getComputerUseConnectors.mockResolvedValue(connectorsResponse);
  apiMock.createComputerUseEnrollment.mockResolvedValue(enrollmentResponse);
  apiMock.revokeComputerUseEnrollment.mockResolvedValue(true);
  apiMock.openComputerUseTerminal.mockResolvedValue('sess-42');
  apiMock.readComputerUseTerminal.mockResolvedValue({ session: 'sess-42', lines: [], changed: false });
  apiMock.sendComputerUseTerminal.mockResolvedValue(true);
  apiMock.closeComputerUseTerminal.mockResolvedValue(true);
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
