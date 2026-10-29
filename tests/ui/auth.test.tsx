// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getSession: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    onUnauthorized: vi.fn(),
    getHealth: vi.fn(),
    getMetrics: vi.fn(),
    listServers: vi.fn(),
  },
}));

vi.mock('../../src/ui/lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/lib/api.js')>();
  return { ...actual, api: apiMock };
});

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../../src/ui/App.js';
import { ApiError } from '../../src/ui/lib/api.js';
import type { MetricsSnapshot } from '../../src/core/ports.js';

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

function unauthorized(): ApiError {
  return new ApiError({ status: 401, code: 401, message: 'Unauthorized' });
}

beforeEach(() => {
  apiMock.getHealth.mockResolvedValue({ status: 'ok', version: '0.3.0', uptimeMs: 1000 });
  apiMock.getMetrics.mockResolvedValue(metricsSnapshot());
  apiMock.listServers.mockResolvedValue([]);
  apiMock.logout.mockResolvedValue({ ok: true });
  apiMock.onUnauthorized.mockReturnValue(() => {});
  apiMock.login.mockResolvedValue({ user: { username: 'operator' }, expiresAt: '2026-10-30T00:00:00.000Z' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  if (typeof window !== 'undefined') window.location.hash = '';
});

async function signInThroughForm(username = 'operator', password = 'correct-horse'): Promise<void> {
  fireEvent.change(screen.getByPlaceholderText('operator'), { target: { value: username } });
  fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('App session gating', () => {
  it('renders the login page when GET /auth/me returns 401', async () => {
    apiMock.getSession.mockRejectedValue(unauthorized());
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Gateway Console' })).toBeTruthy();
    expect(screen.getByPlaceholderText('operator')).toBeTruthy();
    const password = screen.getByPlaceholderText('••••••••') as HTMLInputElement;
    expect(password.type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect((screen.getByPlaceholderText('••••••••') as HTMLInputElement).type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect((screen.getByPlaceholderText('••••••••') as HTMLInputElement).type).toBe('password');

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByText('Dashboard')).toBeNull();
    expect(await screen.findByText(/Gateway online · v0.3.0/)).toBeTruthy();
    expect(apiMock.getSession).toHaveBeenCalledTimes(1);
  });

  it('renders the shell when GET /auth/me is authenticated', async () => {
    apiMock.getSession.mockResolvedValue({ authenticated: true, user: { username: 'operator' } });
    render(<App />);

    expect(await screen.findByText('Requests / min')).toBeTruthy();
    expect(screen.getAllByText('operator').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Sign out' }).length).toBeGreaterThan(0);
    expect(screen.queryByPlaceholderText('••••••••')).toBeNull();
    expect(await screen.findByText('Gateway online')).toBeTruthy();
  });

  it('submits credentials, enters the shell and wires the 401 listener', async () => {
    apiMock.getSession.mockRejectedValue(unauthorized());
    render(<App />);

    await screen.findByRole('button', { name: 'Sign in' });
    await signInThroughForm('operator', 'correct-horse');

    await waitFor(() => expect(apiMock.login).toHaveBeenCalledWith('operator', 'correct-horse'));
    expect(await screen.findByText('Requests / min')).toBeTruthy();
    expect(screen.getAllByText('operator').length).toBeGreaterThan(0);
    expect(apiMock.onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('shows a friendly inline error for bad credentials and stays on the login page', async () => {
    apiMock.getSession.mockRejectedValue(unauthorized());
    apiMock.login.mockRejectedValue(unauthorized());
    render(<App />);

    await screen.findByRole('button', { name: 'Sign in' });
    await signInThroughForm('operator', 'wrong-password');

    expect(await screen.findByText('Invalid username or password.')).toBeTruthy();
    expect(screen.queryByText('Requests / min')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('signs out through the API and returns to the login page', async () => {
    apiMock.getSession.mockResolvedValue({ authenticated: true, user: { username: 'operator' } });
    render(<App />);

    await screen.findByText('Requests / min');
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0] as HTMLElement);

    await waitFor(() => expect(apiMock.logout).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByText('Requests / min')).toBeNull();
  });

  it('returns to login when a later request reports 401 (session expiry)', async () => {
    apiMock.getSession.mockResolvedValue({ authenticated: true, user: { username: 'operator' } });
    render(<App />);

    await screen.findByText('Requests / min');
    const handler = apiMock.onUnauthorized.mock.calls[0]?.[0] as ((error: unknown) => void) | undefined;
    expect(typeof handler).toBe('function');

    act(() => handler?.(unauthorized()));

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByText('Requests / min')).toBeNull();
  });
});
