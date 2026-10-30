import type { ReactNode } from 'react';
import { Badge } from '../../components/Badge.js';
import { ErrorState, Notice } from '../../components/States.js';
import { EmptyState } from '../../components/EmptyState.js';
import { SkeletonCards } from '../../components/Skeleton.js';
import { PrimaryButton, SecondaryButton, buttonSecondary } from '../../components/Form.js';
import { cx } from '../../lib/cx.js';
import { formatTimestamp } from '../../lib/format.js';
import type { ComputerUseDeviceInfo } from '../../../core/types.js';
import {
  deviceHostLabel,
  deviceStateTone,
  deviceVersion,
  isTerminalCapability,
  relativeTime,
  safeExternalUrl,
  terminalDisabledReason,
  visibleCapabilities,
} from './shared.js';

export interface DevicesSectionProps {
  devices: ComputerUseDeviceInfo[];
  loading: boolean;
  error: string | null;
  publicBrokerUrl: string | null;
  brokerReachable: boolean;
  brokerError: string | null;
  /** Reason pairing is unavailable, shown next to the empty-state action. */
  pairingBlockedReason: string | null;
  refreshing: boolean;
  onTerminal: (device: ComputerUseDeviceInfo) => void;
  onAdd: () => void;
  onRefresh: () => void;
}

function DeviceCard({
  device,
  brokerUiUrl,
  onTerminal,
}: {
  device: ComputerUseDeviceInfo;
  brokerUiUrl: string | null;
  onTerminal: (device: ComputerUseDeviceInfo) => void;
}) {
  const host = deviceHostLabel(device);
  const version = deviceVersion(device);
  const disabledReason = terminalDisabledReason(device);
  const capabilities = visibleCapabilities(device);

  return (
    <article
      aria-label={`Connector ${device.name}`}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4 shadow-lg shadow-black/20"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-slate-100" title={device.name}>
            {device.name}
          </h3>
          <p className="mt-0.5 truncate text-[11px] text-slate-400" title={host ?? undefined}>
            {host ?? 'Host details not reported'}
          </p>
        </div>
        <Badge tone={deviceStateTone(device.state)}>{device.state}</Badge>
      </div>

      <dl className="grid grid-cols-2 gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
        <div className="min-w-0">
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Last seen</dt>
          <dd
            className="mt-0.5 text-[11px] text-slate-300"
            title={device.lastSeen !== null ? formatTimestamp(device.lastSeen) : undefined}
          >
            {device.lastSeen !== null ? relativeTime(device.lastSeen) : 'never'}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Connector</dt>
          <dd className="mt-0.5 truncate text-[11px] text-slate-300">
            {version !== null ? `v${version}` : device.location ?? '—'}
            {version !== null && device.location !== null ? ` · ${device.location}` : ''}
          </dd>
        </div>
      </dl>

      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Capabilities</p>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {device.terminalCapable && <Badge tone="accent">interactive terminal</Badge>}
          {capabilities.length === 0 ? (
            <span className="text-[11px] text-slate-500">none advertised</span>
          ) : (
            capabilities.map((capability) => (
              <Badge
                key={capability}
                tone={isTerminalCapability(capability) ? 'info' : 'neutral'}
                className={isTerminalCapability(capability) ? 'font-semibold' : undefined}
              >
                {capability}
              </Badge>
            ))
          )}
        </div>
        {device.tags.length > 0 && (
          <p className="mt-1 text-[10px] text-slate-500">tags: {device.tags.join(', ')}</p>
        )}
      </div>

      <div className="mt-auto space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span
            title={disabledReason ?? undefined}
            className={disabledReason !== null ? 'inline-flex' : undefined}
          >
            <SecondaryButton
              onClick={() => onTerminal(device)}
              disabled={disabledReason !== null}
              className="px-2.5 py-1.5 text-xs"
              aria-label={`Open terminal on ${device.name}`}
            >
              Terminal
            </SecondaryButton>
          </span>
          {brokerUiUrl !== null && (
            <a
              href={brokerUiUrl}
              target="_blank"
              rel="noreferrer"
              className={cx(buttonSecondary, 'px-2.5 py-1.5 text-xs')}
            >
              Broker UI ↗
            </a>
          )}
          <span className="font-mono text-[10px] text-slate-600">{device.id}</span>
        </div>
        {disabledReason !== null && (
          <p className="text-[10px] leading-relaxed text-slate-500">{disabledReason}</p>
        )}
      </div>
    </article>
  );
}

/** Device connector cards: state, metadata, capabilities and terminal access. */
export function DevicesSection({
  devices,
  loading,
  error,
  publicBrokerUrl,
  brokerReachable,
  brokerError,
  pairingBlockedReason,
  refreshing,
  onTerminal,
  onAdd,
  onRefresh,
}: DevicesSectionProps) {
  const brokerUiUrl = safeExternalUrl(publicBrokerUrl);

  let body: ReactNode;
  if (loading && devices.length === 0 && error === null) {
    body = <SkeletonCards count={2} />;
  } else if (error !== null && devices.length === 0) {
    body = <ErrorState message={error} onRetry={onRefresh} />;
  } else if (devices.length === 0) {
    body = brokerReachable ? (
      <EmptyState
        icon="⌁"
        title="No Linux PCs connected yet"
        description="Pair a machine with a one-line install command. Once its connector dials out to the broker it appears here with a live state badge and terminal access."
        action={
          <div className="flex flex-col items-center gap-1">
            <PrimaryButton
              onClick={onAdd}
              disabled={pairingBlockedReason !== null}
              title={pairingBlockedReason ?? undefined}
              className="px-3 py-1.5 text-xs"
            >
              Add Linux PC
            </PrimaryButton>
            {pairingBlockedReason !== null && (
              <p className="max-w-sm text-[11px] text-amber-300/80">{pairingBlockedReason}</p>
            )}
          </div>
        }
      />
    ) : (
      <EmptyState
        icon="🔌"
        title="Broker unreachable"
        description={
          brokerError !== null && brokerError.trim() !== ''
            ? brokerError
            : 'The Computer Broker is offline, so no device connectors can be listed. Reconnect the broker to see paired machines and pair new ones.'
        }
        action={
          <SecondaryButton onClick={onRefresh} disabled={refreshing} className="px-3 py-1.5 text-xs">
            {refreshing ? 'Checking…' : 'Check again'}
          </SecondaryButton>
        }
      />
    );
  } else {
    body = (
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {devices.map((device) => (
          <DeviceCard key={device.id} device={device} brokerUiUrl={brokerUiUrl} onTerminal={onTerminal} />
        ))}
      </div>
    );
  }

  return (
    <section aria-labelledby="connector-devices-heading" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 id="connector-devices-heading" className="text-base font-semibold text-slate-100">
            Devices
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            {devices.length} connector{devices.length === 1 ? '' : 's'} enrolled with the broker
            {brokerReachable ? '' : ' · broker offline'}.
          </p>
        </div>
        <SecondaryButton onClick={onRefresh} disabled={refreshing} className="px-3 py-1.5 text-xs">
          {refreshing ? 'Refreshing…' : 'Refresh devices'}
        </SecondaryButton>
      </div>

      {devices.length > 0 && error !== null && (
        <Notice tone="warning" title="Device list may be stale">
          {error}
        </Notice>
      )}

      {body}
    </section>
  );
}
