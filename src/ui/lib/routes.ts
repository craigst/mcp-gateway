/**
 * Console routing: page keys and hash parsing.
 *
 * Navigation is state based (no router dependency); the URL hash mirrors the
 * active page so a refresh or a shared link lands on the same place. Legacy
 * page names from before the "Devices & computers" merge are aliased here so
 * old bookmarks keep working.
 */
import type { CatalogTab } from '../pages/catalog/shared.js';
import type { DevicesTab } from '../pages/devices/tabs.js';
import { DEFAULT_DEVICES_TAB, isDevicesTab } from '../pages/devices/tabs.js';

export type PageKey =
  | 'dashboard'
  | 'email'
  | 'catalog'
  | 'devices'
  | 'server'
  | 'configurations'
  | 'secrets'
  | 'settings'
  | 'vaultwarden'
  | 'rbac'
  | 'vault'
  | 'audit'
  | 'delegation'
  | 'playground';

/** Keys that may appear as a top-level `#/<page>` route (`server` is special). */
export const PAGE_KEYS: readonly string[] = [
  'dashboard',
  'email',
  'catalog',
  'devices',
  'configurations',
  'secrets',
  'rbac',
  'vault',
  'audit',
  'delegation',
  'playground',
  'settings',
];

export interface HashLocation {
  page: PageKey;
  catalogTab: CatalogTab | null;
  devicesTab: DevicesTab | null;
  /** Set when the hash is `#/server/<id>`. */
  serverId: string | null;
  /** Set when the hash is `#/rbac/<keyId>`. */
  keyId: string | null;
}

function isPageKey(value: string): value is PageKey {
  return PAGE_KEYS.includes(value);
}

function isCatalogTab(value: string | null): value is CatalogTab {
  return value === 'installed' || value === 'discover' || value === 'sources' || value === 'import';
}

function emptyLocation(page: PageKey): HashLocation {
  return { page, catalogTab: null, devicesTab: null, serverId: null, keyId: null };
}

/**
 * Parse `window.location.hash` (with or without the leading `#`) into a page.
 * Unknown pages fall back to the dashboard; unknown tabs are ignored.
 *
 * Aliases kept for backwards compatibility:
 * - `#/vaultwarden` → Secrets
 * - `#/computer-use` → Devices & computers · Computers
 * - `#/connectors`   → Devices & computers · Connectors
 */
export function parseHash(rawHash: string): HashLocation {
  const raw = rawHash.replace(/^#\/?/, '').trim();
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const segments = pathPart.split('/').filter((segment) => segment.length > 0);
  const tab = new URLSearchParams(queryPart).get('tab');

  if (segments[0] === 'server' && segments[1] !== undefined) {
    return {
      ...emptyLocation('server'),
      serverId: decodeURIComponent(segments[1]),
    };
  }

  // Backwards-compatible alias: the Vault Warden page is now Secrets.
  if (segments[0] === 'vaultwarden') {
    return emptyLocation('secrets');
  }

  // Backwards-compatible aliases from the pre-merge two-page console.
  if (segments[0] === 'computer-use') {
    return { ...emptyLocation('devices'), devicesTab: 'computers' };
  }
  if (segments[0] === 'connectors') {
    return { ...emptyLocation('devices'), devicesTab: 'connectors' };
  }

  if (segments[0] === 'rbac' && segments[1] !== undefined) {
    return {
      ...emptyLocation('rbac'),
      keyId: decodeURIComponent(segments[1]),
    };
  }

  const page = isPageKey(segments[0] ?? '') ? (segments[0] as PageKey) : 'dashboard';
  return {
    page,
    catalogTab: isCatalogTab(tab) ? tab : null,
    devicesTab: page === 'devices' && isDevicesTab(tab) ? tab : page === 'devices' ? DEFAULT_DEVICES_TAB : null,
    serverId: null,
    keyId: null,
  };
}

/** Build the hash for a page (used by every navigation helper in `App`). */
export function pageHash(
  page: PageKey,
  options: { catalogTab?: CatalogTab | null; devicesTab?: DevicesTab | null } = {},
): string {
  const tab = options.catalogTab ?? options.devicesTab ?? null;
  return tab === null ? `#/${page}` : `#/${page}?tab=${tab}`;
}
