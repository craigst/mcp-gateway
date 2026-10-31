import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { Badge } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Notice, ErrorState } from '../../components/States.js';
import { EmptyState } from '../../components/EmptyState.js';
import { SkeletonCards } from '../../components/Skeleton.js';
import {
  CheckboxField,
  DangerButton,
  PrimaryButton,
  SecondaryButton,
  buttonSecondary,
} from '../../components/Form.js';
import { useToast } from '../../components/Toasts.js';
import { cx } from '../../lib/cx.js';
import { formatBytes, formatTimestamp } from '../../lib/format.js';
import { useLiveData } from '../computer-use/useLiveData.js';
import { computerStateTone, connectorTone } from '../computer-use/shared.js';
import { AddHostComputerDialog } from './AddHostComputerDialog.js';
import { relativeTime } from './shared.js';
import type {
  ComputerUseComputerInfo,
  ComputerUseConnectorUpdateResult,
  ComputerUseStats,
} from '../../../core/types.js';

/** Fleet (host computer list) poll interval. */
const FLEET_POLL_MS = 5_000;
/** Per-host system stats poll interval (online hosts only). */
const STATS_POLL_MS = 5_000;

const ONLINE_STATES = new Set(['online', 'ready', 'available', 'connected', 'active', 'idle']);

function isHostOnline(state: string): boolean {
  return ONLINE_STATES.has(state.trim().toLowerCase());
}

function isLoopbackAddress(address: string): boolean {
  return address === '::1' || address.startsWith('127.') || address.startsWith('fe80:');
}

