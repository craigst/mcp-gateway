/**
 * HTTP proxy to a remote observer / sub-agent harness (spec §7–§8).
 *
 * The proxy is deliberately thin: it forwards the isolated delegation envelope
 * (`mode`, `payload`, `depth`, `traceId`, `parentRequestId`) — never the caller's
 * API key, grants or conversation — and maps the harness response onto
 * {@link ObserverCallResult}. All transport/protocol failures become structured
 * `UPSTREAM_ERROR`s.
 *
 * Security notes:
 *  - the bearer token is only ever placed in the outgoing `Authorization` header;
 *    it must never appear in thrown errors or logs.
 *  - target URLs are never echoed in error messages (only the stable target id).
 */
import { ErrorCodes, GatewayError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { DelegationTarget } from '../core/types.js';

export type ObserverStatus = 'approved' | 'denied' | 'error';

export interface ObserverCallResult {
  status: ObserverStatus;
  verdict: string | null;
  approvalToken: string | null;
  output: unknown;
}

/** Envelope posted to the remote harness. Isolated context only — no key material. */
export interface ObserverCallBody {
  mode: string;
  payload: unknown;
  depth: number;
  traceId: string;
  parentRequestId: string;
}

const OBSERVER_STATUSES: readonly ObserverStatus[] = ['approved', 'denied', 'error'];

const DEFAULT_TIMEOUT_MS = 30_000;

export interface HttpObserverProxyOptions {
  logger?: Logger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class HttpObserverProxy {
  private readonly logger: Logger;

  constructor(options: HttpObserverProxyOptions = {}) {
    this.logger = options.logger ?? createLogger('delegation.proxy');
  }

  async call(
    target: DelegationTarget,
    body: ObserverCallBody,
    authToken: string | null = null,
  ): Promise<ObserverCallResult> {
    const timeoutMs =
      Number.isFinite(target.timeoutMs) && target.timeoutMs > 0 ? target.timeoutMs : DEFAULT_TIMEOUT_MS;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'X-MCP-Delegation-Depth': String(body.depth),
      'X-MCP-Trace-Id': body.traceId,
    };
    if (authToken) headers.authorization = `Bearer ${authToken}`;

    this.logger.debug('observer request', {
      target: target.id,
      depth: body.depth,
      traceId: body.traceId,
      mode: body.mode,
      authenticated: Boolean(authToken),
    });

    let response: Response;
    try {
      response = await fetch(target.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw this.transportError(target, timeoutMs, error);
    }

    if (!response.ok) {
      // Drain the body so the socket can be reused; never surface upstream text
      // (it could echo request material back at us).
      await response.text().catch(() => undefined);
      this.logger.warn('observer responded with an error status', {
        target: target.id,
        status: response.status,
        traceId: body.traceId,
      });
      throw new GatewayError(
        ErrorCodes.UPSTREAM_ERROR,
        `Observer '${target.id}' responded with HTTP ${response.status}.`,
        {
          data: { status: 'UPSTREAM_ERROR', details: { statusCode: response.status } },
          httpStatus: 502,
        },
      );
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      throw this.transportError(target, timeoutMs, error);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn('observer returned invalid JSON', { target: target.id, traceId: body.traceId });
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, `Observer '${target.id}' returned invalid JSON.`, {
        data: { status: 'UPSTREAM_ERROR' },
        httpStatus: 502,
      });
    }

    if (!isRecord(parsed)) {
      this.logger.warn('observer returned a non-object response', { target: target.id, traceId: body.traceId });
      throw new GatewayError(
        ErrorCodes.UPSTREAM_ERROR,
        `Observer '${target.id}' returned a non-object JSON response.`,
        { data: { status: 'UPSTREAM_ERROR' }, httpStatus: 502 },
      );
    }

    const status = parsed.status;
    if (typeof status !== 'string' || !OBSERVER_STATUSES.includes(status as ObserverStatus)) {
      this.logger.warn('observer returned a response without a valid status', {
        target: target.id,
        traceId: body.traceId,
      });
      throw new GatewayError(
        ErrorCodes.UPSTREAM_ERROR,
        `Observer '${target.id}' returned a response without a valid status.`,
        { data: { status: 'UPSTREAM_ERROR' }, httpStatus: 502 },
      );
    }

    const result: ObserverCallResult = {
      status: status as ObserverStatus,
      verdict: typeof parsed.verdict === 'string' ? parsed.verdict : null,
      approvalToken: typeof parsed.approval_token === 'string' ? parsed.approval_token : null,
      output: Object.prototype.hasOwnProperty.call(parsed, 'output') ? parsed.output : null,
    };

    this.logger.debug('observer response', {
      target: target.id,
      status: result.status,
      traceId: body.traceId,
    });

    return result;
  }

  /** Map a transport failure onto a structured upstream error without leaking the token. */
  private transportError(target: DelegationTarget, timeoutMs: number, error: unknown): GatewayError {
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : String(error);
    const timedOut =
      name === 'TimeoutError' || name === 'AbortError' || /timed?\s*out|abort/i.test(message);

    this.logger.warn('observer request failed', {
      target: target.id,
      timedOut,
      error: name || 'unknown',
    });

    const detail = timedOut ? `timed out after ${timeoutMs}ms` : `failed (${message || name || 'network error'})`;
    return new GatewayError(ErrorCodes.UPSTREAM_ERROR, `Observer '${target.id}' ${detail}.`, {
      data: { status: 'UPSTREAM_ERROR', details: { reason: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR' } },
      httpStatus: 502,
    });
  }
}
