/**
 * Observer-pattern helpers (spec §8).
 *
 * `observe_and_verify` delegations route a payload to an independent observer
 * harness; a positive verdict is accompanied by an approval token. Tokens are
 * HMAC-SHA256 (base64url) over the token payload, which lets any gateway node
 * verify them without storing state.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { DelegationResult } from '../core/types.js';

import type { ObserverCallResult } from './proxy.js';

const HMAC_ALGORITHM = 'sha256';

/** Sign an approval token payload. Returns a base64url HMAC-SHA256 string. */
export function signApprovalToken(payload: string, secret: string): string {
  return createHmac(HMAC_ALGORITHM, secret).update(payload, 'utf8').digest('base64url');
}

/** Constant-time verification of an approval token against its payload + secret. */
export function verifyApprovalToken(token: string, payload: string, secret: string): boolean {
  if (typeof token !== 'string' || token.length === 0) return false;

  const expected = createHmac(HMAC_ALGORITHM, secret).update(payload, 'utf8').digest();
  const provided = Buffer.from(token, 'base64url');

  // Length mismatch must not throw out of timingSafeEqual; it is already a rejection.
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export interface ObserverResultMeta {
  targetId: string;
  depth: number;
  traceId: string;
  latencyMs: number;
}

/** Map a raw observer call result onto the public `agents/delegate` result shape. */
export function observerToolResult(result: ObserverCallResult, meta: ObserverResultMeta): DelegationResult {
  return {
    targetId: meta.targetId,
    status: result.status,
    verdict: result.verdict,
    approvalToken: result.approvalToken,
    output: result.output,
    latencyMs: meta.latencyMs,
    depth: meta.depth,
    traceId: meta.traceId,
  };
}