/** Best-effort "hostname · IPv4" for the stats strip. */
function primaryAddress(stats: ComputerUseStats): string | null {
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
 * Poll `system.stats` for every online host. Keeps the last good snapshot on
 * transient failures, pauses while the tab is hidden, and checks once on
 * return. Offline hosts are skipped entirely (the card explains why).
 */
function useHostStats(hosts: readonly ComputerUseComputerInfo[]): Record<string, ComputerUseStats> {
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

function HostStatsStrip({ computer, stats }: { computer: ComputerUseComputerInfo; stats: ComputerUseStats | null }) {
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

interface HostComputerCardProps {
  computer: ComputerUseComputerInfo;
  stats: ComputerUseStats | null;
  liveDesktopUrl: string;
  busy: boolean;
  onUpdate: (computer: ComputerUseComputerInfo) => void;
  onRemove: (computer: ComputerUseComputerInfo) => void;
}

function updateDisabledReason(computer: ComputerUseComputerInfo): string | null {
  if (computer.connector === null) return 'This computer has no connector registered.';
  if (!isHostOnline(computer.state)) return 'The connector must be online before it can be updated.';
  return null;
}

function HostComputerCard({ computer, stats, liveDesktopUrl, busy, onUpdate, onRemove }: HostComputerCardProps) {
  const connector = computer.connector;
  const updateReason = updateDisabledReason(computer);
  const removeReason = connector === null ? 'This computer has no connector to remove.' : null;

  return (
    <article
      aria-label={`Physical computer ${computer.name}`}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4 shadow-lg shadow-black/20"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-slate-100" title={computer.name}>
            {computer.name}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Badge tone={computerStateTone(computer.state)}>{computer.state}</Badge>
            {connector !== null ? (
              <>
                <Badge tone={connectorTone(connector.state)}>{connector.state}</Badge>
                {connector.version !== null && <Badge tone="neutral">connector v{connector.version}</Badge>}
              </>
            ) : (
              <Badge tone="warning">no connector</Badge>
            )}
            {connector?.lastSeen != null && (
              <span className="text-[10px] text-slate-500" title={formatTimestamp(connector.lastSeen)}>
                seen {relativeTime(connector.lastSeen)}
              </span>
            )}
          </div>
        </div>
        <span className="font-mono text-[10px] text-slate-600">{computer.id}</span>
      </div>

      <HostStatsStrip computer={computer} stats={stats} />

      <div className="mt-auto flex flex-wrap items-center gap-2">
        <a
          href={liveDesktopUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open live desktop for ${computer.name}`}
          className={cx(buttonSecondary, 'px-2.5 py-1.5 text-xs')}
        >
          Open live desktop ↗
        </a>
        <span title={updateReason ?? undefined} className="inline-flex">
          <SecondaryButton
            onClick={() => onUpdate(computer)}
            disabled={busy || updateReason !== null}
            aria-label={`Update connector on ${computer.name}`}
            className="px-2.5 py-1.5 text-xs"
          >
            Update connector
          </SecondaryButton>
        </span>
        <span title={removeReason ?? undefined} className="inline-flex">
          <DangerButton
            onClick={() => onRemove(computer)}
            disabled={busy || removeReason !== null}
            aria-label={`Remove connector on ${computer.name}`}
            className="px-2.5 py-1.5 text-xs"
          >
            Remove connector
          </DangerButton>
        </span>
      </div>
    </article>
  );
}

/**
 * v0.12 "Physical computers" section: host PCs running the Computer Broker
 * connector in remote-desktop mode (the Computer Use fleet), with live stats,
 * one-line onboarding, connector update and remote removal. The shell/file
 * device connectors stay in the existing Devices section below.
 */
export function PhysicalComputersSection() {
  const toast = useToast();
  const fleet = useLiveData(() => api.listComputerUseComputers(), { intervalMs: FLEET_POLL_MS });

  const [addOpen, setAddOpen] = useState(false);
  const [updateTarget, setUpdateTarget] = useState<ComputerUseComputerInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<{
    name: string;
    version: string | null;
    previousVersion: string | null;
  } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ComputerUseComputerInfo | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeComputer, setRemoveComputer] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const hosts = (fleet.data?.computers ?? []).filter((computer) => computer.provider === 'host');
  const stats = useHostStats(hosts);
  const { refresh } = fleet;
  const brokerReachable = fleet.data?.broker.reachable === true;
  const addDisabledReason =
    fleet.data === null
      ? fleet.loading
        ? 'Waiting for the Computer Use fleet to load…'
        : (fleet.error ?? 'The Computer Use fleet is unavailable.')
      : !brokerReachable
        ? 'The Computer Broker is unreachable, so the one-line installer cannot be generated.'
        : null;
  const busyId = updateBusy ? (updateTarget?.id ?? null) : removeBusy ? (removeTarget?.id ?? null) : null;

  const openUpdate = (computer: ComputerUseComputerInfo): void => {
    setUpdateError(null);
    setUpdateTarget(computer);
  };

  const confirmUpdate = async (): Promise<void> => {
    if (updateTarget === null) return;
    setUpdateBusy(true);
    setUpdateError(null);
    try {
      const result: ComputerUseConnectorUpdateResult = await api.updateComputerUseConnector(updateTarget.id);
      setLastUpdate({
        name: updateTarget.name,
        version: result.version,
        previousVersion: result.connectorVersion,
      });
      toast(
        'success',
        result.version !== null
          ? `Connector on ${updateTarget.name} updated to v${result.version}.`
          : `Connector on ${updateTarget.name} updated.`,
      );
      setUpdateTarget(null);
      refresh();
    } catch (error) {
      setUpdateError(formatApiError(error));
    } finally {
      setUpdateBusy(false);
    }
  };

  const openRemove = (computer: ComputerUseComputerInfo): void => {
    setRemoveError(null);
    setRemoveComputer(false);
    setRemoveTarget(computer);
  };

  const confirmRemove = async (): Promise<void> => {
    if (removeTarget === null) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      const result = await api.removeComputerUseConnector(removeTarget.id, { removeComputer });
      toast(
        'success',
        result.computerRemoved
          ? `${removeTarget.name} and its connector were removed.`
          : `Connector removed from ${removeTarget.name}.`,
      );
      setRemoveTarget(null);
      setRemoveComputer(false);
      refresh();
    } catch (error) {
      setRemoveError(formatApiError(error));
    } finally {
      setRemoveBusy(false);
    }
  };

  let body: ReactNode;
  if (fleet.loading && fleet.data === null) {
    body = <SkeletonCards count={2} />;
  } else if (fleet.data === null && fleet.error !== null) {
    body = <ErrorState message={fleet.error} onRetry={refresh} />;
  } else if (hosts.length === 0) {
    body = (
      <EmptyState
        icon="🖥"
        title="No physical computers yet"
        description="Add a PC to mint its one-line installer. The connector runs in the desktop session, dials out to the broker, and shows up here with live CPU, memory and disk stats. Remote-desktop computers only — shell/file devices are listed below."
        action={
          <div className="flex flex-col items-center gap-1">
            <PrimaryButton
              onClick={() => setAddOpen(true)}
              disabled={addDisabledReason !== null}
              title={addDisabledReason ?? undefined}
              className="px-3 py-1.5 text-xs"
            >
              Add physical computer
            </PrimaryButton>
            {addDisabledReason !== null && (
              <p className="max-w-sm text-[11px] text-amber-300/80">{addDisabledReason}</p>
            )}
          </div>
        }
      />
    );
  } else {
    body = (
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {hosts.map((computer) => (
          <HostComputerCard
            key={computer.id}
            computer={computer}
            stats={stats[computer.id] ?? null}
            liveDesktopUrl={api.computerUseLiveDesktopUrl(computer.id)}
            busy={busyId === computer.id}
            onUpdate={openUpdate}
            onRemove={openRemove}
          />
        ))}
      </div>
    );
  }

  return (
    <section aria-labelledby="physical-computers-heading" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 id="physical-computers-heading" className="text-base font-semibold text-slate-100">
            Physical computers
          </h2>
          <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-slate-400">
            Host PCs running the Computer Broker connector in remote-desktop mode — the Computer Use
            fleet agents control. Stats refresh every 5 s while a host is online. Shell and file
            connectors stay in the <span className="font-medium text-slate-300">Devices</span> section
            below.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={hosts.length > 0 ? 'info' : 'neutral'}>
            {hosts.length} host{hosts.length === 1 ? '' : 's'}
          </Badge>
          <SecondaryButton onClick={refresh} disabled={fleet.refreshing} className="px-3 py-1.5 text-xs">
            {fleet.refreshing ? 'Refreshing…' : 'Refresh hosts'}
          </SecondaryButton>
          <span title={addDisabledReason ?? undefined} className="inline-flex">
            <PrimaryButton
              onClick={() => setAddOpen(true)}
              disabled={addDisabledReason !== null}
              className="px-3 py-1.5 text-xs"
            >
              Add physical computer
            </PrimaryButton>
          </span>
        </div>
      </div>

      {addDisabledReason !== null && fleet.data !== null && (
        <p className="text-[11px] text-amber-300/80" role="note">
          {addDisabledReason}
        </p>
      )}

      {lastUpdate !== null && (
        <Notice tone="success" title="Connector updated" onDismiss={() => setLastUpdate(null)}>
          {lastUpdate.name} is now running connector{' '}
          {lastUpdate.version !== null ? `v${lastUpdate.version}` : 'an updated build'}
          {lastUpdate.previousVersion !== null && lastUpdate.previousVersion !== ''
            ? ` (was v${lastUpdate.previousVersion})`
            : ''}
          . The connector reconnects automatically.
        </Notice>
      )}

      {fleet.data !== null && fleet.error !== null && (
        <Notice tone="warning" title="Physical computer list may be stale">
          {fleet.error}
        </Notice>
      )}

      {body}

      <AddHostComputerDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={refresh}
      />

      <ConfirmDialog
        open={updateTarget !== null}
        title={updateTarget === null ? 'Update connector' : `Update connector on ${updateTarget.name}`}
        description="The broker pushes its current connector bundle, swaps it in and restarts the connector service. The PC stays usable; live desktop may drop for a few seconds."
        confirmLabel="Update connector"
        cancelLabel="Cancel"
        busy={updateBusy}
        onConfirm={() => void confirmUpdate()}
        onCancel={() => {
          if (!updateBusy) setUpdateTarget(null);
        }}
      >
        <div className="space-y-2 text-xs text-slate-400">
          {updateTarget?.connector?.version != null && (
            <p>
              Currently running connector v{updateTarget.connector.version}. A successful update is
              shown here and in the list as the new version.
            </p>
          )}
          {updateError !== null && (
            <Notice tone="error" title="Connector update failed" onDismiss={() => setUpdateError(null)}>
              {updateError}
            </Notice>
          )}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={removeTarget !== null}
        title={removeTarget === null ? 'Remove connector' : `Remove connector from ${removeTarget.name}`}
        tone="danger"
        confirmLabel="Remove connector"
        cancelLabel="Cancel"
        busy={removeBusy}
        onConfirm={() => void confirmRemove()}
        onCancel={() => {
          if (!removeBusy) setRemoveTarget(null);
        }}
      >
        <div className="space-y-3 text-xs text-slate-400">
          <p>
            This disables and removes the connector on the PC and deletes its identity, so it can no
            longer reconnect. The machine is not affected otherwise.
          </p>
          <CheckboxField
            label={
              <span>
                Also remove this computer from the fleet
                <span className="block text-[11px] text-slate-500">
                  Drops its history, desktop and stats. Leave unchecked to keep the computer listed
                  without a connector.
                </span>
              </span>
            }
            checked={removeComputer}
            onChange={setRemoveComputer}
            disabled={removeBusy}
          />
          {removeError !== null && (
            <Notice tone="error" title="Connector removal failed" onDismiss={() => setRemoveError(null)}>
              {removeError}
            </Notice>
          )}
        </div>
      </ConfirmDialog>
    </section>
  );
}
