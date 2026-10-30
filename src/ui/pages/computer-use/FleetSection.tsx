import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Badge } from '../../components/Badge.js';
import { ErrorState, Notice } from '../../components/States.js';
import { EmptyState } from '../../components/EmptyState.js';
import { SkeletonCards } from '../../components/Skeleton.js';
import {
  DangerButton,
  GhostButton,
  PrimaryButton,
  SecondaryButton,
  buttonSecondary,
} from '../../components/Form.js';
import { cx } from '../../lib/cx.js';
import { api } from '../../lib/api.js';
import { formatTimestamp } from '../../lib/format.js';
import type {
  ComputerUseComputerInfo,
  ComputerUseComputersResponse,
} from '../../../core/types.js';
import {
  computerStateTone,
  connectorTone,
  frameSrc,
  isComputerRunning,
  resumeAtLabel,
} from './shared.js';

export interface FleetSectionProps {
  data: ComputerUseComputersResponse | null;
  loading: boolean;
  error: string | null;
  refreshing: boolean;
  /** Increments every ~3 s while the document is visible; drives frame refresh. */
  frameTick: number;
  /** Computer id with an in-flight action, if any. */
  busyKey: string | null;
  onRefresh: () => void;
  onOpenSettings: () => void;
  onPause: (computer: ComputerUseComputerInfo) => void;
  onEditPause: (computer: ComputerUseComputerInfo) => void;
  onResume: (computer: ComputerUseComputerInfo) => void;
  onStart: (computer: ComputerUseComputerInfo) => void;
  onStop: (computer: ComputerUseComputerInfo) => void;
}

interface FrameProps {
  computer: ComputerUseComputerInfo;
  frameTick: number;
  maxWidth: number;
  alt: string;
  className?: string;
}

/** `<img>` live frame with a graceful placeholder and automatic retry each tick. */
function LiveFrame({ computer, frameTick, maxWidth, alt, className }: FrameProps) {
  const [failedTick, setFailedTick] = useState<number | null>(null);
  const running = isComputerRunning(computer.state);
  const showFrame = running && failedTick !== frameTick;

  if (!showFrame) {
    return (
      <div
        className={cx(
          'flex h-full w-full flex-col items-center justify-center gap-1 bg-slate-950 px-4 text-center',
          className,
        )}
      >
        <span aria-hidden="true" className="text-2xl text-slate-700">
          ▢
        </span>
        <p className="text-[11px] font-medium text-slate-400">
          {running ? 'Preview unavailable' : `Desktop ${computer.state}`}
        </p>
        <p className="text-[10px] text-slate-600">
          {running ? 'The broker returned no frame — retrying automatically.' : 'Start the desktop to load its preview.'}
        </p>
      </div>
    );
  }

  return (
    <img
      src={frameSrc(api.computerUseFrameUrl(computer.id, maxWidth), frameTick)}
      alt={alt}
      onError={() => setFailedTick(frameTick)}
      className={cx('h-full w-full object-contain', className)}
      loading="lazy"
    />
  );
}

interface ComputerCardProps {
  computer: ComputerUseComputerInfo;
  frameTick: number;
  busy: boolean;
  globalPaused: boolean;
  onPreview: (computer: ComputerUseComputerInfo) => void;
  onPause: (computer: ComputerUseComputerInfo) => void;
  onEditPause: (computer: ComputerUseComputerInfo) => void;
  onResume: (computer: ComputerUseComputerInfo) => void;
  onStart: (computer: ComputerUseComputerInfo) => void;
  onStop: (computer: ComputerUseComputerInfo) => void;
}

