/**
 * HTTP client for one Computer Broker.
 *
 * The broker (a separate self-hosted service) exposes:
 *   GET  /healthz                                  (unauthenticated status)
 *   GET  /api/computers                            (fleet)
 *   GET  /api/computers/{id}                       (one computer)
 *   POST /api/computers/{id}/start|stop            (lifecycle)
 *   GET  /api/computers/{id}/frame?max_width=      (JPEG still)
 *   GET  /api/devices                              (enrolled connectors)
 *   GET  /api/enrollments                          (live pairing tokens, no secrets)
 *   POST /api/enrollments {kind,ttl_s}             (mint a single-use pairing token)
 *   DELETE /api/enrollments/{id}                   (revoke)
 *   POST /api/devices/{id}/call {op,args}          (one device operation)
 *   POST /mcp                                      (Streamable-HTTP MCP, JSON-RPC)
 *
 * Every authenticated call carries the operator-issued bearer token. The token
 * is held by this class only; it is never written to the server record.
 */
import { ErrorCodes, GatewayError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/logger.js';
import type {
  BrokerComputerSnapshot,
  BrokerDeviceSnapshot,
  BrokerEnrollmentCreated,
  BrokerEnrollmentSnapshot,
  BrokerHandoff,
  ComputerUseBrokerHealth,
  ComputerUseBrokerPort,
  ComputerUseFrameResult,
} from '../core/ports.js';
import { httpRequest, parseJsonBody, type RawHttpResponse } from './http.js';

export interface BrokerClientOptions {
  baseUrl: string;
  token: string | null;
  caFile?: string | null;
  /** Per-request budget for broker HTTP calls. */
  timeoutMs?: number;
  logger?: Logger;
}

interface JsonRpcResult {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

const DEFAULT_TIMEOUT_MS = 20_000;
const FRAME_TIMEOUT_MS = 15_000;

export class BrokerHttpClient implements ComputerUseBrokerPort {
  readonly baseUrl: string;
  private readonly token: string | null;
  private readonly caFile: string | null;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private nextRpcId = 1;

  constructor(options: BrokerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.caFile = options.caFile ?? null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger ?? createLogger('computer-use.broker');
  }

  async health(): Promise<ComputerUseBrokerHealth> {
    const response = await this.request('/healthz', { auth: false });
    const body = expectObject(parseJsonBody(response.body), 'health');
    return {
      ok: body.ok !== false,
      version: stringOrNull(body.version),
      computers: numberOrNull(body.computers),
      devices: numberOrNull(body.devices),
      connectorsOnline: numberOrNull(body.connectors_online ?? body.connectorsOnline),
      tls: body.tls === true,
    };
  }

  async listComputers(): Promise<BrokerComputerSnapshot[]> {
    const response = await this.request('/api/computers');
    const body = parseJsonBody(response.body);
    if (!Array.isArray(body)) throw brokerShapeError('list computers', body);
    return body.map((item) => normalizeComputer(item));
  }

  async getComputer(computerId: string): Promise<BrokerComputerSnapshot> {
    const response = await this.request(`/api/computers/${encodeURIComponent(computerId)}`);
    return normalizeComputer(expectObject(parseJsonBody(response.body), 'computer'));
  }

  async startComputer(computerId: string): Promise<BrokerComputerSnapshot> {
    const response = await this.request(`/api/computers/${encodeURIComponent(computerId)}/start`, { method: 'POST' });
    return normalizeComputer(expectObject(parseJsonBody(response.body), 'computer'));
  }

  async stopComputer(computerId: string): Promise<BrokerComputerSnapshot> {
    const response = await this.request(`/api/computers/${encodeURIComponent(computerId)}/stop`, { method: 'POST' });
    return normalizeComputer(expectObject(parseJsonBody(response.body), 'computer'));
  }

  async frame(computerId: string, maxWidth: number): Promise<ComputerUseFrameResult> {
    const response = await this.request(
      `/api/computers/${encodeURIComponent(computerId)}/frame?max_width=${encodeURIComponent(String(maxWidth))}`,
      { accept: 'image/jpeg', timeoutMs: FRAME_TIMEOUT_MS },
    );
    return {
      data: response.body,
      contentType: response.contentType || 'image/jpeg',
      frameTime: headerValue(response.headers['x-frame-time']) ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Connectors, pairing and device operations (v0.10)
  // -------------------------------------------------------------------------

  async devices(): Promise<BrokerDeviceSnapshot[]> {
    const response = await this.request('/api/devices');
    const body = parseJsonBody(response.body);
    if (!Array.isArray(body)) throw brokerShapeError('list devices', body);
    return body.map((item) => normalizeDevice(item));
  }

  async enrollments(): Promise<BrokerEnrollmentSnapshot[]> {
    const response = await this.request('/api/enrollments');
    const body = parseJsonBody(response.body);
    if (!Array.isArray(body)) throw brokerShapeError('list enrollments', body);
    return body.map((item) => normalizeEnrollment(item));
  }

  async createEnrollment(input: {
    kind: 'device' | 'computer';
    ttlSeconds: number;
    computerId?: string | null;
  }): Promise<BrokerEnrollmentCreated> {
    const body: Record<string, unknown> = { kind: input.kind, ttl_s: input.ttlSeconds };
    if (input.computerId !== undefined && input.computerId !== null && input.computerId !== '') {
      body.computer_id = input.computerId;
    }
    const response = await this.request('/api/enrollments', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const record = expectObject(parseJsonBody(response.body), 'enrollment');
    return {
      ...normalizeEnrollment(record),
      token: requireString(record.token, 'enrollment token'),
    };
  }

  async revokeEnrollment(enrollmentId: string): Promise<void> {
    await this.request(`/api/enrollments/${encodeURIComponent(enrollmentId)}`, { method: 'DELETE' });
  }

  async createHandoff(input: { to: string; ttlSeconds: number }): Promise<BrokerHandoff> {
    const response = await this.request('/api/handoff', {
      method: 'POST',
      body: JSON.stringify({ to: input.to, ttl_s: input.ttlSeconds }),
    });
    const record = expectObject(parseJsonBody(response.body), 'handoff');
    const token = typeof record.token === 'string' ? record.token : '';
    const path = typeof record.path === 'string' ? record.path : '';
    if (token === '' || !path.startsWith('/')) throw brokerShapeError('handoff', record);
    return {
      token,
      expiresAt: typeof record.expires_at === 'string'
        ? record.expires_at
        : typeof record.expiresAt === 'string' ? record.expiresAt : '',
      path,
    };
  }

  /**
   * One operation against a connected device connector. The broker wraps the
   * operation result in `{ok, data}`; only `data` is returned, and a `!ok`
   * envelope is mapped to an upstream `GatewayError` like an HTTP failure.
   */
  async deviceCall(
    deviceId: string,
    op: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const response = await this.request(`/api/devices/${encodeURIComponent(deviceId)}/call`, {
      method: 'POST',
      body: JSON.stringify({ op, args: args ?? {} }),
      timeoutMs: timeoutMs ?? this.timeoutMs,
    });
    const body = expectObject(parseJsonBody(response.body), 'device call');
    if (body.ok === false) {
      const detail = extractDetail(body);
      const reason = detailReason(body, detail) ?? 'DEVICE_CALL_FAILED';
      const message = detailMessage(body, detail) ?? `device operation '${op}' failed`;
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, `Computer Broker device ${deviceId}: ${message}`, {
        data: { status: 'BROKER_ERROR', reason, details: detail ?? body },
        httpStatus: 502,
      });
    }
    return body.data ?? null;
  }

  /** One JSON-RPC request against the broker's MCP endpoint. Notifications are fire-and-forget. */
  async rpc(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextRpcId++;
    const payload: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;
    const response = await this.request('/mcp', {
      method: 'POST',
      body: JSON.stringify(payload),
      timeoutMs: timeoutMs ?? this.timeoutMs,
    });
    // The broker answers notifications with 202 and an empty body.
    if (response.body.length === 0) return null;
    const envelope = expectObject(parseJsonBody(response.body), 'mcp response') as JsonRpcResult;
    if (envelope.error) {
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, envelope.error.message ?? 'Computer Broker MCP error', {
        data: { status: 'UPSTREAM_ERROR', reason: 'BROKER_MCP_ERROR', details: envelope.error.data ?? null },
        httpStatus: 502,
      });
    }
    return envelope.result ?? null;
  }

  private async request(
    path: string,
    options: { method?: string; body?: string; accept?: string; auth?: boolean; timeoutMs?: number } = {},
  ): Promise<RawHttpResponse> {
    const auth = options.auth !== false;
    const headers: Record<string, string> = { accept: options.accept ?? 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (auth) headers.authorization = `Bearer ${this.requireToken()}`;

    let response: RawHttpResponse;
    try {
      response = await httpRequest(`${this.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body,
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
        caFile: this.caFile,
      });
    } catch (error) {
      this.logger.debug('broker request failed', { path, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }

    if (response.status >= 400) throw this.httpError(path, options.method ?? 'GET', response);
    return response;
  }

  private requireToken(): string {
    if (this.token === null || this.token === '') {
      throw new GatewayError(
        ErrorCodes.INVALID_PARAMS,
        'Computer Broker token is not configured. Set MCP_COMPUTER_BROKER_TOKEN or store it in the console.',
        { data: { status: 'COMPUTER_USE_UNCONFIGURED', reason: 'TOKEN_MISSING' } },
      );
    }
    return this.token;
  }

  private httpError(path: string, method: string, response: RawHttpResponse): GatewayError {
    const parsed = parseJsonBody(response.body);
    const detail = extractDetail(parsed);
    const reason = detailReason(parsed, detail) ?? `HTTP_${response.status}`;
    const message = detailMessage(parsed, detail) ?? `Computer Broker returned HTTP ${response.status}`;
    // Forward client-meaningful statuses; everything else is an upstream failure.
    const httpStatus = [400, 401, 403, 404, 409, 429, 503, 504].includes(response.status) ? response.status : 502;
    return new GatewayError(ErrorCodes.UPSTREAM_ERROR, `Computer Broker ${method} ${path}: ${message}`, {
      data: { status: 'BROKER_ERROR', reason, details: detail ?? parsed },
      httpStatus,
    });
  }
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

export function normalizeComputer(raw: unknown): BrokerComputerSnapshot {
  const record = expectObject(raw, 'computer');
  const desktop = isRecord(record.desktop) ? record.desktop : {};
  const connector = isRecord(record.connector) ? record.connector : null;
  const control = isRecord(record.control) ? record.control : {};
  return {
    id: requireString(record.id, 'computer id'),
    name: stringOr(record.name, 'unnamed'),
    template: stringOr(record.template, 'unknown'),
    provider: stringOr(record.provider, 'container'),
    state: stringOr(record.state, 'unknown'),
    viewer: stringOr(record.viewer ?? desktop.viewer, 'rfb'),
    error: stringOrNull(record.error),
    createdAt: stringOrNull(record.created_at ?? record.createdAt),
    ttlAt: stringOrNull(record.ttl_at ?? record.ttlAt),
    desktop: {
      viewer: stringOr(desktop.viewer ?? record.viewer, 'rfb'),
      width: numberOrNull(desktop.width),
      height: numberOrNull(desktop.height),
    },
    connector: connector
      ? {
          state: stringOr(connector.state, 'unknown'),
          version: stringOrNull(connector.version),
          lastSeen: stringOrNull(connector.last_seen ?? connector.lastSeen),
        }
      : null,
    control: {
      held: control.held === true,
      holder: stringOrNull(control.holder),
      heldSince: stringOrNull(control.held_since ?? control.heldSince),
      expiresAt: stringOrNull(control.expires_at ?? control.expiresAt),
    },
  };
}

export function normalizeDevice(raw: unknown): BrokerDeviceSnapshot {
  const record = expectObject(raw, 'device');
  return {
    id: requireString(record.id, 'device id'),
    name: stringOr(record.name, 'unnamed'),
    state: stringOr(record.state, 'unknown'),
    location: stringOrNull(record.location),
    tags: stringArray(record.tags),
    capabilities: stringArray(record.capabilities),
    meta: isRecord(record.meta) ? record.meta : null,
    lastSeen: stringOrNull(record.last_seen ?? record.lastSeen),
  };
}

export function normalizeEnrollment(raw: unknown): BrokerEnrollmentSnapshot {
  const record = expectObject(raw, 'enrollment');
  return {
    id: requireString(record.id, 'enrollment id'),
    kind: record.kind === 'computer' ? 'computer' : 'device',
    expiresAt: stringOr(record.expires_at ?? record.expiresAt, ''),
    createdAt: stringOrNull(record.created_at ?? record.createdAt),
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
}

function extractDetail(parsed: unknown): unknown {
  if (!isRecord(parsed)) return parsed;
  return parsed.detail ?? parsed.error ?? parsed;
}

function detailReason(parsed: unknown, detail: unknown): string | null {
  if (isRecord(detail)) {
    if (typeof detail.error === 'string') return detail.error;
    if (typeof detail.reason === 'string') return detail.reason;
  }
  if (isRecord(parsed) && typeof parsed.error === 'string') return parsed.error;
  return null;
}

function detailMessage(parsed: unknown, detail: unknown): string | null {
  if (isRecord(detail)) {
    if (typeof detail.message === 'string') return detail.message;
    if (typeof detail.error === 'string') return detail.error;
  }
  if (typeof detail === 'string') return detail;
  if (isRecord(parsed) && typeof parsed.message === 'string') return parsed.message;
  return null;
}

function brokerShapeError(operation: string, body: unknown): GatewayError {
  return new GatewayError(ErrorCodes.UPSTREAM_ERROR, `Computer Broker returned an unexpected ${operation} response`, {
    data: { status: 'BROKER_SHAPE_ERROR', details: body },
    httpStatus: 502,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectObject(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw brokerShapeError(what, value);
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw brokerShapeError(field, value);
  return value;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' ? value : null;
}
