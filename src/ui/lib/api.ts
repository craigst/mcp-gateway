/**
 * Typed client for the MCP Gateway admin + JSON-RPC API.
 *
 * The console is normally served by the gateway from `ui/dist`, so the default
 * base URL is same-origin. Browser requests authenticate with the built-in
 * username/password session: an HttpOnly `mcp_session` cookie is sent on every
 * request (`credentials: 'include'`). The browser never stores a bearer key.
 */
import type {
  AuditEntry,
  AuditStatus,
  BackupMetadata,
  CatalogEntry,
  CatalogInstallResult,
  CatalogSource,
  CatalogSourceKind,
  ConfigProfileApplyResult,
  ConfigProfileInput,
  ConfigProfileSummary,
  CredentialItem,
  CredentialProviderDescriptor,
  CredentialProviderId,
  CredentialProviderStatus,
  CredentialRevealResult,
  EscalationStatus,
  EscalationTicket,
  GatewaySettingsInfo,
  HarnessImportInput,
  HarnessScanResult,
  HarnessSourceInfo,
  InstallTestResult,
  KeyAccessView,
  KeyActivityFilter,
  KeyActivityPage,
  KeySummary,
  KeyType,
  UpdateKeyInput,
  RestoreResult,
  RuntimeKind,
  ServerActivityPage,
  ServerGrant,
  ServerInspectorOverview,
  ServerRecord,
  ServerSourceInfo,
  ServerStatus,
  ServerUpdateResult,
  TransportKind,
  UpdateCheckResult,
  VaultSecretMetadata,
} from '../../core/types.js';
import type { DelegationTrace, MetricsSnapshot, SubServerLogLine } from '../../core/ports.js';

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

// ---------------------------------------------------------------------------
// Session auth (v0.3)
// ---------------------------------------------------------------------------

export interface SessionUser {
  username: string;
}

export interface LoginResponse {
  user: SessionUser;
  /** ISO timestamp for the issued session, when provided by the gateway. */
  expiresAt?: string;
}

export interface SessionStatus {
  authenticated: boolean;
  user?: SessionUser;
  /** True on a fresh gateway where no operator account exists yet. */
  setupRequired?: boolean;
  /** True when a first-run backup restore is possible. */
  restoreSupported?: boolean;
}

// ---------------------------------------------------------------------------
// v0.6 onboarding, settings & encrypted backups
// ---------------------------------------------------------------------------

export interface SettingsResponse {
  settings: GatewaySettingsInfo;
  account: { username: string; sessionCount: number };
}

export interface CreateBackupRequest {
  /** Login password of the requesting operator; derives the backup key. */
  password: string;
  includeAudit?: boolean;
}

export interface RestoreBackupRequest {
  /** Parsed backup envelope (never re-encrypted by the browser). */
  backup: unknown;
  password: string;
}

export interface DownloadBackupResult {
  blob: Blob;
  fileName: string;
}

// ---------------------------------------------------------------------------
// v0.7 credential providers
// ---------------------------------------------------------------------------

export interface CredentialProvidersResponse {
  providers: CredentialProviderStatus[];
  descriptors: CredentialProviderDescriptor[];
  defaultProvider: CredentialProviderId;
}

export interface CredentialItemQuery {
  search?: string;
  limit?: number;
}

export interface RevealCredentialRequest {
  provider: CredentialProviderId;
  itemId: string;
  field?: string | null;
}

export interface SimpleOkResponse {
  ok: boolean;
}

/** Listener invoked for every HTTP 401 so the shell can return to the login page. */
export type UnauthorizedHandler = (error: ApiError) => void;

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

export interface RegenerateMasterKeyRequest {
  /** Revoke every existing master key after issuing the new one (server default: true). */
  revokePrevious?: boolean;
  /** Optional label for the new master key. */
  name?: string;
}

