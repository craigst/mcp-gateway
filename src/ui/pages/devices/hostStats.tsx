/**
 * Live host stats for physical computers in the unified Computers grid.
 *
 * Host PCs run the Computer Broker connector in remote-desktop mode; the
 * broker exposes their CPU/memory/disk/uptime through `system.stats`. This
 * module polls that endpoint for online hosts only, keeps the last good
 * snapshot on transient failures, and pauses while the tab is hidden.
 *
 * Extracted from the retired v0.12 "Physical computers" connectors section so
 * the merged page shows hosts once, inside the fleet.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatBytes } from '../../lib/format.js';
import { relativeTime } from '../connectors/shared.js';
import type { ComputerUseComputerInfo, ComputerUseStats } from '../../../core/types.js';

/** Per-host system stats poll interval (online hosts only). */
const STATS_POLL_MS = 5_000;

const ONLINE_STATES = new Set(['online', 'ready', 'available', 'connected', 'active', 'idle']);

/** True when the broker reports a host connector that is up. */
export function isHostOnline(state: string): boolean {
  return ONLINE_STATES.has(state.trim().toLowerCase());
}

function isLoopbackAddress(address: string): boolean {
  return address === '::1' || address.startsWith('127.') || address.startsWith('fe80:');
}

/** Best-effort "hostname · IPv4" for the stats strip. */
export function primaryAddress(stats: ComputerUseStats): string | null {
  const usable = stats.addresses.filter(
    (entry) => typeof entry.address === 'string' && entry.address.trim() !== '' && !isLoopbackAddress(entry.address),
  );
  const ipv4 = usable.find((entry) => entry.address.includes('.'));
  return (ipv4 ?? usable[0])?.address ?? null;
}

/** Compact uptime copy: `3d 4h`, `5h 12m`, `42m`. */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Reason "Update connector" is unavailable for a host, or null when allowed.
 * Only hosts (remote-desktop connectors) support the pushed update.
 */
export function connectorUpdateBlockedReason(computer: ComputerUseComputerInfo): string | null {
  if (computer.connector === null) return 'This computer has no connector registered.';
  if (!isHostOnline(computer.state)) return 'The connector must be online before it can be updated.';
  return null;
}

/** Reason "Remove connector" is unavailable for a host, or null when allowed. */
export function connectorRemoveBlockedReason(computer: ComputerUseComputerInfo): string | null {
  return computer.connector === null ? 'This computer has no connector to remove.' : null;
}

/**
 * Poll `system.stats` for every online host. Keeps the last good snapshot on
 * transient failures, pauses while the tab is hidden, and checks once on
 * return. Offline hosts are skipped entirely (the card explains why).
 */
export function useHostStats(
  hosts: readonly ComputerUseComputerInfo[],
): Record<string, ComputerUseStats> {
  const [stats, setStats] = useState<Record<string, ComputerUseStats>>({});
  const onlineIds = hosts.filter((host) => isHostOnline(host.state)).map((host) => host.id);
  const onlineKey = onlineIds.join(',');
  const idsRef = useRef<string[]>(onlineIds);
  idsRef.current = onlineIds;

  useEffect(() => {
    if (onlineKey === '') return undefined;
    let disposed = false;

    const load = async (): Promise<void> => {
      if (disposed) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const ids = idsRef.current;
      if (ids.length === 0) return;
      const entries = await Promise.all(
        ids.map(async (id): Promise<readonly [string, ComputerUseStats] | null> => {
          try {
            return [id, await api.getComputerUseStats(id)] as const;
          } catch {
            // Keep the last good snapshot; the card keeps showing the last values.
            return null;
          }
        }),
      );
      if (disposed) return;
      setStats((current) => {
        const next = { ...current };
        let changed = false;
        for (const entry of entries) {
          if (entry === null) continue;
          next[entry[0]] = entry[1];
          changed = true;
        }
        return changed ? next : current;
      });
    };

    void load();
    const timer = setInterval(() => void load(), STATS_POLL_MS);
    const onVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') void load();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    return () => {
      disposed = true;
      clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [onlineKey]);

  return stats;
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-100">{value}</dd>
      {hint !== undefined && <p className="truncate text-[10px] text-slate-500" title={hint}>{hint}</p>}
    </div>
  );
}

/** CPU / memory / disk / uptime strip for one host computer. */
export function HostStatsStrip({
  computer,
  stats,
}: {
  computer: ComputerUseComputerInfo;
  stats: ComputerUseStats | null;
}) {
  const online = isHostOnline(computer.state);
  if (!online) {
    return (
      <p className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-[11px] text-slate-500">
        Connector {computer.connector?.state ?? 'offline'} — stats and live desktop are unavailable
        until the PC reconnects.
      </p>
    );
  }
  if (stats === null) {
    return (
      <p role="status" className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-[11px] text-slate-500">
        Collecting system stats…
      </p>
    );
  }

  const address = primaryAddress(stats);
  const firstLoad = stats.load[0];
  const load = firstLoad !== undefined && Number.isFinite(firstLoad) ? firstLoad : null;

  return (
    <div className="space-y-1.5 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
        <Metric
          label="CPU"
          value={`${Math.round(stats.cpu.percent)}%`}
          hint={`${stats.cpu.cores} cores${load === null ? '' : ` · load ${load.toFixed(2)}`}`}
        />
        <Metric
          label="Memory"
          value={`${Math.round(stats.memory.percent)}%`}
          hint={`${formatBytes(stats.memory.usedBytes)} / ${formatBytes(stats.memory.totalBytes)}`}
        />
        <Metric
          label="Disk"
          value={`${Math.round(stats.disk.percent)}%`}
          hint={`${formatBytes(stats.disk.usedBytes)} / ${formatBytes(stats.disk.totalBytes)}`}
        />
        <Metric label="Uptime" value={formatUptime(stats.uptimeSeconds)} />
      </dl>
      <p className="truncate text-[10px] text-slate-500" title={stats.os}>
        {stats.hostname}
        {address !== null ? ` · ${address}` : ''}
        {stats.os !== '' ? ` · ${stats.os}` : ''}
        <span className="ml-1 text-slate-600">
          (updated {relativeTime(stats.collectedAt)})
        </span>
      </p>
    </div>
  );
}
