/** Shared presentation helpers for the Connectors console page (v0.10). */
import type { BadgeTone } from '../../components/Badge.js';
import type {
  ComputerUseDeviceInfo,
  ComputerUseEnrollmentKind,
  ComputerUseEnrollmentInfo,
} from '../../../core/types.js';

const ONLINE_STATES = new Set(['online', 'connected', 'ready', 'active', 'idle']);
const CONNECTING_STATES = new Set(['connecting', 'degraded', 'pending', 'starting', 'reconnecting']);

/** Badge tone for a device connector state (`online`, `offline`, `degraded`, …). */
export function deviceStateTone(state: string | null | undefined): BadgeTone {
  if (state === null || state === undefined) return 'neutral';
  const normalised = state.trim().toLowerCase();
  if (ONLINE_STATES.has(normalised)) return 'success';
  if (CONNECTING_STATES.has(normalised)) return 'warning';
  if (normalised === 'offline' || normalised === 'error' || normalised === 'failed') return 'danger';
  return 'neutral';
}

/** Human label for a pairing kind. The console onboards Linux PCs as `device`. */
export function enrollmentKindLabel(kind: ComputerUseEnrollmentKind | string): string {
  return kind === 'computer' ? 'Virtual desktop' : 'Linux PC';
}

/** `hostname · platform` from the connector metadata, or null when unknown. */
export function deviceHostLabel(device: ComputerUseDeviceInfo): string | null {
  const meta = device.meta;
  if (meta === null) return null;
  const parts: string[] = [];
  const hostname = meta.hostname;
  const platform = meta.platform;
  if (typeof hostname === 'string' && hostname.trim() !== '') parts.push(hostname.trim());
  if (typeof platform === 'string' && platform.trim() !== '') parts.push(platform.trim());
  return parts.length === 0 ? null : parts.join(' · ');
}

/** Connector-reported software version, when it publishes one. */
export function deviceVersion(device: ComputerUseDeviceInfo): string | null {
  const version = device.meta?.version;
  return typeof version === 'string' && version.trim() !== '' ? version.trim() : null;
}

/** True for the interactive-terminal ops advertised by a capable connector. */
export function isTerminalCapability(capability: string): boolean {
  const normalised = capability.trim().toLowerCase();
  return normalised === 'terminal' || normalised.startsWith('term.');
}

/** Capabilities to render, truncated so a noisy connector cannot blow up a card. */
export function visibleCapabilities(device: ComputerUseDeviceInfo, limit = 6): string[] {
  return device.capabilities.filter((capability) => capability.trim() !== '').slice(0, limit);
}

/** Operator-facing reason a Terminal button is unavailable. */
export function terminalDisabledReason(device: ComputerUseDeviceInfo): string | null {
  if (!device.terminalCapable) {
    return 'This connector does not advertise terminal support (term.*).';
  }
  if (!ONLINE_STATES.has(device.state.trim().toLowerCase())) {
    return 'The connector is offline — terminal access needs a live connection.';
  }
  return null;
}

function parsedTime(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/**
 * Relative time for a past timestamp ("3m ago") or a future one ("in 12m").
 * Returns an em dash for missing / invalid input.
 */
export function relativeTime(value: string | null | undefined, now: number = Date.now()): string {
  const time = parsedTime(value);
  if (time === null) return '—';
  const deltaSeconds = Math.round((time - now) / 1000);
  const future = deltaSeconds > 0;
  const seconds = Math.abs(deltaSeconds);
  if (seconds < 45) return future ? 'in a moment' : 'just now';
  let text: string;
  if (seconds < 3600) text = `${Math.max(1, Math.round(seconds / 60))}m`;
  else if (seconds < 172_800) text = `${Math.round(seconds / 3600)}h`;
  else text = `${Math.round(seconds / 86_400)}d`;
  return future ? `in ${text}` : `${text} ago`;
}

/** Pairing expiry copy: "expired" / "in 12m" — never a stale negative countdown. */
export function enrollmentExpiryLabel(
  enrollment: ComputerUseEnrollmentInfo,
  now: number = Date.now(),
): string {
  const time = parsedTime(enrollment.expiresAt);
  if (time === null) return '—';
  return time <= now ? 'expired' : relativeTime(enrollment.expiresAt, now);
}

/** Minutes between two ISO timestamps, rounded; null when either is unknown. */
export function lifetimeMinutes(createdAt: string | null, expiresAt: string): number | null {
  const created = parsedTime(createdAt);
  const expires = parsedTime(expiresAt);
  if (created === null || expires === null || expires <= created) return null;
  return Math.max(1, Math.round((expires - created) / 60_000));
}

/** Validate the pairing lifetime field (minutes 15–1440). */
export const MIN_PAIRING_MINUTES = 15;
export const MAX_PAIRING_MINUTES = 1_440;
export const DEFAULT_PAIRING_MINUTES = 60;

export function parsePairingMinutes(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) return null;
  const minutes = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(minutes) || minutes < MIN_PAIRING_MINUTES || minutes > MAX_PAIRING_MINUTES) {
    return null;
  }
  return minutes;
}

/** True when the broker data allows minting a new pairing. */
export function pairingBlockedReason(
  response: { broker: { configured: boolean; reachable: boolean }; publicBrokerUrl: string | null } | null,
): string | null {
  if (response === null) return 'Waiting for the broker status to load.';
  if (!response.broker.configured) {
    return 'The Computer Broker is not configured yet — add its URL and token in Computer Use settings.';
  }
  if (!response.broker.reachable) {
    return 'The Computer Broker is unreachable, so pairing commands cannot be generated.';
  }
  if (response.publicBrokerUrl === null || response.publicBrokerUrl.trim() === '') {
    return 'Set a public broker URL (publicBrokerUrl) so the new machine can reach the broker.';
  }
  return null;
}

/** Only allow http(s) links from API data. */
export function safeExternalUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
