/**
 * Typed client for the MCP Gateway admin + JSON-RPC API.
 *
 * The console is normally served by the gateway from `ui/dist`, so the default
 * base URL is same-origin. All requests authenticate with the operator key
 * stored in localStorage under `mcp_gateway_key`.
 */
import type {
  AuditEntry,
  AuditStatus,
  EscalationStatus,
  EscalationTicket,
  KeySummary,
  KeyType,
  RuntimeKind,
  ServerGrant,
  ServerRecord,
  TransportKind,
  VaultSecretMetadata,
} from '../../core/types.js';
import type { DelegationTrace, MetricsSnapshot, SubServerLogLine } from '../../core/ports.js';

export const API_KEY_STORAGE_KEY = 'mcp_gateway_key';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ApiErrorInit {
  status: number;
  code: number | string;
  message: string;
  data?: unknown;
}

/** Normalised transport / JSON-RPC error surfaced to the UI. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: number | string;
  readonly data: unknown;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.data = init.data;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Map an HTTP status + decoded JSON error body onto `ApiError`.
 * Accepts both `{ error: { code, message, data } }` and bare error objects.
 */
export function parseApiError(status: number, body: unknown): ApiError {
  if (isRecord(body)) {
    const wrapped = isRecord(body.error) ? body.error : body;
    const code = wrapped.code;
    const message = wrapped.message;
    if (typeof code === 'number' || typeof code === 'string' || typeof message === 'string') {
      return new ApiError({
        status,
        code: typeof code === 'number' || typeof code === 'string' ? code : status,
        message: typeof message === 'string' && message.length > 0 ? message : `HTTP ${status}`,
        data: wrapped.data,
      });
    }
  }
  return new ApiError({ status, code: status, message: `HTTP ${status}`, data: body });
}

/** Human readable error string for banners / empty states. */
export function formatApiError(error: unknown): string {
  if (error instanceof ApiError) {
    const code = typeof error.code === 'number' ? error.code : error.code;
    return `${error.message}${code !== error.status ? ` (${code})` : ''}`;
  }
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unexpected error';
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: string;
  version: string;
  uptimeMs: number;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: T;
  error?: JsonRpcErrorBody;
}

export interface RpcDetailedResult<T> {
  id: string;
  method: string;
  result: T;
  roundTripMs: number;
  gatewayOverheadMs: number | null;
  subServerMs: number | null;
}

export interface ApiClientOptions {
  /** Request timeout in milliseconds (default 20s). */
  timeoutMs?: number;
  /** Injectable fetch implementation (tests). */
  fetchImpl?: typeof fetch;
}

export interface CreateKeyRequest {
  name: string;
  keyType: KeyType;
  serverGrants: ServerGrant[];
  delegationAllowed: boolean;
  escalationAllowed: boolean;
  expiresInSeconds?: number | null;
}

export interface CreateKeyResponse {
  key: KeySummary;
  plaintext: string;
}

export interface RegisterServerRequest {
  name: string;
  runtime: RuntimeKind;
  transport: TransportKind;
  command?: string | null;
  args?: string[];
  url?: string | null;
  env?: Record<string, string>;
  highPrivilegeTools?: string[];
  delegationSupported?: boolean;
}

export interface ImportServerRequest {
  url: string;
  name?: string;
  startAfterBuild?: boolean;
  buildCommand?: string;
  startCommand?: string;
}

