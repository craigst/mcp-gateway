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
 *   POST /api/computers/host {name}                (create + pair a physical host)
 *   GET  /api/computers/{id}/stats                 (live host stats)
 *   POST /api/computers/{id}/connector/update      (connector self-update)
 *   DELETE /api/computers/{id}/connector           (remote connector removal)
 *   GET  /api/vm-hosts                             (VM providers)
 *   POST /api/vm-hosts {name,kind,config}          (register + test a provider)
 *   POST /api/vm-hosts/{id}/test                   (re-test a provider)
 *   DELETE /api/vm-hosts/{id}                      (remove a provider)
 *   POST /api/computers/vm {vm_host_id,...}        (deploy a VM computer)
 *   POST /mcp                                      (Streamable-HTTP MCP, JSON-RPC)
 *
 * Every authenticated call carries the operator-issued bearer token. The token
 * is held by this class only; it is never written to the server record.
 */
import { ErrorCodes, GatewayError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/logger.js';
import type {
  BrokerComputerSnapshot,
  BrokerConnectorRemoved,
  BrokerConnectorUpdate,
  BrokerDeviceSnapshot,
  BrokerEnrollmentCreated,
  BrokerEnrollmentSnapshot,
  BrokerHandoff,
  BrokerHostComputerCreated,
  BrokerVmHostCreateResult,
  BrokerVmHostDeleteResult,
  BrokerVmHostSnapshot,
  BrokerVmHostTestResult,
  ComputerUseBrokerHealth,
  ComputerUseBrokerPort,
  ComputerUseFrameResult,
} from '../core/ports.js';
import type {
  ComputerUseComputerResources,
  ComputerUseStats,
  ComputerUseVmComputerCreateInput,
  ComputerUseVmHostConfig,
  ComputerUseVmHostConfigInput,
  ComputerUseVmHostDefaults,
} from '../core/types.js';
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
/** Creating a host computer may provision a desktop on the broker. */
const HOST_CREATE_TIMEOUT_MS = 30_000;
/** The broker holds the connector self-update open until the connector reports. */
const CONNECTOR_UPDATE_TIMEOUT_MS = 240_000;
/** Remote uninstall waits for the connector to acknowledge and disappear. */
const CONNECTOR_REMOVE_TIMEOUT_MS = 30_000;
/** Registering a VM provider runs `ensure_base` + a full backend test. */
const VM_HOST_BOOTSTRAP_TIMEOUT_MS = 300_000;
/** Re-testing a provider may also (re)download the base image. */
const VM_HOST_TEST_TIMEOUT_MS = 300_000;
/** Removing a provider is a store-only operation on the broker. */
const VM_HOST_DELETE_TIMEOUT_MS = 60_000;
/** Deploying a VM copies the base image and defines/boots the domain. */
const VM_CREATE_TIMEOUT_MS = 300_000;

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

  // -------------------------------------------------------------------------
  // Physical host computers, stats and connector lifecycle (v0.12)
  // -------------------------------------------------------------------------

  async createHostComputer(name: string): Promise<BrokerHostComputerCreated> {
    const response = await this.request('/api/computers/host', {
      method: 'POST',
      body: JSON.stringify({ name }),
      timeoutMs: HOST_CREATE_TIMEOUT_MS,
    });
    const record = expectObject(parseJsonBody(response.body), 'host computer');
    const computerRecord = isRecord(record.computer) ? record.computer : record;
    const enrollment = isRecord(record.enrollment) ? record.enrollment : {};
    return {
      computer: normalizeComputer(computerRecord),
      token: requireString(record.token ?? computerRecord.token, 'host enrolment token'),
      expiresAt: stringOrNull(
        record.expires_at ??
          record.expiresAt ??
          record.enrollment_expires_at ??
          enrollment.expires_at ??
          enrollment.expiresAt ??
          computerRecord.expires_at,
      ),
    };
  }

  async computerStats(computerId: string): Promise<ComputerUseStats> {
    const response = await this.request(`/api/computers/${encodeURIComponent(computerId)}/stats`);
    return normalizeComputerStats(expectObject(parseJsonBody(response.body), 'computer stats'));
  }

  async updateConnector(computerId: string): Promise<BrokerConnectorUpdate> {
    const response = await this.request(`/api/computers/${encodeURIComponent(computerId)}/connector/update`, {
      method: 'POST',
      body: '{}',
      timeoutMs: CONNECTOR_UPDATE_TIMEOUT_MS,
    });
    const record = expectObject(parseJsonBody(response.body), 'connector update');
    return {
      ok: record.ok !== false,
      version: stringOrNull(record.version),
      connectorVersion: stringOrNull(record.connector_version ?? record.connectorVersion),
      result: record.result ?? null,
    };
  }

  async removeConnector(
    computerId: string,
    input: { uninstall: boolean; removeComputer: boolean },
  ): Promise<BrokerConnectorRemoved> {
    const response = await this.request(`/api/computers/${encodeURIComponent(computerId)}/connector`, {
      method: 'DELETE',
      body: JSON.stringify({ uninstall: input.uninstall, remove_computer: input.removeComputer }),
      timeoutMs: CONNECTOR_REMOVE_TIMEOUT_MS,
    });
    const record = expectObject(parseJsonBody(response.body), 'connector removal');
    return {
      ok: record.ok !== false,
      connectorRemoved: record.connector_removed === true,
      computerRemoved: record.computer_removed === true,
    };
  }

  // -------------------------------------------------------------------------
  // VM providers and VM deployment (v0.13.1)
  // -------------------------------------------------------------------------

  async listVmHosts(): Promise<BrokerVmHostSnapshot[]> {
    const response = await this.request('/api/vm-hosts');
    const body = parseJsonBody(response.body);
    if (!Array.isArray(body)) throw brokerShapeError('list vm hosts', body);
    return body.map((item) => normalizeVmHost(item));
  }

  async createVmHost(input: {
    name: string;
    kind: 'libvirt' | 'qemu';
    config: ComputerUseVmHostConfigInput;
  }): Promise<BrokerVmHostCreateResult> {
    const response = await this.request('/api/vm-hosts', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        kind: input.kind,
        config: serializeVmHostConfig(input.config),
      }),
      timeoutMs: VM_HOST_BOOTSTRAP_TIMEOUT_MS,
    });
    const record = expectObject(parseJsonBody(response.body), 'vm host creation');
    const hostRecord = record.vm_host ?? record.vmHost;
    if (!isRecord(hostRecord)) throw brokerShapeError('vm host creation', record);
    return {
      vmHost: normalizeVmHost(hostRecord),
      test: isRecord(record.test) ? record.test : null,
    };
  }

  async testVmHost(vmHostId: string): Promise<BrokerVmHostTestResult> {
    const response = await this.request(`/api/vm-hosts/${encodeURIComponent(vmHostId)}/test`, {
      method: 'POST',
      body: '{}',
      timeoutMs: VM_HOST_TEST_TIMEOUT_MS,
    });
    const record = expectObject(parseJsonBody(response.body), 'vm host test');
    const hostRecord = record.vm_host ?? record.vmHost;
    if (!isRecord(hostRecord)) throw brokerShapeError('vm host test', record);
    return {
      ok: record.ok !== false,
      vmHost: normalizeVmHost(hostRecord),
      details: isRecord(record.details) ? record.details : null,
    };
  }

  async deleteVmHost(vmHostId: string): Promise<BrokerVmHostDeleteResult> {
    const response = await this.request(`/api/vm-hosts/${encodeURIComponent(vmHostId)}`, {
      method: 'DELETE',
      timeoutMs: VM_HOST_DELETE_TIMEOUT_MS,
    });
    const record = expectObject(parseJsonBody(response.body), 'vm host deletion');
    return {
      ok: record.ok !== false,
      deleted: typeof record.deleted === 'string' && record.deleted !== '' ? record.deleted : vmHostId,
    };
  }

  async createVmComputer(input: ComputerUseVmComputerCreateInput): Promise<BrokerComputerSnapshot> {
    const body: Record<string, unknown> = { vm_host_id: input.vmHostId };
    if (input.name !== undefined && input.name !== null && input.name !== '') body.name = input.name;
    if (input.vcpus !== undefined) body.vcpus = input.vcpus;
    if (input.memoryMb !== undefined) body.memory_mb = input.memoryMb;
    if (input.diskGb !== undefined) body.disk_gb = input.diskGb;
    const response = await this.request('/api/computers/vm', {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: VM_CREATE_TIMEOUT_MS,
    });
    // The broker returns the public computer object directly (201).
    return normalizeComputer(parseJsonBody(response.body));
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
    resources: normalizeComputerResources(record.resources),
  };
}

