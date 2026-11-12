/**
 * The Jev decision model, called from the gateway for email triage.
 *
 * Jev (TypeSafe) answers one classification per request in a couple of hundred
 * milliseconds. The request shape is not ours: it is the one OpenMausBot
 * already sends (`server/decider/inbox-triage.ts` + `server/decider/jev.ts`),
 * so the gateway and OMB classify the same mail the same way, including the
 * verifier Cloud's relay applies to those exact instructions and criteria.
 *
 * Two questions are asked in one request:
 *
 *   triage  reply | important | skip  — does the person need to see this today?
 *   scam    yes/no                    — is it an attempt to defraud or phish?
 *
 * The second question exists because triage alone is not a scam detector: a
 * phishing mail scores `skip` (true — it is not worth seeing) with only ~0.5
 * confidence, while the scam question gives it 0.99. Filing therefore reads the
 * pair, never the triage answer on its own. Measured 2026-11-12 on jev-1.14.0.
 *
 * Everything here is advisory and fail-safe: `judge` never throws, every answer
 * is validated before it is used, and a failure leaves the mail alone.
 */
import type { EmailNewMessage } from './types.js';

export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const JEV_MODEL = 'jev-latest';
export const JEV_TIMEOUT_MS = 4_000;
/** Jev rounds to two places, so a probability map can sum to 0.98 or 1.02. */
const SUM_TOLERANCE = 0.1;
const EPSILON = 1e-9;

const EMAIL_FROM_MAX = 160;
const EMAIL_SUBJECT_MAX = 200;
const EMAIL_PREVIEW_MAX = 600;
const DISMISSED_MAX = 20;
const DISMISSED_MAX_LENGTH = 160;

/** Cloud's relay accepts inbox triage only with these exact instructions and options. */
export const JEV_TRIAGE_INSTRUCTIONS =
  'Does the person need to see `email` today? `details` were read from it by a model and may be ' +
  'wrong; `dismissed_senders` lists senders whose mail they recently waved away.';

export const JEV_TRIAGE_OPTIONS = {
  reply: 'It waits on a reply from the person: a direct question or request to them from someone real.',
  important:
    'They must not miss it, though no reply is needed: a deadline, money owed or due, a change to their plans, or someone they work with.',
  skip: 'It can wait: newsletters, receipts, notifications, marketing, automated mail, and mail like what they recently dismissed.',
} as const;

export const JEV_SCAM_INSTRUCTIONS =
  'Is `email` an attempt to defraud, phish or impersonate someone, rather than genuine mail the person asked to receive?';

export const JEV_SCAM_CRITERIA = {
  true: 'It pressures the person to act urgently, asks them to sign in or confirm credentials or payment details, mimics a brand or a person it is not from, comes from a lookalike or mismatched domain, or threatens loss.',
  false:
    'It is ordinary correspondence, a genuine notification, a receipt, a newsletter the person receives, or an offer that makes no claim to be someone else.',
} as const;

export type JevTriage = keyof typeof JEV_TRIAGE_OPTIONS;
export type JevVerdict = { triage: JevTriage; pTop: number; scamP: number };

/** Why a decision could not be made. Every one of them means "leave the mail alone". */
export type JevFailure =
  | 'disabled'
  | 'timeout'
  | 'cancelled'
  | 'unreachable'
  | 'rejected'
  | 'rate_limited'
  | 'overloaded'
  | 'too_large'
  | 'http_error'
  | 'malformed';

export type JevResult =
  | { ok: true; verdict: JevVerdict; latencyMs: number }
  | { ok: false; reason: JevFailure; status?: number; latencyMs: number };

/** Strip control characters and collapse whitespace: model input is data, never instructions. */
export function clean(value: string, max: number): string {
  const flat = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return Array.from(flat).slice(0, max).join('');
}

export interface JevEmailInput {
  from: string;
  subject: string;
  preview: string;
}

