import { randomBytes, randomUUID } from 'node:crypto';

/** Short, URL-safe random id with an optional prefix (e.g. `srv_ab12cd34`). */
export function newId(prefix?: string): string {
  const raw = randomUUID().replace(/-/g, '').slice(0, 16);
  return prefix ? `${prefix}_${raw}` : raw;
}

export function newTraceId(): string {
  return newId('tr');
}

export function newRequestId(): string {
  return newId('req');
}

export function newEscalationTicketId(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const suffix = randomBytes(4).toString('hex').slice(0, 4);
  return `esc-${y}${m}${d}-${suffix}`;
}

/** Cryptographically random, URL-safe token body (default 32 bytes). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function nowIso(): string {
  return new Date().toISOString();
}
