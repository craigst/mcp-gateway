// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { apiMock } = vi.hoisted(() => ({ apiMock: { listServers: vi.fn(), rpc: vi.fn() } }));
vi.mock('../../src/ui/lib/api.js', async (original) => ({ ...(await original<typeof import('../../src/ui/lib/api.js')>()), api: apiMock }));
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KnowledgePage } from '../../src/ui/pages/Knowledge.js';

beforeEach(() => {
  apiMock.listServers.mockResolvedValue([{ id: 'brain1', name: 'brain', status: 'running' }, { id: 'brain2', name: 'brain-full', status: 'running' }, { id: 'other', name: 'email', status: 'running' }]);
  apiMock.rpc.mockResolvedValue({ content: [{ type: 'text', text: 'A saved memory' }] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Knowledge', () => {
  it('searches only the selected existing server and renders its response', async () => {
    const open = vi.fn();
    render(<KnowledgePage onOpenServer={open} />);
    await screen.findByText('Knowledge servers');
    expect(apiMock.rpc).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Knowledge server'), { target: { value: 'brain2' } });
    fireEvent.change(screen.getByLabelText('Search in'), { target: { value: 'knowledge_search' } });
    fireEvent.change(screen.getByLabelText('Search query'), { target: { value: 'meeting notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(apiMock.rpc).toHaveBeenCalledWith('tools/call', { serverId: 'brain2', name: 'knowledge_search', arguments: { query: 'meeting notes' } }));
    expect(await screen.findByText('A saved memory')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Manage server →' })[1]!);
    expect(open).toHaveBeenCalledWith('brain2');
  });
  it('handles a gateway without a brain server', async () => {
    apiMock.listServers.mockResolvedValue([{ id: 'other', name: 'email', status: 'running' }]);
    render(<KnowledgePage />);
    expect(await screen.findByText('No brain server found')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
  });
});