function ComputerCard({
  computer,
  frameTick,
  busy,
  globalPaused,
  onPreview,
  onPause,
  onEditPause,
  onResume,
  onStart,
  onStop,
}: ComputerCardProps) {
  const running = isComputerRunning(computer.state);
  const available = computer.availability.available;
  const paused = computer.availability.state === 'paused';
  // The fleet response merges global availability into every computer, so a
  // paused tile may be paused globally rather than individually.
  const individuallyPaused = paused && !globalPaused;
  const liveUrl = computer.liveUrl === null ? null : api.computerUseLiveDesktopUrl(computer.id);
  const connector = computer.connector;

  return (
    <article
      aria-label={`Computer ${computer.name}`}
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60 shadow-lg shadow-black/20"
    >
      <button
        type="button"
        onClick={() => onPreview(computer)}
        aria-label={`Open larger live preview of ${computer.name}`}
        className="group relative block aspect-video w-full overflow-hidden border-b border-slate-800 bg-slate-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
      >
        <LiveFrame
          computer={computer}
          frameTick={frameTick}
          maxWidth={480}
          alt={`Live screen of ${computer.name}`}
        />
        <span className="absolute left-2 top-2">
          <Badge tone={computerStateTone(computer.state)}>{computer.state}</Badge>
        </span>
        {running && (
          <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full border border-emerald-800 bg-slate-950/85 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
            <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            live
          </span>
        )}
        <span className="absolute bottom-2 right-2 rounded-md bg-slate-950/85 px-2 py-0.5 text-[10px] font-medium text-slate-300 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          Enlarge preview
        </span>
      </button>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h3 className="truncate text-sm font-semibold text-slate-100" title={computer.name}>
              {computer.name}
            </h3>
            <Badge tone={available ? 'success' : 'warning'}>{available ? 'agents allowed' : 'agents paused'}</Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Badge tone="neutral">{computer.template}</Badge>
            <Badge tone="info">{computer.provider}</Badge>
            {computer.desktop.width !== null && computer.desktop.height !== null && (
              <Badge tone="neutral">
                {computer.desktop.width}×{computer.desktop.height}
              </Badge>
            )}
            <span className="font-mono text-[10px] text-slate-600">{computer.id}</span>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
          <div className="min-w-0">
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Connector</dt>
            <dd className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-slate-400">
              {connector === null ? (
                <span className="text-slate-500">none</span>
              ) : (
                <>
                  <Badge tone={connectorTone(connector.state)}>{connector.state}</Badge>
                  {connector.version !== null && <span>v{connector.version}</span>}
                  {connector.lastSeen !== null && (
                    <span className="basis-full text-[10px] text-slate-600" title={formatTimestamp(connector.lastSeen)}>
                      seen {formatTimestamp(connector.lastSeen)}
                    </span>
                  )}
                </>
              )}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Broker control</dt>
            <dd className="mt-0.5 text-[11px] text-slate-400">
              {computer.control.held ? (
                <span className="flex flex-wrap items-center gap-1">
                  <Badge tone="warning">held</Badge>
                  <span className="break-all">{computer.control.holder ?? 'another session'}</span>
                </span>
              ) : (
                <span className="text-slate-500">free</span>
              )}
            </dd>
          </div>
        </dl>

        {computer.error !== null && (
          <Notice tone="error" title="Broker error">
            {computer.error}
          </Notice>
        )}

        <div className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-slate-200">Agent availability</p>
              <p className="text-[11px] text-slate-500">
                {available ? 'This computer accepts agent calls.' : 'Calls are refused with COMPUTER_PAUSED.'}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={available}
              aria-label={
                globalPaused
                  ? `Agent use on ${computer.name} (blocked by the global pause)`
                  : `Agent use available on ${computer.name}`
              }
              disabled={busy || globalPaused}
              title={globalPaused ? 'Resume the global pause first' : undefined}
              onClick={() => {
                if (available) onPause(computer);
                else onResume(computer);
              }}
              className={cx(
                'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                available ? 'border-emerald-700 bg-emerald-600/70' : 'border-slate-700 bg-slate-800',
              )}
            >
              <span
                aria-hidden="true"
                className={cx(
                  'inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform',
                  available ? 'translate-x-4' : 'translate-x-0.5',
                )}
              />
            </button>
          </div>

          {individuallyPaused && (
            <div className="mt-2 space-y-1 border-t border-slate-800 pt-2">
              <p className="text-[11px] text-amber-200/80">
                {computer.availability.reason !== null && computer.availability.reason.trim() !== ''
                  ? computer.availability.reason
                  : 'No reason given.'}
              </p>
              <p className="text-[10px] text-slate-500">
                Paused {resumeAtLabel(computer.availability.until)}.
                {computer.availability.updatedBy !== null
                  ? ` By ${computer.availability.updatedBy}.`
                  : ''}
              </p>
              <GhostButton onClick={() => onEditPause(computer)} disabled={busy}>
                Edit pause
              </GhostButton>
            </div>
          )}

          {globalPaused && (
            <p className="mt-2 border-t border-slate-800 pt-2 text-[11px] text-amber-300/80">
              Global pause active — resume it from the availability card above to re-enable agents
              on this computer.
            </p>
          )}
        </div>

        <div className="mt-auto space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {running ? (
              <DangerButton onClick={() => onStop(computer)} disabled={busy} className="px-2.5 py-1.5 text-xs">
                {busy ? 'Stopping…' : 'Stop'}
              </DangerButton>
            ) : (
              <SecondaryButton onClick={() => onStart(computer)} disabled={busy} className="px-2.5 py-1.5 text-xs">
                {busy ? 'Starting…' : 'Start'}
              </SecondaryButton>
            )}
            {liveUrl !== null ? (
              <a
                href={liveUrl}
                target="_blank"
                rel="noreferrer"
                className={cx(buttonSecondary, 'px-2.5 py-1.5 text-xs')}
              >
                Open live desktop ↗
              </a>
            ) : (
              <span className="text-[11px] text-slate-500">Live link unavailable</span>
            )}
          </div>
          <p className="text-[10px] leading-relaxed text-slate-500">
            Live control happens in the broker&apos;s own desktop UI. Pause availability here to stop agent
            access at any time.
          </p>
        </div>
      </div>
    </article>
  );
}

