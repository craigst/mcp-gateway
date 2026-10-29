/**
 * Minimal HTTP(S) client used to talk to the Computer Broker.
 *
 * Node's global `fetch` (undici) cannot be handed a per-request CA bundle, and
 * the broker serves a LAN certificate issued by mkcert. This module therefore
 * uses `node:https` directly and honours an explicit PEM file. Plain `http`
 * is accepted for tests and for a broker behind a TLS-terminating proxy.
 */
import { readFileSync } from 'node:fs';
import { request as nodeHttpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { request as nodeHttpsRequest } from 'node:https';

import { ErrorCodes, GatewayError } from '../core/errors.js';

export interface RawHttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  timeoutMs?: number;
  /** PEM CA bundle for https requests (ignored for http). */
  caFile?: string | null;
}

export interface RawHttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  contentType: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Perform one HTTP(S) round-trip. Network failures become `-32007` errors. */
export function httpRequest(url: string, options: RawHttpRequest = {}): Promise<RawHttpResponse> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GatewayError(ErrorCodes.INVALID_PARAMS, `Invalid Computer Broker URL: '${url}'`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new GatewayError(ErrorCodes.INVALID_PARAMS, `Computer Broker URL must use http(s): '${url}'`);
  }

  const isHttps = parsed.protocol === 'https:';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const payload =
    options.body === undefined ? undefined : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);

  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (payload !== undefined) headers['content-length'] = String(payload.length);

  let ca: Buffer | undefined;
  if (isHttps && options.caFile) {
    try {
      ca = readFileSync(options.caFile);
    } catch (error) {
      throw new GatewayError(
        ErrorCodes.INVALID_PARAMS,
        `Cannot read Computer Broker CA file '${options.caFile}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return new Promise<RawHttpResponse>((resolve, reject) => {
    const onResponse = (res: import('node:http').IncomingMessage): void => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
          contentType: String(res.headers['content-type'] ?? ''),
        });
      });
      res.on('error', (error: Error) => reject(networkError(url, error)));
    };

    const req = isHttps
      ? nodeHttpsRequest(parsed, { method: options.method ?? 'GET', headers, timeout: timeoutMs, ca }, onResponse)
      : nodeHttpRequest(parsed, { method: options.method ?? 'GET', headers, timeout: timeoutMs }, onResponse);
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on('error', (error: Error) => reject(networkError(url, error)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function networkError(url: string, error: Error): GatewayError {
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    // keep the raw string
  }
  return new GatewayError(ErrorCodes.UPSTREAM_ERROR, `Computer Broker unreachable at ${origin}: ${error.message}`, {
    data: { status: 'BROKER_UNREACHABLE', reason: 'BROKER_UNREACHABLE' },
    httpStatus: 502,
    cause: error,
  });
}

/** Parse a JSON body, returning null instead of throwing on malformed input. */
export function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}