/**
 * Normalise a broker computer's `resources` block. VM computers carry the
 * provider id and sizing (`vm_host_id`, vcpus, memory_mb, disk_gb); container
 * computers have no VM linkage, so they collapse to null.
 */
export function normalizeComputerResources(raw: unknown): ComputerUseComputerResources | null {
  if (!isRecord(raw)) return null;
  const resources: ComputerUseComputerResources = {
    vmHostId: stringOrNull(raw.vm_host_id ?? raw.vmHostId),
    vcpus: numberOrNull(raw.vcpus),
    memoryMb: numberOrNull(raw.memory_mb ?? raw.memoryMb),
    diskGb: numberOrNull(raw.disk_gb ?? raw.diskGb),
  };
  if (
    resources.vmHostId === null &&
    resources.vcpus === null &&
    resources.memoryMb === null &&
    resources.diskGb === null
  ) {
    return null;
  }
  return resources;
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

/**
 * Normalise a broker stats payload into `ComputerUseStats`. The broker emits
 * snake_case JSON from `psutil`-style probe data; missing sections become empty
 * values so a partially-equipped host still renders.
 */
export function normalizeComputerStats(raw: unknown): ComputerUseStats {
  const record = expectObject(raw, 'computer stats');
  const cpu = recordOr(record.cpu);
  const memory = recordOr(record.memory ?? record.mem);
  const swap = recordOr(record.swap);
  const disk = recordOr(record.disk ?? firstRecord(record.disks));
  const addresses = Array.isArray(record.addresses)
    ? record.addresses
    : Array.isArray(record.network)
      ? record.network
      : [];
  return {
    hostname: stringOr(record.hostname ?? record.host, 'unknown'),
    os: stringOr(record.os ?? record.platform ?? record.distro, 'unknown'),
    uptimeSeconds: numberOrNull(record.uptime_seconds ?? record.uptimeSeconds ?? record.uptime_s ?? record.uptime),
    load: numberArray(record.load ?? record.load_avg ?? record.loadavg),
    cpu: {
      cores: numberOr(cpu.cores ?? record.cores ?? record.cpu_count, 0),
      percent: numberOr(cpu.percent ?? record.cpu_percent, 0),
    },
    memory: {
      totalBytes: numberOr(memory.total_bytes ?? memory.total, 0),
      usedBytes: numberOr(memory.used_bytes ?? memory.used, 0),
      availableBytes: numberOr(memory.available_bytes ?? memory.available, 0),
      percent: numberOr(memory.percent, 0),
    },
    swap: {
      totalBytes: numberOr(swap.total_bytes ?? swap.total, 0),
      usedBytes: numberOr(swap.used_bytes ?? swap.used, 0),
      percent: numberOr(swap.percent, 0),
    },
    disk: {
      path: stringOr(disk.path ?? disk.mount ?? disk.mountpoint, '/'),
      totalBytes: numberOr(disk.total_bytes ?? disk.total, 0),
      usedBytes: numberOr(disk.used_bytes ?? disk.used, 0),
      percent: numberOr(disk.percent, 0),
    },
    addresses: addresses
      .filter(isRecord)
      .map((entry) => ({
        iface: stringOr(entry.iface ?? entry.interface ?? entry.name, ''),
        address: stringOr(entry.address ?? entry.ip ?? entry.addr, ''),
      }))
      .filter((entry) => entry.iface !== '' || entry.address !== ''),
    collectedAt: stringOrNull(record.collected_at ?? record.collectedAt ?? record.timestamp),
  };
}

function recordOr(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

// ---------------------------------------------------------------------------
// VM providers (v0.13.1)
// ---------------------------------------------------------------------------

export function normalizeVmHost(raw: unknown): BrokerVmHostSnapshot {
  const record = expectObject(raw, 'vm host');
  const state = stringOr(record.state, 'new');
  return {
    id: requireString(record.id, 'vm host id'),
    name: stringOr(record.name, 'unnamed'),
    kind: record.kind === 'qemu' ? 'qemu' : 'libvirt',
    config: normalizeVmHostConfig(record.config),
    defaults: normalizeVmHostDefaults(record.defaults ?? recordOr(record.config).defaults),
    template: stringOr(record.template, 'ubuntu-xfce'),
    baseReady: record.base_ready === true || record.baseReady === true,
    state: state === 'ready' || state === 'error' ? state : 'new',
    lastError: stringOrNull(record.last_error ?? record.lastError),
    createdAt: stringOrNull(record.created_at ?? record.createdAt),
  };
}

export function normalizeVmHostConfig(raw: unknown): ComputerUseVmHostConfig {
  const record = recordOr(raw);
  const installBrowser =
    record.install_browser === true || record.installBrowser === true
      ? true
      : record.install_browser === false || record.installBrowser === false
        ? false
        : null;
  return {
    sshHost: stringOrNull(record.ssh_host ?? record.sshHost),
    sshUser: stringOrNull(record.ssh_user ?? record.sshUser),
    host: stringOrNull(record.host),
    user: stringOrNull(record.user),
    baseImage: stringOrNull(record.base_image ?? record.baseImage),
    storageDir: stringOrNull(record.storage_dir ?? record.storageDir),
    vmDir: stringOrNull(record.vm_dir ?? record.vmDir),
    network: stringOrNull(record.network),
    template: stringOrNull(record.template),
    cloudImageUrl: stringOrNull(record.cloud_image_url ?? record.cloudImageUrl),
    installBrowser,
    defaults: isRecord(record.defaults) ? normalizeVmHostDefaults(record.defaults) : null,
  };
}

export function normalizeVmHostDefaults(raw: unknown): ComputerUseVmHostDefaults {
  const record = recordOr(raw);
  return {
    vcpus: numberOr(record.vcpus ?? record.vcpu, 2),
    memoryMb: numberOr(record.memory_mb ?? record.memoryMb, 2_048),
    diskGb: numberOr(record.disk_gb ?? record.diskGb, 30),
  };
}

/** Serialise the console-facing create input to the broker's snake_case config. */
export function serializeVmHostConfig(input: ComputerUseVmHostConfigInput): Record<string, unknown> {
  const config: Record<string, unknown> = {
    base_image: input.baseImage,
    storage_dir: input.storageDir,
  };
  if (input.sshHost !== undefined && input.sshHost !== null && input.sshHost !== '') {
    config.ssh_host = input.sshHost;
  }
  if (input.sshUser !== undefined && input.sshUser !== null && input.sshUser !== '') {
    config.ssh_user = input.sshUser;
  }
  if (input.network !== undefined && input.network !== null && input.network !== '') {
    config.network = input.network;
  }
  if (input.cloudImageUrl !== undefined && input.cloudImageUrl !== null && input.cloudImageUrl !== '') {
    config.cloud_image_url = input.cloudImageUrl;
  }
  if (input.installBrowser !== undefined && input.installBrowser !== null) {
    config.install_browser = input.installBrowser;
  }
  if (input.defaults !== undefined && input.defaults !== null) {
    const defaults: Record<string, number> = {};
    if (input.defaults.vcpus !== undefined) defaults.vcpus = input.defaults.vcpus;
    if (input.defaults.memoryMb !== undefined) defaults.memory_mb = input.defaults.memoryMb;
    if (input.defaults.diskGb !== undefined) defaults.disk_gb = input.defaults.diskGb;
    if (Object.keys(defaults).length > 0) config.defaults = defaults;
  }
  return config;
}


function firstRecord(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}

function numberArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
  }
  if (isRecord(value)) {
    // Older probes report load as `{one, five, fifteen}`.
    return [value.one ?? value['1'], value.five ?? value['5'], value.fifteen ?? value['15']].filter(
      (item): item is number => typeof item === 'number' && Number.isFinite(item),
    );
  }
  return [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
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