interface PreviewDialogProps {
  computer: ComputerUseComputerInfo;
  frameTick: number;
  onClose: () => void;
}

/** Centered modal with a larger, auto-refreshing frame and the live-desktop link. */
function PreviewDialog({ computer, frameTick, onClose }: PreviewDialogProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const liveUrl = computer.liveUrl === null ? null : api.computerUseLiveDesktopUrl(computer.id);
  const running = isComputerRunning(computer.state);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/80 p-4 backdrop-blur-sm sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Live preview of ${computer.name}`}
        className="w-full max-w-5xl rounded-xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/50"
      >
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold text-slate-100">{computer.name}</h2>
            <Badge tone={computerStateTone(computer.state)}>{computer.state}</Badge>
            {running && <Badge tone="success">live preview</Badge>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-800"
          >
            ✕
          </button>
        </header>
        <div className="bg-slate-950">
          <div className="aspect-video w-full">
            <LiveFrame
              computer={computer}
              frameTick={frameTick}
              maxWidth={1280}
              alt={`Large live preview of ${computer.name}`}
            />
          </div>
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 px-5 py-3">
          <p className="text-[11px] text-slate-500">
            Refreshes every 3 s while the desktop is running. Live keyboard/mouse control happens in the
            broker UI.
          </p>
          <div className="flex items-center gap-2">
            {liveUrl !== null && (
              <a
                href={liveUrl}
                target="_blank"
                rel="noreferrer"
                className={cx(buttonSecondary, 'px-3 py-1.5 text-xs')}
              >
                Open live desktop ↗
              </a>
            )}
            <SecondaryButton onClick={onClose} className="px-3 py-1.5 text-xs">
              Close
            </SecondaryButton>
          </div>
        </footer>
      </div>
    </div>
  );
}

/** Fleet grid: every broker computer with a live frame and local availability control. */
export function FleetSection({
  data,
  loading,
  error,
  refreshing,
  frameTick,
  busyKey,
  onRefresh,
  onOpenSettings,
  onPause,
  onEditPause,
  onResume,
  onStart,
  onStop,
}: FleetSectionProps) {
  const [preview, setPreview] = useState<ComputerUseComputerInfo | null>(null);
  const computers = data?.computers ?? [];
  const globalPaused = data?.availability.state === 'paused';
  const configured = data?.broker.configured === true;

  let body: ReactNode;
  if (data === null) {
    body = loading ? <SkeletonCards count={2} /> : error !== null ? <ErrorState message={error} onRetry={onRefresh} /> : null;
  } else if (computers.length === 0) {
    body = configured ? (
      <EmptyState
        icon="🖥"
        title="No computers on the broker"
        description="Start a desktop in the broker UI and it will appear here with a live preview, then use the per-computer switch to control agent access."
        action={
          <SecondaryButton onClick={onRefresh} className="px-3 py-1.5 text-xs">
            {refreshing ? 'Refreshing…' : 'Check again'}
          </SecondaryButton>
        }
      />
    ) : (
      <EmptyState
        icon="🔌"
        title="No computers to show"
        description="Connect a self-hosted Computer Broker to register the managed computer-use server and discover its computers."
        action={
          <PrimaryButton onClick={onOpenSettings} className="px-3 py-1.5 text-xs">
            Open broker settings
          </PrimaryButton>
        }
      />
    );
  } else {
    body = (
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {computers.map((computer) => (
          <ComputerCard
            key={computer.id}
            computer={computer}
            frameTick={frameTick}
            busy={busyKey === computer.id}
            globalPaused={globalPaused}
            onPreview={setPreview}
            onPause={onPause}
            onEditPause={onEditPause}
            onResume={onResume}
            onStart={onStart}
            onStop={onStop}
          />
        ))}
      </div>
    );
  }

  return (
    <section aria-labelledby="fleet-heading" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 id="fleet-heading" className="text-base font-semibold text-slate-100">
            Fleet
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Live previews refresh every 3 s while visible · fleet state every 5 s · {computers.length}{' '}
            computer{computers.length === 1 ? '' : 's'}
            {globalPaused ? ' · global pause active' : ''}
          </p>
        </div>
        <SecondaryButton onClick={onRefresh} disabled={refreshing} className="px-3 py-1.5 text-xs">
          {refreshing ? 'Refreshing…' : 'Refresh fleet'}
        </SecondaryButton>
      </div>

      {data !== null && error !== null && (
        <Notice tone="warning" title="Fleet may be stale">
          {error}
        </Notice>
      )}

      {body}

      {preview !== null && (
        <PreviewDialog
          computer={preview}
          frameTick={frameTick}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  );
}
