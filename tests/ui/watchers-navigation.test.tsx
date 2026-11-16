// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SectionNav } from '../../src/ui/components/SectionNav.js';
import { parseHash } from '../../src/ui/lib/routes.js';

vi.mock('../../src/ui/pages/configurations/WatcherCard.js', () => ({
  WatcherCard: ({ source }: { source: string }) => <div>Watcher controls: {source}</div>,
}));
vi.mock('../../src/ui/pages/configurations/InstagramSessionCard.js', () => ({
  InstagramSessionCard: () => <div>Instagram session controls</div>,
}));
vi.mock('../../src/ui/lib/api.js', () => ({ api: {
  listServers: vi.fn().mockResolvedValue([{ id: 'watchers', name: 'social-watchers' }]),
  rpc: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ sources: [{ source: 'whatsapp', pid: 123 }, { source: 'instagram', pid: null }] }) }] }),
} }));
import { WatchersPage } from '../../src/ui/pages/Watchers.js';

afterEach(() => { cleanup(); window.location.hash = ''; });

describe('consolidated navigation', () => {
  it('groups settings while retaining direct destinations', () => {
    const onNavigate = vi.fn();
    render(<SectionNav current="configurations" section="settings" onNavigate={onNavigate} />);
    expect(screen.getByRole('button', { name: 'Server profiles' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: 'Vault secrets' }));
    expect(onNavigate).toHaveBeenCalledWith('vault');
    fireEvent.click(screen.getByRole('button', { name: 'API keys & access' }));
    expect(onNavigate).toHaveBeenCalledWith('rbac');
    expect(parseHash('#/configurations').page).toBe('configurations');
    expect(parseHash('#/vaultwarden').page).toBe('secrets');
  });

  it('opens a specific watcher from a link and changes channels without rendering unrelated controls', () => {
    window.location.hash = '#/watchers?source=instagram';
    render(<WatchersPage />);
    expect(screen.getByText('Watcher controls: instagram')).toBeTruthy();
    expect(screen.getByText('Instagram session controls')).toBeTruthy();
    expect(screen.getByText('Watcher controls: whatsapp').closest('[role=tabpanel]')?.hasAttribute('hidden')).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'WhatsApp' }));
    expect(screen.getByText('Watcher controls: whatsapp')).toBeTruthy();
    expect(screen.getByText('Instagram session controls').closest('[role=tabpanel]')?.hasAttribute('hidden')).toBe(true);
    expect(window.location.hash).toBe('#/watchers?source=whatsapp');
    expect(parseHash(window.location.hash).page).toBe('watchers');
  });

  it('distinguishes a reported process, a stopped process and an unreported source', async () => {
    render(<WatchersPage />);
    expect(await screen.findByText(/manager reports a running process/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Instagram' }));
    expect(screen.getByText(/manager reports this worker is stopped/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'X' }));
    expect(screen.getByText(/manager does not report a worker/)).toBeTruthy();
  });
});