export interface AuditFilters {
  keyId?: string;
  serverId?: string;
  toolId?: string;
  method?: string;
  status?: AuditStatus;
  search?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface AuditQueryResult {
  entries: AuditEntry[];
  total: number;
}

export interface VaultListResponse {
  enabled: boolean;
  secrets: VaultSecretMetadata[];
}

export type ResolveEscalationStatus = 'approved' | 'denied';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function buildQuery(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

function storageOrNull(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

interface TimingMeta {
  gateway_overhead_ms?: unknown;
  sub_server_ms?: unknown;
}

function extractTiming(result: unknown): { gatewayOverheadMs: number | null; subServerMs: number | null } {
  if (isRecord(result) && isRecord(result._meta)) {
    const meta = result._meta as TimingMeta;
    return {
      gatewayOverheadMs: typeof meta.gateway_overhead_ms === 'number' ? meta.gateway_overhead_ms : null,
      subServerMs: typeof meta.sub_server_ms === 'number' ? meta.sub_server_ms : null,
    };
  }
  return { gatewayOverheadMs: null, subServerMs: null };
}

function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ApiClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch | null;
  private rpcCounter = 0;

  constructor(baseUrl = '', options: ApiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? null;
  }

  // -- key custody ----------------------------------------------------------

  /** Persist (or clear, when null/blank) the operator key in localStorage. */
  setApiKey(key: string | null): void {
    const storage = storageOrNull();
    if (!storage) return;
    if (key === null || key.trim() === '') {
      storage.removeItem(API_KEY_STORAGE_KEY);
      return;
    }
    storage.setItem(API_KEY_STORAGE_KEY, key.trim());
  }

  getApiKey(): string | null {
    const storage = storageOrNull();
    if (!storage) return null;
    const value = storage.getItem(API_KEY_STORAGE_KEY);
    return value && value.trim() !== '' ? value : null;
  }

  // -- transport ------------------------------------------------------------

  /** Perform an authenticated request and decode its JSON body. */
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init.headers) {
      if (typeof Headers !== 'undefined' && init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) headers[key] = value;
      } else {
        Object.assign(headers, init.headers);
      }
    }
    const apiKey = this.getApiKey();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (init.body !== undefined && init.body !== null && headers['Content-Type'] === undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const externalListeners: Array<() => void> = [];
    if (init.signal) {
      const external = init.signal;
      const forward = (): void => controller.abort();
      if (external.aborted) controller.abort();
      else {
        external.addEventListener('abort', forward, { once: true });
        externalListeners.push(() => external.removeEventListener('abort', forward));
      }
    }

    let response: Response;
    try {
      const fetchFn = this.fetchImpl ?? globalThis.fetch;
      if (typeof fetchFn !== 'function') {
        throw new Error('fetch is not available in this environment');
      }
      response = await fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new ApiError({
          status: 0,
          code: 'TIMEOUT',
          message: `Request ${path} timed out after ${this.timeoutMs}ms`,
        });
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError({
        status: 0,
        code: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : 'Network request failed',
        data: error,
      });
    } finally {
      clearTimeout(timer);
      for (const remove of externalListeners) remove();
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch {
      raw = '';
    }
    let payload: unknown = null;
    if (raw.length > 0) {
      try {
        payload = JSON.parse(raw) as unknown;
      } catch {
        payload = raw;
      }
    }

    if (!response.ok) throw parseApiError(response.status, payload);
    return payload as T;
  }

  // -- JSON-RPC ingress -----------------------------------------------------

  /** Send a single JSON-RPC request and return its `result`. */
  async rpc<T>(method: string, params?: unknown): Promise<T> {
    const detailed = await this.rpcDetailed<T>(method, params);
    return detailed.result;
  }

  /** JSON-RPC round trip that also reports gateway / sub-server timing. */
  async rpcDetailed<T>(method: string, params?: unknown): Promise<RpcDetailedResult<T>> {
    this.rpcCounter += 1;
    const id = `ui-${this.rpcCounter}`;
    const startedAt = now();
    const body: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined) body.params = params;
    const response = await this.request<JsonRpcResponse<T> | null>('/mcp/v1', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const roundTripMs = now() - startedAt;
    if (!response || typeof response !== 'object') {
      throw new ApiError({ status: 0, code: 'INVALID_RESPONSE', message: 'Gateway returned an empty JSON-RPC response' });
    }
    if (response.error) throw parseApiError(200, response);
    const result = response.result as T;
    const timing = extractTiming(result);
    return {
      id,
      method,
      result,
      roundTripMs,
      gatewayOverheadMs: timing.gatewayOverheadMs,
      subServerMs: timing.subServerMs,
    };
  }

  // -- health & metrics -----------------------------------------------------

  getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/mcp/v1/health');
  }

  getMetrics(): Promise<MetricsSnapshot> {
    return this.request<MetricsSnapshot>('/mcp/v1/metrics');
  }

  // -- keys -----------------------------------------------------------------

  async listKeys(): Promise<KeySummary[]> {
    const response = await this.request<{ keys?: KeySummary[] }>('/mcp/v1/admin/keys');
    return response.keys ?? [];
  }

