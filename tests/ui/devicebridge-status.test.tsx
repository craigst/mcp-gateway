// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { mockApi } = vi.hoisted(() => ({ mockApi: { listServers: vi.fn(), rpc: vi.fn() } }));
vi.mock('../../src/ui/lib/api.js', async (original) => ({ ...(await original<typeof import('../../src/ui/lib/api.js')>()), api: mockApi }));
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DeviceBridgeStatus, parseDeviceBridgeResult } from '../../src/ui/pages/devices/DeviceBridgeStatus.js';

beforeEach(() => {
  mockApi.listServers.mockResolvedValue([{ id: 'bridge-1', name: 'devicebridge' }]);
  mockApi.rpc.mockResolvedValue({ structuredContent: { result: JSON.stringify({ devices: [{ device_id: 'a', name: 'Gaming PC', online: true }, { device_id: 'b', name: 'Laptop', online: false }] }) }, isError: false });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('DeviceBridge inventory', () => {
  it('loads explicitly and shows names and reported states without modifying devices', async () => {
    const onOpenServer = vi.fn();
    render(<DeviceBridgeStatus onOpenServer={onOpenServer} />);
    expect(mockApi.rpc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Load devices' }));
    await waitFor(() => expect(mockApi.rpc).toHaveBeenCalledWith('tools/call', { serverId: 'bridge-1', name: 'device_list', arguments: {} }));
    const pc = (await screen.findByText('Gaming PC')).closest('li')!;
    expect(within(pc).getByText('online')).toBeTruthy();
    expect(within(screen.getByText('Laptop').closest('li')!).getByText('offline')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Manage DeviceBridge server →' }));
    expect(onOpenServer).toHaveBeenCalledWith('bridge-1');
  });
  it('handles unavailable and malformed responses without inventing online status', () => {
    expect(() => parseDeviceBridgeResult({ isError: true })).toThrow();
    expect(() => parseDeviceBridgeResult({ structuredContent: { result: 'not json' } })).toThrow();
    expect(parseDeviceBridgeResult({ content: [{ type: 'text', text: '{"devices":[{"device_id":"x","name":"Unknown"}]}' }] })[0]?.state).toBe('unknown');
  });
});