export interface MasterKeyRegeneration {
  key: KeySummary;
  /** One-time plaintext of the new master key. */
  plaintext: string;
  revokedCount: number;
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
// v0.2 wire types — plugin catalog, harness discovery, Vault Warden
// ---------------------------------------------------------------------------

export interface AddCatalogSourceRequest {
  label: string;
  kind: CatalogSourceKind;
  repoUrl: string;
  ref?: string | null;
  subpath?: string | null;
  /** Plaintext clone token; the gateway stores it in the AES-256 vault and never returns it. */
  token?: string | null;
}

export interface CatalogEntriesResult {
  source: CatalogSource;
  entries: CatalogEntry[];
}

export interface CatalogInstallRequest {
  sourceId: string;
  entryId: string;
  name?: string;
  env?: Record<string, string>;
  envFile?: string | null;
  start?: boolean;
  test?: boolean;
}

export interface CatalogImportUrlRequest {
  url: string;
  ref?: string | null;
  subpath?: string | null;
  name?: string;
  env?: Record<string, string>;
  envFile?: string | null;
  start?: boolean;
  test?: boolean;
}

/** Body for `POST /admin/discovery/scan`; omitted/empty means every adapter. */
export interface DiscoveryScanRequest {
  harnessIds?: string[];
}

/** Tool row returned by `GET /admin/servers/:id/tools` (v0.2 policy view). */
export interface AdminServerTool {
  id: string;
  name: string;
  description: string;
  highPrivilege: boolean;
  approvalRequired: boolean;
  inputSchema?: unknown;
}

export interface ServerToolsResult {
  serverId: string;
  approvalRequiredTools: string[];
  highPrivilegeTools: string[];
  tools: AdminServerTool[];
  total: number;
}

export interface UpdateServerPolicyRequest {
  highPrivilegeTools?: string[];
  approvalRequiredTools?: string[];
  envFile?: string | null;
  /** Configuration profiles applied to this server (merged into env/headers at start). */
  configProfileIds?: string[];
}

// ---------------------------------------------------------------------------
// v0.4 request types — update tracking & configuration profiles
// ---------------------------------------------------------------------------

export interface UpdateServerRequest {
  ref?: string | null;
  restart?: boolean;
  test?: boolean;
}

export interface ApplyConfigProfileRequest {
  serverIds: string[];
  restart?: boolean;
  test?: boolean;
}

// ---------------------------------------------------------------------------
// v0.5 inspector request types
// ---------------------------------------------------------------------------

export interface ServerActivityFilters {
  status?: AuditStatus;
  toolId?: string;
  keyId?: string;
  limit?: number;
  offset?: number;
}

export interface RevealSecretRequest {
  kind: 'env' | 'header' | 'profile';
  key: string;
  profileId?: string;
}

export interface RevealedSecret {
  key: string;
  value: string;
}

/** Tool row returned by `GET /admin/vaultwarden`. */
export interface VaultWardenTool {
  name: string;
  description: string;
  highPrivilege: boolean;
  approvalRequired: boolean;
}

export interface VaultWardenDefaults {
  approvalTools: string[];
  highPrivilegeTools: string[];
}

/**
 * Vault Warden overview (`GET /admin/vaultwarden`).
 * When the plugin is not installed the endpoint returns the same envelope with
 * `installed: false`, empty `tools`/`pendingApprovals`/`accessLog` and defaults.
 */
export interface VaultWardenOverview {
  installed: boolean;
  serverId?: string | null;
  serverName?: string | null;
  status?: ServerStatus | null;
  tools?: VaultWardenTool[];
  defaults: VaultWardenDefaults;
  pendingApprovals: EscalationTicket[];
  accessLog: AuditEntry[];
}

export interface EscalationResolveResult {
  escalation: EscalationTicket;
  /** Stored one-shot tool result for an approved `tool_approval` ticket. */
  result?: unknown;
}

export interface RequestOptions {
  /** Caller-owned abort signal (combined with the client timeout). */
  signal?: AbortSignal;
}

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

/** Clone + auto-manifest + build + register can exceed the default timeout. */
const INSTALL_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ApiClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch | null;
  private rpcCounter = 0;
  private readonly unauthorizedListeners = new Set<UnauthorizedHandler>();

  constructor(baseUrl = '', options: ApiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? null;
  }

  // -- session / unauthorized handling -------------------------------------

  /** Subscribe to HTTP 401 responses; returns an unsubscribe function. */
  onUnauthorized(handler: UnauthorizedHandler): () => void {
    this.unauthorizedListeners.add(handler);
    return () => {
      this.unauthorizedListeners.delete(handler);
    };
  }

