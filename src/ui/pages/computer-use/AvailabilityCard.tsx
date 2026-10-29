import { Card } from '../../components/Card.js';
import { Badge } from '../../components/Badge.js';
import { ErrorState, LoadingState, Notice } from '../../components/States.js';
import { PrimaryButton, SecondaryButton } from '../../components/Form.js';
import { formatNumber, formatTimestamp } from '../../lib/format.js';
import type { ComputerUseOverview } from '../../../core/types.js';
import { resumeAtLabel } from './shared.js';

export interface AvailabilityCardProps {
  overview: ComputerUseOverview | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  onPause: () => void;
  onEditPause: () => void;
  onResume: () => void;
  onRetry: () => void;
}

const PAUSE_BUTTON_CLASS =
  'border-amber-800 bg-amber-950/30 text-amber-200 hover:bg-amber-950/60';

/**
 * Prominent global availability control: whether any agent may use a computer
 * right now, plus pause/resume actions with the reason and auto-resume time.
 */
export function AvailabilityCard({
  overview,
  loading,
  error,
  busy,
  onPause,
  onEditPause,
  onResume,
  onRetry,
}: AvailabilityCardProps) {
  if (overview === null) {
    return (
      <Card title="Agent availability" subtitle="Global pause applied to every broker computer">
        {loading && <LoadingState label="Loading availability…" />}
        {!loading && error !== null && <ErrorState message={error} onRetry={onRetry} />}
      </Card>
    );
  }

  const { availability, counts } = overview;
  const paused = availability.state === 'paused';
  const countsLine = `${formatNumber(counts.computers)} computer${counts.computers === 1 ? '' : 's'} · ${formatNumber(counts.ready)} ready · ${formatNumber(counts.connectorsOnline)} connector${counts.connectorsOnline === 1 ? '' : 's'} online`;

  return (
    <Card
      title="Agent availability"
      subtitle="Global control applied to every computer in the broker fleet"
      className={
        paused
          ? 'border-amber-900/70 bg-amber-950/20'
          : 'border-emerald-900/60 bg-emerald-950/15'
      }
      actions={
        paused ? (
          <>
            <PrimaryButton onClick={onResume} disabled={busy} className="px-3 py-1.5 text-xs">
              {busy ? 'Resuming…' : 'Resume now'}
            </PrimaryButton>
            <SecondaryButton onClick={onEditPause} disabled={busy} className="px-3 py-1.5 text-xs">
              Edit pause
            </SecondaryButton>
          </>
        ) : (
          <SecondaryButton
            onClick={onPause}
            disabled={busy}
            className={PAUSE_BUTTON_CLASS}
          >
            Pause agent computer use
          </SecondaryButton>
        )
      }
    >
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
              paused ? 'bg-amber-400' : 'bg-emerald-400'
            }`}
          />
          <div className="min-w-0 space-y-1">
            <p
              role="status"
              className={`text-sm font-semibold ${paused ? 'text-amber-200' : 'text-emerald-200'}`}
            >
              {paused ? 'Paused for all agents' : 'Available to agents'}
            </p>
            <p className="text-xs leading-relaxed text-slate-400">
              {paused
                ? `Computer-use calls are refused with COMPUTER_USE_PAUSED and never queued. Paused ${resumeAtLabel(availability.until)}.`
                : 'Permitted agents may start, view and drive broker computers. Pause to cut off computer use immediately.'}
            </p>
            <p className="text-[11px] text-slate-500">{countsLine}</p>
          </div>
        </div>

        {paused && (
          <div className="space-y-2 rounded-lg border border-amber-900/50 bg-slate-950/40 px-3 py-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-300/80">Reason</p>
              <p className="mt-0.5 text-xs text-amber-100/90">
                {availability.reason !== null && availability.reason.trim() !== ''
                  ? availability.reason
                  : 'No reason given.'}
              </p>
            </div>
            <p className="text-[11px] text-amber-200/60">
              {availability.until === null
                ? 'Stays paused until an operator resumes it.'
                : `Auto-resumes at ${formatTimestamp(availability.until)}.`}
              {availability.updatedBy !== null ? ` Last changed by ${availability.updatedBy}` : ''}
              {availability.updatedAt !== null ? ` on ${formatTimestamp(availability.updatedAt)}.` : '.'}
            </p>
          </div>
        )}

        {paused && counts.paused > 0 && (
          <Badge tone="warning">
            {formatNumber(counts.paused)} computer{counts.paused === 1 ? '' : 's'} individually paused
          </Badge>
        )}

        {!paused && availability.updatedBy !== null && (
          <p className="text-[11px] text-slate-500">
            Last changed by {availability.updatedBy}
            {availability.updatedAt !== null ? ` on ${formatTimestamp(availability.updatedAt)}` : ''}.
          </p>
        )}

        {error !== null && (
          <Notice tone="warning" title="Availability may be stale">
            {error}
          </Notice>
        )}
      </div>
    </Card>
  );
}
