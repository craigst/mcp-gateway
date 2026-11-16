// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { getWatcher } = vi.hoisted(() => ({ getWatcher: vi.fn() }));
vi.mock('../../src/ui/lib/api.js', async (original) => ({
  ...await original<typeof import('../../src/ui/lib/api.js')>(),
  api: { getWatcher },
}));
import { WatcherCard } from '../../src/ui/pages/configurations/WatcherCard.js';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('watcher contacts', () => {
  it('adds a synced contact by name and protects unsaved selections from refresh', async () => {
    getWatcher.mockResolvedValue({
      settings: { enabled: true, mode: 'selected', selected: [], autoLike: { cleoAccounts: [] }, updatedAt: null },
      contacts: [{ key: 'group:example', name: 'Work friends', phone: null, kind: 'group' }],
      contactsUpdatedAt: '2026-11-16T12:00:00Z',
    });
    render(<WatcherCard source="whatsapp" />);
    const picker = await screen.findByRole('combobox', { name: 'Choose a synced contact or group' });
    expect(screen.getByRole('option', { name: 'Work friends (group)' })).toBeTruthy();
    fireEvent.change(picker, { target: { value: 'group:example' } });
    expect(screen.getByRole('button', { name: /Work friends/ })).toBeTruthy();
    for (const refresh of screen.getAllByRole('button', { name: 'Refresh' })) expect((refresh as HTMLButtonElement).disabled).toBe(true);
    expect(getWatcher).toHaveBeenCalledTimes(1);
  });
});
