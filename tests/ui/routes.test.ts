/**
 * Hash routing for the console shell.
 *
 * The Devices & computers merge replaced two page keys with one, so the legacy
 * `#/computer-use` and `#/connectors` hashes must keep working (bookmarks and
 * any documentation links), and `#/devices?tab=…` must deep-link a tab.
 */
import { describe, expect, it } from 'vitest';
import { pageHash, parseHash } from '../../src/ui/lib/routes.js';

describe('parseHash', () => {
  it('parses the merged devices page and its tabs', () => {
    expect(parseHash('#/devices')).toMatchObject({ page: 'devices', devicesTab: 'computers' });
    expect(parseHash('#/devices?tab=connectors')).toMatchObject({
      page: 'devices',
      devicesTab: 'connectors',
    });
    expect(parseHash('#/devices?tab=providers')).toMatchObject({
      page: 'devices',
      devicesTab: 'providers',
    });
    expect(parseHash('#/devices?tab=access')).toMatchObject({
      page: 'devices',
      devicesTab: 'access',
    });
  });

  it('falls back to Computers for an unknown devices tab', () => {
    expect(parseHash('#/devices?tab=nope').devicesTab).toBe('computers');
  });

  it('aliases the retired page hashes onto the merged page', () => {
    expect(parseHash('#/computer-use')).toMatchObject({
      page: 'devices',
      devicesTab: 'computers',
    });
    expect(parseHash('#/connectors')).toMatchObject({
      page: 'devices',
      devicesTab: 'connectors',
    });
  });

  it('keeps the other page routes and their aliases', () => {
    expect(parseHash('')).toMatchObject({ page: 'dashboard' });
    expect(parseHash('#/devices')).toMatchObject({ page: 'devices' });
    expect(parseHash('devices')).toMatchObject({ page: 'devices' });
    expect(parseHash('#/vaultwarden')).toMatchObject({ page: 'secrets', devicesTab: null });
    expect(parseHash('#/catalog?tab=import')).toMatchObject({
      page: 'catalog',
      catalogTab: 'import',
    });
    expect(parseHash('#/server/srv_brain')).toMatchObject({
      page: 'server',
      serverId: 'srv_brain',
    });
    expect(parseHash('#/rbac/key_1')).toMatchObject({ page: 'rbac', keyId: 'key_1' });
    expect(parseHash('#/not-a-page')).toMatchObject({ page: 'dashboard' });
  });
});

describe('pageHash', () => {
  it('builds plain and tabbed hashes', () => {
    expect(pageHash('devices')).toBe('#/devices');
    expect(pageHash('devices', { devicesTab: 'connectors' })).toBe('#/devices?tab=connectors');
    expect(pageHash('catalog', { catalogTab: 'sources' })).toBe('#/catalog?tab=sources');
    expect(pageHash('dashboard')).toBe('#/dashboard');
  });
});
