// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { apiMock } = vi.hoisted(() => ({ apiMock: { listServers: vi.fn(), rpc: vi.fn(), getManagedKnowledge: vi.fn(), uploadKnowledgeDocument: vi.fn(), listManagedDocuments: vi.fn(), retryManagedDocument: vi.fn() } }));
vi.mock('../../src/ui/lib/api.js', async (original) => ({ ...(await original<typeof import('../../src/ui/lib/api.js')>()), api: apiMock }));
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KnowledgePage } from '../../src/ui/pages/Knowledge.js';

beforeEach(() => {
  apiMock.listServers.mockResolvedValue([{ id: 'brain1', name: 'brain', status: 'running' }, { id: 'brain2', name: 'brain-full', status: 'running' }, { id: 'other', name: 'email', status: 'running' }]);
  apiMock.rpc.mockResolvedValue({ content: [{ type: 'text', text: 'A saved memory' }] });
  apiMock.getManagedKnowledge.mockResolvedValue({ configured: false, categories: [] });
  apiMock.listManagedDocuments.mockResolvedValue({ documents: [], has_more: false });
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
  it('uploads a document to a category supplied by the managed service', async () => {
    apiMock.getManagedKnowledge.mockResolvedValue({ configured: true, categories: [{ name: 'homelab', sensitive: false }] });
    apiMock.uploadKnowledgeDocument.mockResolvedValue({ document_id: 12 });
    render(<KnowledgePage />);
    await screen.findAllByRole('option', { name: 'homelab' });
    const file = new File(['document'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Document'), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'homelab' } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload document' }));
    await waitFor(() => expect(apiMock.uploadKnowledgeDocument).toHaveBeenCalledWith(file, 'homelab'));
    expect(await screen.findByText('The document was uploaded and indexed.')).toBeTruthy();
  });
  it('lists catalogue documents and retries an interrupted index', async () => {
    apiMock.getManagedKnowledge.mockResolvedValue({ configured: true, categories: [{ name: 'homelab', sensitive: false }] });
    apiMock.listManagedDocuments.mockResolvedValue({ documents: [{ id: 21, filename: 'notes.txt', category: 'homelab', index_state: 'pending', ingested_at: null, page_count: null }], has_more: false });
    apiMock.retryManagedDocument.mockResolvedValue({ repaired: true });
    render(<KnowledgePage />);
    expect(await screen.findByText('notes.txt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry indexing' }));
    await waitFor(() => expect(apiMock.retryManagedDocument).toHaveBeenCalledWith(21));
    expect(apiMock.listManagedDocuments).toHaveBeenCalledWith('', 0);
  });

  it('shows that a staging copy is read-only and disables upload', async () => {
    apiMock.getManagedKnowledge.mockResolvedValue({ configured: true, readOnly: true, categories: [{ name: 'homelab', sensitive: false }] });
    render(<KnowledgePage />);
    expect(await screen.findByText('Staging copy is read-only')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Upload document' }) as HTMLButtonElement).disabled).toBe(true);
  });

});
