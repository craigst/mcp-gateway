/**
 * Social watcher settings (WhatsApp + Instagram push-to-Remy).
 *
 * The watcher processes run on cleo, outside the gateway. These settings live in
 * the gateway's `settings` table so the operator manages them in the console,
 * and each watcher polls its own source with a scoped `watcher-*` key.
 *
 * Auto-reply is deliberately impossible here: watchers only push events to
 * Remy, and Remy's replies are drafts that require explicit confirmation.
 */
import type { DatabaseSync } from 'node:sqlite';

import { invalidParams } from '../core/errors.js';
import { nowIso } from '../core/ids.js';
import { createLogger, type Logger } from '../core/logger.js';
import type {
  WatcherAutoLike,
  WatcherContact,
  WatcherMode,
  WatcherOverview,
  WatcherSettings,
  WatcherSettingsInput,
  WatcherSource,
} from '../core/types.js';

const SOURCES: readonly WatcherSource[] = ['whatsapp', 'instagram', 'youtube', 'x'];
const MAX_SELECTED = 500;
const MAX_CONTACTS = 2000;
const MAX_KEY_LENGTH = 128;
const MAX_NAME_LENGTH = 200;

const DEFAULT_AUTO_LIKE: WatcherAutoLike = {
  cleoPosts: true,
  cleoStories: true,
  mentions: true,
  cleoPostComments: false,
  selectedAccounts: false,
  cleoAccounts: ['livecleo', 'livecleotv'],
};

/**
 * YouTube has different things worth liking than an Instagram feed, so it gets
 * its own defaults: each class is independently toggleable for fine tuning.
 */
const DEFAULT_AUTO_LIKE_YOUTUBE: WatcherAutoLike = {
  cleoAccounts: ['livecleo'],
  videos: true,
  shorts: true,
  comments: true,
  replies: true,
  mentions: true,
};

/**
 * X has no separate "comment" object — a reply IS a post — so the likeable
 * classes are posts, replies, quotes and mentions, each toggled separately.
 */
const DEFAULT_AUTO_LIKE_X: WatcherAutoLike = {
  // Her YouTube/Instagram handle is 'livecleo'; on X it is 'LiveCleoPatra'.
  cleoAccounts: ['LiveCleoPatra'],
  // Mentions only by default: the operator does not want every post of hers
  // liked, only the posts that tag him. Each class stays independently switchable.
  posts: false,
  replies: false,
  quotes: false,
  mentions: true,
};

/** The auto-like default row for a source. */
function autoLikeDefaults(source: WatcherSource): WatcherAutoLike {
  if (source === 'youtube') return DEFAULT_AUTO_LIKE_YOUTUBE;
  if (source === 'x') return DEFAULT_AUTO_LIKE_X;
  return DEFAULT_AUTO_LIKE;
}

const DEFAULT_SETTINGS: WatcherSettings = {
  enabled: true,
  mode: 'all',
  selected: [],
  autoReply: false,
  draftOnly: true,
  autoLike: DEFAULT_AUTO_LIKE,
  updatedAt: null,
  updatedBy: null,
};

interface ContactsRecord {
  contacts: WatcherContact[];
  updatedAt: string | null;
}

const DEFAULT_CONTACTS: ContactsRecord = { contacts: [], updatedAt: null };

export function parseWatcherSource(raw: unknown): WatcherSource {
  if (raw === 'whatsapp' || raw === 'instagram' || raw === 'youtube' || raw === 'x') return raw;
  throw invalidParams(
    `Unknown watcher source “${String(raw)}”. Expected whatsapp, instagram, youtube or x.`,
  );
}

function settingsKey(source: WatcherSource): string {
  return `watcher:${source}:settings`;
}

function contactsKey(source: WatcherSource): string {
  return `watcher:${source}:contacts`;
}

function cleanKey(raw: unknown): string {
  if (typeof raw !== 'string') throw invalidParams('Each selected contact must be a string key.');
  const key = raw.trim();
  if (key === '' || key.length > MAX_KEY_LENGTH) {
    throw invalidParams(`A contact key must be 1–${MAX_KEY_LENGTH} characters.`);
  }
  if (!/^[A-Za-z0-9+_.:@-]+$/u.test(key)) {
    throw invalidParams(`Contact key “${key}” contains unsupported characters.`);
  }
  return key;
}

function normalizeAutoLike(
  raw: unknown,
  fallback: WatcherAutoLike,
  source: WatcherSource = 'instagram',
): WatcherAutoLike {
  if (raw === undefined || raw === null) return { ...fallback, cleoAccounts: [...fallback.cleoAccounts] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidParams('autoLike must be an object.');
  }
  const value = raw as Record<string, unknown>;
  const bool = (key: keyof WatcherAutoLike, from: boolean | undefined): boolean => {
    const candidate = value[key];
    if (candidate === undefined) return from ?? false;
    if (typeof candidate !== 'boolean') throw invalidParams(`autoLike.${key} must be true or false.`);
    return candidate;
  };
  const accountsRaw = value.cleoAccounts;
  let accounts = fallback.cleoAccounts;
  if (accountsRaw !== undefined) {
    if (!Array.isArray(accountsRaw)) throw invalidParams('autoLike.cleoAccounts must be an array.');
    if (accountsRaw.length > 20) throw invalidParams('At most 20 Cleo accounts may be watched.');
    accounts = [];
    for (const entry of accountsRaw) {
      if (typeof entry !== 'string') throw invalidParams('Each Cleo account must be a username.');
      const handle = entry.trim().replace(/^@/u, '');
      if (!/^[A-Za-z0-9._]{1,30}$/u.test(handle)) {
        throw invalidParams(`“${entry}” is not a valid Instagram username.`);
      }
      if (!accounts.includes(handle)) accounts.push(handle);
    }
  }
  if (source === 'x') {
    return {
      cleoAccounts: accounts,
      posts: bool('posts', fallback.posts),
      replies: bool('replies', fallback.replies),
      quotes: bool('quotes', fallback.quotes),
      mentions: bool('mentions', fallback.mentions),
    };
  }
  if (source === 'youtube') {
    return {
      cleoAccounts: accounts,
      videos: bool('videos', fallback.videos),
      shorts: bool('shorts', fallback.shorts),
      comments: bool('comments', fallback.comments),
      replies: bool('replies', fallback.replies),
      mentions: bool('mentions', fallback.mentions),
    };
  }
  return {
    cleoPosts: bool('cleoPosts', fallback.cleoPosts),
    cleoStories: bool('cleoStories', fallback.cleoStories),
    mentions: bool('mentions', fallback.mentions),
    cleoPostComments: bool('cleoPostComments', fallback.cleoPostComments),
    selectedAccounts: bool('selectedAccounts', fallback.selectedAccounts),
    cleoAccounts: accounts,
  };
}

