import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { WatcherService, parseWatcherSource } from '../../src/watchers/service.js';

function service(): WatcherService {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return new WatcherService(db);
}

describe('WatcherService', () => {
  it('keeps settings separate per source and defaults to enabled/all', () => {
    const watcher = service();
    const whatsapp = watcher.getOverview('whatsapp');
    expect(whatsapp.settings.enabled).toBe(true);
    expect(whatsapp.settings.mode).toBe('all');
    expect(whatsapp.settings.autoReply).toBe(false);
    expect(whatsapp.settings.draftOnly).toBe(true);
    expect(watcher.getOverview('instagram').settings.selected).toEqual([]);
  });

  it('saves a selected allowlist and refuses auto-reply', () => {
    const watcher = service();
    const overview = watcher.update(
      'whatsapp',
      { enabled: true, mode: 'selected', selected: ['447702088231', 'group:123@g.us'], autoReply: false },
      'craig',
    );
    expect(overview.settings.mode).toBe('selected');
    expect(overview.settings.selected).toEqual(['447702088231', 'group:123@g.us']);
    expect(overview.settings.updatedBy).toBe('craig');
    expect(() =>
      watcher.update('whatsapp', { enabled: true, mode: 'all', selected: [], autoReply: true }, 'craig'),
    ).toThrow(/Auto-reply is disabled/);
    expect(watcher.getSettings('whatsapp').autoReply).toBe(false);
  });

  it('does not let one source overwrite another', () => {
    const watcher = service();
    watcher.update('instagram', { enabled: false, mode: 'selected', selected: ['ig:matt'] }, 'craig');
    expect(watcher.getSettings('instagram').enabled).toBe(false);
    expect(watcher.getSettings('instagram').selected).toEqual(['ig:matt']);
    expect(watcher.getSettings('whatsapp').enabled).toBe(true);
    expect(watcher.getSettings('whatsapp').selected).toEqual([]);
  });

  it('persists Instagram auto-like options and validates usernames', () => {
    const watcher = service();
    expect(watcher.getSettings('instagram').autoLike).toEqual({
      cleoPosts: true,
      cleoStories: true,
      mentions: true,
      cleoPostComments: false,
      selectedAccounts: false,
      cleoAccounts: ['livecleo', 'livecleotv'],
    });
    const saved = watcher.update(
      'instagram',
      {
        enabled: true,
        mode: 'all',
        selected: [],
        autoLike: {
          cleoPosts: false,
          cleoStories: false,
          mentions: true,
          cleoPostComments: true,
          selectedAccounts: false,
          cleoAccounts: ['@livecleo'],
        },
      },
      'craig',
    );
    expect(saved.settings.autoLike.cleoPosts).toBe(false);
    expect(saved.settings.autoLike.cleoPostComments).toBe(true);
    expect(saved.settings.autoLike.cleoAccounts).toEqual(['livecleo']);
    expect(() =>
      watcher.update(
        'instagram',
        {
          enabled: true,
          mode: 'all',
          selected: [],
          autoLike: {
            cleoPosts: true,
            cleoStories: false,
            mentions: true,
            cleoPostComments: false,
            selectedAccounts: false,
            cleoAccounts: ['bad handle'],
          },
        },
        'craig',
      ),
    ).toThrow(/valid Instagram username/);
  });

  it('rejects malformed contact keys and dedupes the catalog', () => {
    const watcher = service();
    const result = watcher.syncContacts('instagram', [
      { key: 'ig:matt', name: 'Matt Frost', phone: null, kind: 'person' },
      { key: 'ig:matt', name: 'Matt duplicate', phone: null, kind: 'person' },
      { key: 'ig:drivers', name: 'Drivers', phone: null, kind: 'group' },
    ]);
    expect(result.count).toBe(2);
    expect(watcher.getOverview('instagram').contacts.map((contact) => contact.name)).toEqual([
      'Matt Frost',
      'Drivers',
    ]);
    expect(() =>
      watcher.syncContacts('instagram', [{ key: 'bad key', name: 'x', phone: null, kind: 'person' }]),
    ).toThrow(/unsupported characters/);
  });

  it('gives YouTube and X their own auto-like defaults', () => {
    const watcher = service();
    expect(watcher.getSettings('youtube').autoLike).toEqual({
      cleoAccounts: ['livecleo'],
      videos: true,
      shorts: true,
      comments: true,
      replies: true,
      mentions: true,
    });
    expect(watcher.getSettings('x').autoLike).toEqual({
      cleoAccounts: ['LiveCleoPatra'],
      posts: false,
      replies: false,
      quotes: false,
      mentions: true,
    });
  });

  it('persists YouTube and X auto-like classes without leaking into Instagram', () => {
    const watcher = service();
    const saved = watcher.update(
      'x',
      {
        enabled: true,
        mode: 'all',
        selected: [],
        autoLike: { posts: true, replies: false, quotes: true, mentions: false, cleoAccounts: ['@LiveCleoPatra'] },
      },
      'craig',
    );
    expect(saved.settings.autoLike).toEqual({
      cleoAccounts: ['LiveCleoPatra'],
      posts: true,
      replies: false,
      quotes: true,
      mentions: false,
    });
    // Instagram keeps its own classes, and X classes never appear on it.
    expect(watcher.getSettings('instagram').autoLike.cleoPosts).toBe(true);
    expect(watcher.getSettings('instagram').autoLike).not.toHaveProperty('posts');

    const youtube = watcher.update(
      'youtube',
      { enabled: false, mode: 'selected', selected: ['yt:livecleo'], autoLike: { videos: false, shorts: true, cleoAccounts: ['livecleo'] } },
      'craig',
    );
    expect(youtube.settings.enabled).toBe(false);
    expect(youtube.settings.autoLike).toMatchObject({ videos: false, shorts: true, comments: true });
    expect(youtube.settings.autoLike).not.toHaveProperty('cleoPosts');
  });

  it('accepts youtube and x as watcher sources and names them in the error', () => {
    expect(parseWatcherSource('youtube')).toBe('youtube');
    expect(parseWatcherSource('x')).toBe('x');
    expect(() => parseWatcherSource('tiktok')).toThrow(/whatsapp, instagram, youtube or x/);
  });
});