  createKey(input: CreateKeyRequest): Promise<CreateKeyResponse> {
    return this.request<CreateKeyResponse>('/mcp/v1/admin/keys/create', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async getKey(id: string): Promise<KeySummary> {
    const response = await this.request<{ key: KeySummary }>(`/mcp/v1/admin/keys/${encodeURIComponent(id)}`);
    return response.key;
  }

  async revokeKey(id: string): Promise<KeySummary> {
    const response = await this.request<{ key: KeySummary }>(`/mcp/v1/admin/keys/${encodeURIComponent(id)}/revoke`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    return response.key;
  }

  // -- catalog / servers ----------------------------------------------------

  async listServers(): Promise<ServerRecord[]> {
    const response = await this.request<{ servers?: ServerRecord[] }>('/mcp/v1/admin/servers');
    return response.servers ?? [];
  }

  private async serverAction(id: string, action: 'start' | 'stop' | 'restart'): Promise<ServerRecord> {
    const response = await this.request<{ server: ServerRecord }>(
      `/mcp/v1/admin/servers/${encodeURIComponent(id)}/${action}`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    return response.server;
  }

  startServer(id: string): Promise<ServerRecord> {
    return this.serverAction(id, 'start');
  }

  stopServer(id: string): Promise<ServerRecord> {
    return this.serverAction(id, 'stop');
  }

  restartServer(id: string): Promise<ServerRecord> {
    return this.serverAction(id, 'restart');
  }

  async registerServer(input: RegisterServerRequest): Promise<ServerRecord> {
    const response = await this.request<{ server: ServerRecord }>('/mcp/v1/admin/servers', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return response.server;
  }

  async deleteServer(id: string): Promise<boolean> {
    const response = await this.request<{ deleted?: boolean }>(`/mcp/v1/admin/servers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return response.deleted ?? false;
  }

  async serverLogs(id: string, limit = 200): Promise<SubServerLogLine[]> {
    const response = await this.request<{ lines?: SubServerLogLine[] }>(
      `/mcp/v1/admin/servers/${encodeURIComponent(id)}/logs${buildQuery({ limit })}`,
    );
    return response.lines ?? [];
  }

  async importServer(input: ImportServerRequest): Promise<ServerRecord> {
    const response = await this.request<{ server: ServerRecord }>('/mcp/v1/admin/servers/import', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return response.server;
  }

  // -- vault ----------------------------------------------------------------

  listVaultSecrets(): Promise<VaultListResponse> {
    return this.request<VaultListResponse>('/mcp/v1/admin/vault/secrets');
  }

  async setVaultSecret(name: string, value: string): Promise<VaultSecretMetadata> {
    const response = await this.request<{ secret: VaultSecretMetadata }>(
      `/mcp/v1/admin/vault/secrets/${encodeURIComponent(name)}`,
      { method: 'PUT', body: JSON.stringify({ value }) },
    );
    return response.secret;
  }

  async deleteVaultSecret(name: string): Promise<boolean> {
    const response = await this.request<{ deleted?: boolean }>(
      `/mcp/v1/admin/vault/secrets/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );
    return response.deleted ?? false;
  }

  // -- audit / delegation / escalations ------------------------------------

  queryAudit(filters: AuditFilters = {}): Promise<AuditQueryResult> {
    const query = buildQuery({
      keyId: filters.keyId,
      serverId: filters.serverId,
      toolId: filters.toolId,
      method: filters.method,
      status: filters.status,
      search: filters.search,
      since: filters.since,
      until: filters.until,
      limit: filters.limit,
      offset: filters.offset,
    });
    return this.request<AuditQueryResult>(`/mcp/v1/admin/audit${query}`);
  }

  async listDelegations(limit = 100): Promise<DelegationTrace[]> {
    const response = await this.request<{ traces?: DelegationTrace[] }>(
      `/mcp/v1/admin/delegations${buildQuery({ limit })}`,
    );
    return response.traces ?? [];
  }

  async listEscalations(status?: EscalationStatus): Promise<EscalationTicket[]> {
    const response = await this.request<{ escalations?: EscalationTicket[] }>(
      `/mcp/v1/admin/escalations${buildQuery({ status })}`,
    );
    return response.escalations ?? [];
  }

  async resolveEscalation(
    ticket: string,
    status: ResolveEscalationStatus,
    note?: string,
  ): Promise<EscalationTicket> {
    const response = await this.request<{ escalation: EscalationTicket }>(
      `/mcp/v1/admin/escalations/${encodeURIComponent(ticket)}/resolve`,
      { method: 'POST', body: JSON.stringify(note ? { status, note } : { status }) },
    );
    return response.escalation;
  }
}

/** Console-wide singleton; the default base URL is same-origin. */
export const api = new ApiClient(import.meta.env.VITE_API_BASE_URL ?? '');