function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') throw invalidParams('Each contact needs a name.');
  const name = raw.trim().replace(/\s+/gu, ' ');
  if (name === '' || name.length > MAX_NAME_LENGTH) {
    throw invalidParams(`A contact name must be 1–${MAX_NAME_LENGTH} characters.`);
  }
  return name;
}

export class WatcherService {
  private readonly logger: Logger;

  constructor(
    private readonly db: DatabaseSync,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger('watchers');
  }

  private read<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value?: unknown }
      | undefined;
    if (typeof row?.value !== 'string' || row.value === '') return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  private write(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value));
  }

  getSettings(source: WatcherSource): WatcherSettings {
    const saved = this.read<Partial<WatcherSettings>>(settingsKey(source), {});
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      // These invariants hold even if an older row said otherwise.
      autoReply: false,
      draftOnly: true,
      autoLike: normalizeAutoLike((saved as Partial<WatcherSettings>).autoLike, autoLikeDefaults(source), source),
      selected: Array.isArray(saved.selected) ? saved.selected.map(String) : [],
    };
  }

  getContacts(source: WatcherSource): ContactsRecord {
    const saved = this.read<Partial<ContactsRecord>>(contactsKey(source), DEFAULT_CONTACTS);
    return {
      contacts: Array.isArray(saved.contacts) ? saved.contacts : [],
      updatedAt: typeof saved.updatedAt === 'string' ? saved.updatedAt : null,
    };
  }

  getOverview(source: WatcherSource): WatcherOverview {
    const contacts = this.getContacts(source);
    return {
      settings: this.getSettings(source),
      contacts: contacts.contacts,
      contactsUpdatedAt: contacts.updatedAt,
    };
  }

  update(source: WatcherSource, input: WatcherSettingsInput, actor: string): WatcherOverview {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw invalidParams('Settings must be a JSON object.');
    }
    if (typeof input.enabled !== 'boolean') {
      throw invalidParams('enabled must be true or false.');
    }
    const mode: WatcherMode =
      input.mode === 'all' || input.mode === 'selected'
        ? input.mode
        : (() => {
            throw invalidParams('mode must be “all” or “selected”.');
          })();
    if (!Array.isArray(input.selected)) {
      throw invalidParams('selected must be an array of contact keys.');
    }
    if (input.selected.length > MAX_SELECTED) {
      throw invalidParams(`Select at most ${MAX_SELECTED} contacts.`);
    }
    if (input.autoReply === true) {
      throw invalidParams(
        'Auto-reply is disabled while draft mode is on. Remy drafts replies for your confirmation.',
      );
    }
    const selected = [...new Set(input.selected.map(cleanKey))];
    const existing = this.getSettings(source);
    const autoLike = normalizeAutoLike(input.autoLike, existing.autoLike, source);
    const settings: WatcherSettings = {
      enabled: input.enabled,
      mode,
      selected,
      autoReply: false,
      draftOnly: true,
      autoLike,
      updatedAt: nowIso(),
      updatedBy: actor,
    };
    this.write(settingsKey(source), settings);
    this.logger.info('watcher settings updated', {
      source,
      enabled: settings.enabled,
      mode: settings.mode,
      selected: settings.selected.length,
      actor,
    });
    return this.getOverview(source);
  }

  syncContacts(source: WatcherSource, raw: unknown): { count: number; updatedAt: string } {
    if (!Array.isArray(raw)) throw invalidParams('contacts must be an array.');
    if (raw.length > MAX_CONTACTS) throw invalidParams(`At most ${MAX_CONTACTS} contacts may be synced.`);
    const byKey = new Map<string, WatcherContact>();
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw invalidParams('Each contact must be an object.');
      }
      const record = entry as Record<string, unknown>;
      const key = cleanKey(record.key);
      if (byKey.has(key)) continue;
      const name = cleanName(record.name);
      const kind = record.kind === 'group' ? 'group' : 'person';
      const phone = typeof record.phone === 'string' && record.phone.trim() !== ''
        ? record.phone.trim()
        : null;
      byKey.set(key, { key, name, phone, kind });
    }
    const updatedAt = nowIso();
    this.write(contactsKey(source), { contacts: [...byKey.values()], updatedAt });
    this.logger.info('watcher contacts synced', { source, count: byKey.size });
    return { count: byKey.size, updatedAt };
  }
}

export function isWatcherSource(value: string): value is WatcherSource {
  return (SOURCES as readonly string[]).includes(value);
}