  private notifyUnauthorized(error: ApiError): void {
    for (const handler of this.unauthorizedListeners) {
      try {
        handler(error);
      } catch {
        // A broken listener must never stop the original error from propagating.
      }
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new Event('mcp:unauthorized'));
    }
  }

  // -- transport ------------------------------------------------------------

  /**
   * Perform an authenticated request and decode its JSON body.
   * `timeoutMs` overrides the client-wide timeout for long operations
   * (clone + build + install can take minutes).
   */
  async request<T>(path: string, init: RequestInit = {}, timeoutMs: number = this.timeoutMs): Promise<T> {
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
    if (init.body !== undefined && init.body !== null && headers['Content-Type'] === undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
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
        // HttpOnly session cookie: every browser request is credentialed.
        credentials: 'include',
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new ApiError({
          status: 0,
          code: 'TIMEOUT',
          message: `Request ${path} timed out after ${timeoutMs}ms`,
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

    if (!response.ok) {
      const error = parseApiError(response.status, payload);
      if (response.status === 401) this.notifyUnauthorized(error);
      throw error;
    }
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

  // -- session auth ---------------------------------------------------------

  /** Username/password login; the gateway responds with an HttpOnly cookie. */
  login(username: string, password: string): Promise<LoginResponse> {
    return this.request<LoginResponse>('/mcp/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  }

  /** Destroy the current session cookie. */
  async logout(): Promise<SimpleOkResponse> {
    const response = await this.request<{ ok?: boolean }>('/mcp/v1/auth/logout', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    return { ok: response.ok ?? true };
  }

  /** Current session identity; rejects with a 401 ApiError when signed out. */
  getSession(): Promise<SessionStatus> {
    return this.request<SessionStatus>('/mcp/v1/auth/me');
  }

  /** Change the signed-in user's password. */
  async changePassword(currentPassword: string, newPassword: string): Promise<SimpleOkResponse> {
    const response = await this.request<{ ok?: boolean }>('/mcp/v1/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    return { ok: response.ok ?? true };
  }

  // -- v0.6 first-run setup ------------------------------------------------

  /** Create the first operator account on a fresh gateway (starts a session). */
  setupAccount(username: string, password: string): Promise<LoginResponse> {
    return this.request<LoginResponse>('/mcp/v1/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  }

  /** First-run restore from an encrypted backup (no session required). */
  async setupRestore(backup: unknown, password: string): Promise<RestoreResult> {
    const response = await this.request<{ result: RestoreResult }>('/mcp/v1/auth/setup/restore', {
      method: 'POST',
      body: JSON.stringify({ backup, password }),
    });
    return response.result;
  }

  // -- v0.6 settings & encrypted backups -----------------------------------

  getSettings(): Promise<SettingsResponse> {
    return this.request<SettingsResponse>('/mcp/v1/admin/settings');
  }

  /** Create an encrypted backup (AES-256-GCM, scrypt key from the password). */
  createBackup(input: CreateBackupRequest): Promise<BackupMetadata> {
    return this.request<BackupMetadata>('/mcp/v1/admin/backups', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async listBackups(): Promise<BackupMetadata[]> {
    const response = await this.request<{ backups?: BackupMetadata[] }>('/mcp/v1/admin/backups');
    return response.backups ?? [];
  }

  /** Download a backup envelope as a file (blob + suggested filename). */
  async downloadBackup(id: string): Promise<DownloadBackupResult> {
    const path = `/mcp/v1/admin/backups/${encodeURIComponent(id)}/download`;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    let response: Response;
    try {
      const fetchFn = this.fetchImpl ?? globalThis.fetch;
      if (typeof fetchFn !== 'function') throw new Error('fetch is not available in this environment');
      response = await fetchFn(`${this.baseUrl}${path}`, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/octet-stream, application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new ApiError({
          status: 0,
          code: 'TIMEOUT',
          message: `Backup download timed out after ${this.timeoutMs}ms`,
        });
      }
      throw new ApiError({
        status: 0,
        code: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : 'Backup download failed',
        data: error,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let payload: unknown;
      try {
        const raw = await response.text();
        payload = raw === '' ? null : (JSON.parse(raw) as unknown);
      } catch {
        payload = null;
      }
      const error = parseApiError(response.status, payload);
      if (response.status === 401) this.notifyUnauthorized(error);
      throw error;
    }

    const headerValue =
      typeof response.headers?.get === 'function' ? response.headers.get('content-disposition') : null;
    const match = headerValue === null ? null : /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(headerValue);
    return {
      blob: await response.blob(),
      fileName: match?.[1] ?? `mcp-gateway-backup-${id}.mcpbak`,
    };
  }

  async deleteBackup(id: string): Promise<boolean> {
    const response = await this.request<{ deleted?: boolean }>(
      `/mcp/v1/admin/backups/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    return response.deleted ?? false;
  }

  /** Decrypt and restore a backup (server requires confirm: "RESTORE"). */
  async restoreBackup(input: RestoreBackupRequest): Promise<RestoreResult> {
    const response = await this.request<{ result: RestoreResult }>('/mcp/v1/admin/backups/restore', {
      method: 'POST',
      body: JSON.stringify({ backup: input.backup, password: input.password, confirm: 'RESTORE' }),
    }, 120_000);
    return response.result;
  }

  /** Fetch a missing server checkout after a restore (staged rebuild). */
  async reinstallServer(serverId: string): Promise<ServerUpdateResult> {
    const response = await this.request<{ result: ServerUpdateResult }>(
      `/mcp/v1/admin/updates/servers/${encodeURIComponent(serverId)}/reinstall`,
      { method: 'POST', body: JSON.stringify({}) },
      INSTALL_TIMEOUT_MS,
    );
    return response.result;
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

  /** Patch a key (rename, key-level pause, grant changes, expiry). */
  async updateKey(id: string, input: UpdateKeyInput): Promise<KeySummary> {
    const response = await this.request<{ key: KeySummary }>(`/mcp/v1/admin/keys/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
    return response.key;
  }

  async pauseKey(id: string): Promise<KeySummary> {
    const response = await this.request<{ key: KeySummary }>(
      `/mcp/v1/admin/keys/${encodeURIComponent(id)}/pause`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    return response.key;
  }

  async resumeKey(id: string): Promise<KeySummary> {
    const response = await this.request<{ key: KeySummary }>(
      `/mcp/v1/admin/keys/${encodeURIComponent(id)}/resume`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    return response.key;
  }

  /** Paginated audit activity for one API key (summary + entries + total). */
  getKeyActivity(id: string, filters: KeyActivityFilter = {}): Promise<KeyActivityPage> {
    const query = buildQuery({
      status: filters.status,
      serverId: filters.serverId,
      toolId: filters.toolId,
      limit: filters.limit,
      offset: filters.offset,
    });
    return this.request<KeyActivityPage>(
      `/mcp/v1/admin/keys/${encodeURIComponent(id)}/activity${query}`,
    );
  }

  /** Effective per-server/tool access view for a key (granted/paused/available). */
  getKeyAccess(id: string): Promise<KeyAccessView> {
    return this.request<KeyAccessView>(`/mcp/v1/admin/keys/${encodeURIComponent(id)}/access`);
  }

  /**
   * Issue a brand-new master key for external AI clients. The plaintext is
   * returned exactly once and must be copied by the operator — the console
   * itself authenticates with its session and never adopts it.
   * `revokePrevious` defaults to true server-side.
   */
  regenerateMasterKey(input: RegenerateMasterKeyRequest = {}): Promise<MasterKeyRegeneration> {
    return this.request<MasterKeyRegeneration>('/mcp/v1/admin/keys/master/regenerate', {
      method: 'POST',
      body: JSON.stringify(input),
    });
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

  async serverTools(id: string): Promise<ServerToolsResult> {
    return this.request<ServerToolsResult>(`/mcp/v1/admin/servers/${encodeURIComponent(id)}/tools`);
  }

  /** Activation probe: starts the server if needed and lists its tools. */
  testServer(id: string, options: RequestOptions = {}): Promise<InstallTestResult> {
    return this.request<InstallTestResult>(
      `/mcp/v1/admin/servers/${encodeURIComponent(id)}/test`,
      {
        method: 'POST',
        body: JSON.stringify({}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      60_000,
    );
  }

  /** Save tool policy (high-privilege / approval-required) plus an env file path. */
  async updateServerPolicy(id: string, patch: UpdateServerPolicyRequest): Promise<ServerRecord> {
    const response = await this.request<{ server: ServerRecord }>(
      `/mcp/v1/admin/servers/${encodeURIComponent(id)}/policy`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );
    return response.server;
  }

  // -- v0.2 plugin catalog --------------------------------------------------

  async listCatalogSources(): Promise<CatalogSource[]> {
    const response = await this.request<{ sources?: CatalogSource[] }>('/mcp/v1/admin/catalog/sources');
    return response.sources ?? [];
  }

  async addCatalogSource(input: AddCatalogSourceRequest): Promise<CatalogSource> {
    const response = await this.request<{ source: CatalogSource }>('/mcp/v1/admin/catalog/sources', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return response.source;
  }

  async deleteCatalogSource(id: string): Promise<boolean> {
    const response = await this.request<{ deleted?: boolean }>(
      `/mcp/v1/admin/catalog/sources/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    return response.deleted ?? false;
  }

  async listCatalogEntries(sourceId: string, refresh = false): Promise<CatalogEntriesResult> {
    const query = buildQuery({ refresh: refresh ? 1 : undefined });
    return this.request<CatalogEntriesResult>(
      `/mcp/v1/admin/catalog/sources/${encodeURIComponent(sourceId)}/entries${query}`,
    );
  }

  installCatalogEntry(
    input: CatalogInstallRequest,
    options: RequestOptions = {},
  ): Promise<CatalogInstallResult> {
    return this.request<CatalogInstallResult>(
      '/mcp/v1/admin/catalog/install',
      {
        method: 'POST',
        body: JSON.stringify(input),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      INSTALL_TIMEOUT_MS,
    );
  }

  importCatalogUrl(
    input: CatalogImportUrlRequest,
    options: RequestOptions = {},
  ): Promise<CatalogInstallResult> {
    return this.request<CatalogInstallResult>(
      '/mcp/v1/admin/catalog/import-url',
      {
        method: 'POST',
        body: JSON.stringify(input),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      INSTALL_TIMEOUT_MS,
    );
  }

  // -- v0.2 local harness discovery ----------------------------------------

  async listDiscoverySources(): Promise<HarnessSourceInfo[]> {
    const response = await this.request<{ sources?: HarnessSourceInfo[] }>('/mcp/v1/admin/discovery/sources');
    return response.sources ?? [];
  }

  async scanDiscovery(harnessIds?: string[]): Promise<HarnessScanResult> {
    const body: DiscoveryScanRequest =
      harnessIds !== undefined && harnessIds.length > 0 ? { harnessIds } : {};
    const response = await this.request<Partial<HarnessScanResult>>(
      '/mcp/v1/admin/discovery/scan',
      { method: 'POST', body: JSON.stringify(body) },
      60_000,
    );
    return {
      sources: response.sources ?? [],
      entries: response.entries ?? [],
      errors: response.errors ?? [],
    };
  }

  async importDiscoveryEntry(input: HarnessImportInput): Promise<ServerRecord> {
    const response = await this.request<{ server: ServerRecord }>('/mcp/v1/admin/discovery/import', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return response.server;
  }

  // -- v0.2 Vault Warden ----------------------------------------------------

  async getVaultWarden(): Promise<VaultWardenOverview> {
    const response = await this.request<Partial<VaultWardenOverview>>('/mcp/v1/admin/vaultwarden');
    return {
      ...response,
      installed: response.installed === true,
      defaults: {
        approvalTools: response.defaults?.approvalTools ?? [],
        highPrivilegeTools: response.defaults?.highPrivilegeTools ?? [],
      },
      pendingApprovals: response.pendingApprovals ?? [],
      accessLog: response.accessLog ?? [],
      tools: response.tools ?? [],
    };
  }

  /** Apply the default Vault Warden protection sets to its sub-server. */
  async protectVaultWarden(serverId: string): Promise<ServerRecord> {
    const response = await this.request<{ server: ServerRecord }>('/mcp/v1/admin/vaultwarden/protect', {
      method: 'POST',
      body: JSON.stringify({ serverId }),
    });
    return response.server;
  }

  // -- v0.4 update tracking -------------------------------------------------

  /** Every server with a tracked upstream repository plus its last known state. */
  async listServerUpdates(): Promise<ServerSourceInfo[]> {
    const response = await this.request<{ sources?: ServerSourceInfo[] }>('/mcp/v1/admin/updates');
    return response.sources ?? [];
  }

  /** Re-read upstream refs/commits for one or every tracked server. */
  async checkUpdates(serverIds?: string[]): Promise<UpdateCheckResult[]> {
    const body = serverIds !== undefined && serverIds.length > 0 ? { serverIds } : {};
    const response = await this.request<{ results?: UpdateCheckResult[] }>(
      '/mcp/v1/admin/updates/check',
      { method: 'POST', body: JSON.stringify(body) },
      120_000,
    );
    return response.results ?? [];
  }

  async checkServerUpdate(serverId: string): Promise<UpdateCheckResult> {
    const response = await this.request<{ update: UpdateCheckResult }>(
      `/mcp/v1/admin/updates/servers/${encodeURIComponent(serverId)}/check`,
      { method: 'POST', body: JSON.stringify({}) },
      120_000,
    );
    return response.update;
  }

  /** Rebuild a tracked server from its upstream, optionally restarting/testing it. */
  async updateServer(serverId: string, input: UpdateServerRequest = {}): Promise<ServerUpdateResult> {
    const response = await this.request<{ result: ServerUpdateResult }>(
      `/mcp/v1/admin/updates/servers/${encodeURIComponent(serverId)}/update`,
      { method: 'POST', body: JSON.stringify(input) },
      INSTALL_TIMEOUT_MS,
    );
    return response.result;
  }

  // -- v0.5 server inspector ------------------------------------------------

  /** Full per-server view: tools/prompts/resources, config, stats and recent activity. */
  getServerInspector(serverId: string): Promise<ServerInspectorOverview> {
    return this.request<ServerInspectorOverview>(
      `/mcp/v1/admin/servers/${encodeURIComponent(serverId)}/inspector`,
    );
  }

  /** Paginated audit slice for one server (summary + entries + total). */
  getServerActivity(serverId: string, filters: ServerActivityFilters = {}): Promise<ServerActivityPage> {
    const query = buildQuery({
      status: filters.status,
      toolId: filters.toolId,
      keyId: filters.keyId,
      limit: filters.limit,
      offset: filters.offset,
    });
    return this.request<ServerActivityPage>(
      `/mcp/v1/admin/servers/${encodeURIComponent(serverId)}/activity${query}`,
    );
  }

  /** Audited, one-shot credential reveal for a server env/header or profile entry. */
  revealSecret(serverId: string, input: RevealSecretRequest): Promise<RevealedSecret> {
    return this.request<RevealedSecret>(
      `/mcp/v1/admin/servers/${encodeURIComponent(serverId)}/reveal`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  }

  // -- v0.4 configuration profiles -----------------------------------------

  async listConfigProfiles(): Promise<ConfigProfileSummary[]> {
    const response = await this.request<{ profiles?: ConfigProfileSummary[] }>(
      '/mcp/v1/admin/config-profiles',
    );
    return response.profiles ?? [];
  }

  async createConfigProfile(input: ConfigProfileInput): Promise<ConfigProfileSummary> {
    const response = await this.request<{ profile: ConfigProfileSummary }>(
      '/mcp/v1/admin/config-profiles',
      { method: 'POST', body: JSON.stringify(input) },
    );
    return response.profile;
  }

  async getConfigProfile(id: string): Promise<ConfigProfileSummary> {
    const response = await this.request<{ profile: ConfigProfileSummary }>(
      `/mcp/v1/admin/config-profiles/${encodeURIComponent(id)}`,
    );
    return response.profile;
  }

  async updateConfigProfile(id: string, input: ConfigProfileInput): Promise<ConfigProfileSummary> {
    const response = await this.request<{ profile: ConfigProfileSummary }>(
      `/mcp/v1/admin/config-profiles/${encodeURIComponent(id)}`,
      { method: 'PUT', body: JSON.stringify(input) },
    );
    return response.profile;
  }

  async deleteConfigProfile(id: string): Promise<boolean> {
    const response = await this.request<{ deleted?: boolean }>(
      `/mcp/v1/admin/config-profiles/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    return response.deleted ?? false;
  }

  /** Attach a profile to servers (union), optionally restarting and probing them. */
  async applyConfigProfile(
    id: string,
    input: ApplyConfigProfileRequest,
  ): Promise<ConfigProfileApplyResult[]> {
    const response = await this.request<{ results?: ConfigProfileApplyResult[] }>(
      `/mcp/v1/admin/config-profiles/${encodeURIComponent(id)}/apply`,
      { method: 'POST', body: JSON.stringify(input) },
      120_000,
    );
    return response.results ?? [];
  }

  async detachConfigProfile(id: string, serverId: string): Promise<boolean> {
    const response = await this.request<{ detached?: boolean }>(
      `/mcp/v1/admin/config-profiles/${encodeURIComponent(id)}/servers/${encodeURIComponent(serverId)}`,
      { method: 'DELETE' },
    );
    return response.detached ?? false;
  }

  /**
   * Migrate a legacy server env file into a new encrypted profile attached to
   * that server (the gateway reads the file once, encrypts every value, then
   * clears `server.envFile`). Values never return to the browser.
   */
  async migrateEnvFile(serverId: string, name?: string): Promise<ConfigProfileSummary> {
    const response = await this.request<{ profile: ConfigProfileSummary }>(
      '/mcp/v1/admin/config-profiles/migrate-env-file',
      {
        method: 'POST',
        body: JSON.stringify(name === undefined ? { serverId } : { serverId, name }),
      },
      60_000,
    );
    return response.profile;
  }

  // -- v0.7 credential providers -------------------------------------------

  getCredentialProviders(): Promise<CredentialProvidersResponse> {
    return this.request<CredentialProvidersResponse>('/mcp/v1/admin/credentials/providers');
  }

  async configureCredentialProvider(
    id: CredentialProviderId,
    values: Record<string, string>,
  ): Promise<CredentialProviderStatus> {
    const response = await this.request<{ provider: CredentialProviderStatus }>(
      `/mcp/v1/admin/credentials/providers/${encodeURIComponent(id)}`,
      { method: 'PUT', body: JSON.stringify({ values }) },
    );
    return response.provider;
  }

  async clearCredentialProvider(id: CredentialProviderId): Promise<CredentialProviderStatus> {
    const response = await this.request<{ provider: CredentialProviderStatus }>(
      `/mcp/v1/admin/credentials/providers/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    return response.provider;
  }

  async testCredentialProvider(id: CredentialProviderId): Promise<CredentialProviderStatus> {
    const response = await this.request<{ provider: CredentialProviderStatus }>(
      `/mcp/v1/admin/credentials/providers/${encodeURIComponent(id)}/test`,
      { method: 'POST', body: JSON.stringify({}) },
      60_000,
    );
    return response.provider;
  }

  async setDefaultCredentialProvider(id: CredentialProviderId): Promise<CredentialProviderId> {
    const response = await this.request<{ defaultProvider: CredentialProviderId }>(
      '/mcp/v1/admin/credentials/default',
      { method: 'POST', body: JSON.stringify({ providerId: id }) },
    );
    return response.defaultProvider;
  }

  async listCredentialItems(
    provider: CredentialProviderId,
    query: CredentialItemQuery = {},
  ): Promise<CredentialItem[]> {
    const qs = buildQuery({ provider, search: query.search, limit: query.limit });
    const response = await this.request<{ items?: CredentialItem[] }>(
      `/mcp/v1/admin/credentials/items${qs}`,
      {},
      60_000,
    );
    return response.items ?? [];
  }

  async revealCredential(input: RevealCredentialRequest): Promise<CredentialRevealResult> {
    const response = await this.request<{ reveal: CredentialRevealResult }>(
      '/mcp/v1/admin/credentials/reveal',
      { method: 'POST', body: JSON.stringify(input) },
    );
    return response.reveal;
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

  /**
   * Approve/deny an escalation ticket. For `tool_approval` tickets an approval
   * executes the stored call once and returns its stored result alongside the
   * updated ticket.
   */
  async resolveEscalation(
    ticket: string,
    status: ResolveEscalationStatus,
    note?: string,
  ): Promise<EscalationResolveResult> {
    const response = await this.request<EscalationResolveResult>(
      `/mcp/v1/admin/escalations/${encodeURIComponent(ticket)}/resolve`,
      { method: 'POST', body: JSON.stringify(note ? { status, note } : { status }) },
    );
    return response;
  }
}

/** Console-wide singleton; the default base URL is same-origin. */
export const api = new ApiClient(import.meta.env.VITE_API_BASE_URL ?? '');
