/**
 * Tab model for the merged "Devices & computers" console page.
 *
 * The page replaces the former separate `Computer Use` and `Connectors`
 * pages. Everything below shares one route (`#/devices`) and one set of
 * polls, so the tab keys are also the `?tab=` deep-link values.
 */

export type DevicesTab = 'computers' | 'connectors' | 'providers' | 'access';

export const DEVICES_TABS: readonly { key: DevicesTab; label: string }[] = [
  { key: 'computers', label: 'Computers' },
  { key: 'connectors', label: 'Connectors' },
  { key: 'providers', label: 'VM providers' },
  { key: 'access', label: 'Agent access' },
];

/** True for a value that can be used as a devices tab (deep-link parsing). */
export function isDevicesTab(value: string | null | undefined): value is DevicesTab {
  return DEVICES_TABS.some((tab) => tab.key === value);
}

/** Default tab when `#/devices` carries no `?tab=`. */
export const DEFAULT_DEVICES_TAB: DevicesTab = 'computers';
