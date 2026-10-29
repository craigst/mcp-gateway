/** Shared presentation helpers for the Computer Use console page. */
import type { BadgeTone } from '../../components/Badge.js';
import { formatTimestamp } from '../../lib/format.js';

const RUNNING_STATES = new Set([
  'ready',
  'running',
  'active',
  'started',
  'online',
  'available',
  'resuming',
]);

const STARTING_STATES = new Set(['starting', 'provisioning', 'creating', 'booting', 'pending']);

/** True when the broker reports a desktop that can be previewed and controlled. */
export function isComputerRunning(state: string): boolean {
  return RUNNING_STATES.has(state.trim().toLowerCase());
}

/** Badge tone for a broker computer state (`ready`, `stopped`, `failed`, …). */
export function computerStateTone(state: string): BadgeTone {
  const normalised = state.trim().toLowerCase();
  if (RUNNING_STATES.has(normalised)) return 'success';
  if (STARTING_STATES.has(normalised)) return 'warning';
  if (normalised === 'failed' || normalised === 'error' || normalised === 'crashed') return 'danger';
  return 'neutral';
}

/** Badge tone for a connector state (`online`, `offline`, `degraded`, …). */
export function connectorTone(state: string | null | undefined): BadgeTone {
  if (state === null || state === undefined) return 'neutral';
  const normalised = state.trim().toLowerCase();
  if (normalised === 'online' || normalised === 'connected' || normalised === 'ready') return 'success';
  if (normalised === 'offline' || normalised === 'error' || normalised === 'failed') return 'danger';
  if (normalised === 'connecting' || normalised === 'degraded' || normalised === 'pending') return 'warning';
  return 'neutral';
}

/** Append a cache-buster to a frame endpoint URL (which already carries `maxWidth`). */
export function frameSrc(baseUrl: string, tick: number): string {
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}_=${tick}`;
}

/** Human copy for the auto-resume timestamp of a pause. */
export function resumeAtLabel(until: string | null): string {
  if (until === null || until.trim() === '') return 'until manually resumed';
  const timestamp = formatTimestamp(until);
  return timestamp === '—' ? 'until manually resumed' : `until ${timestamp}`;
}

/** `reason` text is operator-supplied; trim it and treat blank as absent. */
export function trimmedOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