export interface JevRequestOptions {
  dismissedFrom?: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function jevEndpoint(baseUrl?: string | null): URL | null {
  const root = (baseUrl?.trim() || JEV_DEFAULT_BASE_URL).replace(/\/+$/u, '');
  try {
    const url = new URL(`${root}/v1/systemone`);
    if (url.username !== '' || url.password !== '') return null;
    // The key may only cross https; plain http is allowed for a local fake only.
    if (url.protocol === 'https:') return url;
    const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
    return url.protocol === 'http:' && loopback ? url : null;
  } catch {
    return null;
  }
}

export function jevRequestBody(email: JevEmailInput, options: JevRequestOptions = {}) {
  const dismissed = (options.dismissedFrom ?? [])
    .slice(0, DISMISSED_MAX)
    .map((from) => clean(from, DISMISSED_MAX_LENGTH))
    .filter((from) => from !== '');
  return {
    state: {
      email: {
        from: clean(email.from, EMAIL_FROM_MAX),
        subject: clean(email.subject, EMAIL_SUBJECT_MAX),
        preview: clean(email.preview, EMAIL_PREVIEW_MAX),
      },
      ...(dismissed.length > 0 ? { dismissed_senders: dismissed } : {}),
    },
    model: JEV_MODEL,
    questions: {
      triage: { type: 'choice', instructions: JEV_TRIAGE_INSTRUCTIONS, criteria: { ...JEV_TRIAGE_OPTIONS } },
      scam: { type: 'noul', instructions: JEV_SCAM_INSTRUCTIONS, criteria: { ...JEV_SCAM_CRITERIA } },
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isProbability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** Validate one triage answer: an offered option, probabilities summing to 1, and it is the top one. */
function parseTriage(raw: unknown): { triage: JevTriage; pTop: number } | null {
  if (!isRecord(raw)) return null;
  const offered = new Set<string>(Object.keys(JEV_TRIAGE_OPTIONS));
  const choice = raw.choice;
  if (typeof choice !== 'string' || !offered.has(choice)) return null;
  if (!isRecord(raw.probabilities)) return null;
  let sum = 0;
  let top = 0;
  for (const [key, value] of Object.entries(raw.probabilities)) {
    if (!offered.has(key) || !isProbability(value)) return null;
    sum += value;
    top = Math.max(top, value);
  }
  if (Math.abs(sum - 1) > SUM_TOLERANCE) return null;
  const pTop = raw.probabilities[choice];
  if (!isProbability(pTop)) return null;
  // A choice that is not the most likely option is not what it claims to be.
  if (top > pTop + EPSILON) return null;
  return { triage: choice as JevTriage, pTop };
}

function parseScam(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  return isProbability(raw.noul) ? raw.noul : null;
}

/** Both answers, or nothing: a half-valid reply is not used. */
export function parseJevResponse(body: unknown): JevVerdict | null {
  if (!isRecord(body) || !isRecord(body.answers)) return null;
  const triage = parseTriage(body.answers.triage);
  const scamP = parseScam(body.answers.scam);
  if (triage === null || scamP === null) return null;
  return { triage: triage.triage, pTop: triage.pTop, scamP };
}

function failureFor(status: number): JevFailure {
  if (status === 413) return 'too_large';
  if (status === 401 || status === 403) return 'rejected';
  if (status === 429) return 'rate_limited';
  if (status === 529 || status === 503) return 'overloaded';
  return 'http_error';
}

export interface JevClientOptions {
  apiKey?: string | null;
  baseUrl?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * The client. `judge` is safe to batch: it never throws, and one failure is
 * reported as a failure for that message only.
 */
export class JevClient {
  private readonly apiKey: string | null;
  private readonly endpoint: URL | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JevClientOptions = {}) {
    const key = options.apiKey?.trim() ?? '';
    this.apiKey = key === '' ? null : key;
    this.endpoint = jevEndpoint(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? JEV_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** A key and a usable endpoint: without both, no call is attempted and mail waits. */
  get configured(): boolean {
    return this.apiKey !== null && this.endpoint !== null;
  }

  async judge(email: JevEmailInput, options: JevRequestOptions = {}): Promise<JevResult> {
    const started = Date.now();
    if (this.apiKey === null) return { ok: false, reason: 'disabled', latencyMs: 0 };
    if (this.endpoint === null) return { ok: false, reason: 'disabled', latencyMs: 0 };

    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          'user-agent': 'mcp-gateway-email-triage/1.0',
        },
        body: JSON.stringify(jevRequestBody(email, options)),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - started;
      if (!response.ok) return { ok: false, reason: failureFor(response.status), status: response.status, latencyMs };
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { ok: false, reason: 'malformed', status: response.status, latencyMs };
      }
      const verdict = parseJevResponse(body);
      if (verdict === null) return { ok: false, reason: 'malformed', status: response.status, latencyMs };
      return { ok: true, verdict, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - started;
      const name = error instanceof Error ? error.name : '';
      if (name === 'AbortError') {
        return { ok: false, reason: options.signal?.aborted === true ? 'cancelled' : 'timeout', latencyMs };
      }
      return { ok: false, reason: 'unreachable', latencyMs };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}

/** What a message looks like to the judge; the watcher sends the same shape. */
export type JevMessageInput = Pick<EmailNewMessage, 'from' | 'subject' | 'preview'>;
