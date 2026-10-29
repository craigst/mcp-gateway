/**
 * Computer use (v0.9): fronts an external Computer Broker as a managed MCP
 * server inside the gateway, and owns agent availability for it.
 *
 * Design notes:
 *  - The broker is *not* vendored: it is a separate self-hosted service. The
 *    gateway registers one built-in MCP server named `computer-use` whose tools
 *    are the broker's MCP tool surface, so RBAC, guardrails, approvals and audit
 *    apply exactly as they do to any other sub-server.
 *  - The broker token is never stored on the ServerRecord. It comes from the
 *    gateway environment or the encrypted vault and lives only in the broker
 *    client instance.
 *  - Availability (global and per computer) is gateway state, enforced by the
 *    router *before* a computer-use call executes. A paused computer refuses
 *    calls and never queues them.
 */
import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import type { GatewayConfig } from '../core/config.js';
import { ErrorCodes, GatewayError, invalidParams } from '../core/errors.js';
import { nowIso } from '../core/ids.js';
import { createLogger, type Logger } from '../core/logger.js';
import type {
  AuditService,
  CatalogRepository,
  ComputerUseBrokerPort,
  ComputerUseCallDecision,
  ComputerUseFrameResult,
  ComputerUseService,
  McpClient,
  Supervisor,
  VaultService,
} from '../core/ports.js';
import type {
  AuditEntry,
  ComputerUseAvailability,
  ComputerUseAvailabilityInput,
  ComputerUseBrokerInfo,
  ComputerUseComputerInfo,
  ComputerUseComputersResponse,
  ComputerUseCounts,
  ComputerUseOverview,
  ComputerUseSettingsInfo,
  ComputerUseSettingsInput,
  ComputerUseToolInfo,
  ServerRecord,
  ToolDescriptor,
} from '../core/types.js';
import { BrokerHttpClient } from './broker-client.js';
import { BrokerMcpClient } from './mcp-client.js';
import { ComputerUseStore, type StoredComputerUseSettings } from './settings-store.js';

/** Stable id so RBAC grants survive the broker being reconfigured. */
export const COMPUTER_USE_SERVER_ID = 'srv_computer_use';
export const COMPUTER_USE_SERVER_NAME = 'computer-use';
export const BROKER_TOKEN_SECRET = 'computer_broker_token';

/**
 * Tools that act on a machine. Hidden from discovery until the key is granted
 * them explicitly (the same default-hidden model as every other high-privilege
 * MCP tool). Kept explicit rather than inferred so a broker upgrade cannot
 * silently widen an agent's reach.
 */
const HIGH_PRIVILEGE_TOOLS: readonly string[] = [
  'create_computer',
  'start_computer',
  'stop_computer',
  'destroy_computer',
  'computer_click',
  'computer_move',
  'computer_type',
  'computer_key',
  'computer_scroll',
  'computer_open_app',
  'device_exec',
  'device_terminal_open',
  'device_terminal_send',
  'device_terminal_close',
];

/** Irreversible tools additionally require a supervisor approval ticket. */
const APPROVAL_REQUIRED_TOOLS: readonly string[] = ['destroy_computer', 'device_exec'];

/** Read-only tools, for the console's tool catalogue. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'list_templates',
  'list_computers',
  'computer_status',
  'computer_screenshot',
  'computer_windows',
  'list_devices',
  'device_file_list',
  'device_file_read',
  'device_terminal_read',
]);

const HEALTH_CACHE_MS = 3_000;
const COMPUTERS_CACHE_MS = 2_000;
const MAX_REASON_LENGTH = 200;

export interface ComputerUseServiceOptions {
  config: GatewayConfig;
  db: DatabaseSync;
  repository: CatalogRepository;
  supervisor: Supervisor;
  vault?: VaultService;
  audit?: AuditService;
  logger?: Logger;
  /** Test seam: build a broker client without touching the network. */
  brokerFactory?: (input: { baseUrl: string; token: string | null; caFile: string | null }) => ComputerUseBrokerPort;
}

interface TokenResolution {
  token: string | null;
  source: 'env' | 'vault' | null;
}

interface HealthCacheEntry {
  at: number;
  value: ComputerUseBrokerInfo;
}

interface ComputersCacheEntry {
  at: number;
  value: Awaited<ReturnType<ComputerUseBrokerPort['listComputers']>>;
}

export class DefaultComputerUseService implements ComputerUseService {
  readonly managedServerName = COMPUTER_USE_SERVER_NAME;

  private readonly store: ComputerUseStore;
  private readonly logger: Logger;
  private readonly repository: CatalogRepository;
  private readonly supervisor: Supervisor;
  private readonly vault: VaultService | undefined;
  private readonly audit: AuditService | undefined;

  private broker: ComputerUseBrokerPort | null = null;
  private managedId: string | null = null;
  private brokerVersion: string | null = null;
  private healthCache: HealthCacheEntry | null = null;
  private computersCache: ComputersCacheEntry | null = null;

  constructor(private readonly options: ComputerUseServiceOptions) {
    this.logger = options.logger ?? createLogger('computer-use');
    this.repository = options.repository;
    this.supervisor = options.supervisor;
    this.vault = options.vault;
    this.audit = options.audit;
    this.store = new ComputerUseStore(options.db);

    const config = options.config.computerUse;
    this.store.ensureRow({
      brokerUrl: config?.brokerUrl ?? null,
      publicBrokerUrl: config?.publicBrokerUrl ?? null,
      caFile: config?.caFile ?? null,
      enabled: config?.enabled ?? true,
    });
    this.reloadBroker();
  }

  get serverId(): string | null {
    return this.managedId;
  }

  async initialize(): Promise<void> {
    try {
      this.reloadBroker();
      this.ensureManagedServer();
      if (this.managedId !== null && this.isActive()) {
        await this.supervisor.start(this.managedId);
        this.logger.info('computer-use server started', { serverId: this.managedId });
      }
    } catch (error) {
      // A broken broker must never prevent the gateway from booting.
      this.logger.warn('computer-use initialisation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async sync(): Promise<ComputerUseOverview> {
    this.reloadBroker();
    if (this.managedId !== null) {
      try {
        await this.supervisor.stop(this.managedId);
      } catch (error) {
        this.logger.debug('computer-use stop before sync failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.ensureManagedServer();
    if (this.managedId !== null) {
      try {
        await this.supervisor.start(this.managedId);
      } catch (error) {
        this.logger.warn('computer-use server failed to start', {
          serverId: this.managedId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.invalidateCaches();
    return this.overview();
  }

  async overview(): Promise<ComputerUseOverview> {
    const settings = this.store.get();
    const server = this.managedServerRecord();
    const tools = server === null ? [] : this.toolInfo(server);
    const broker = await this.brokerInfo();
    const computers = this.managedId === null ? [] : await this.safeComputers();
    const counts = this.counts(settings, computers);
    return {
      settings: this.settingsInfo(settings),
      broker,
      availability: settings.availability,
      server: {
        id: server?.id ?? null,
        name: COMPUTER_USE_SERVER_NAME,
        status: server?.status ?? 'absent',
        toolCount: tools.length,
        lastError: server?.lastError ?? null,
      },
      tools,
      counts,
    };
  }

  async listComputers(): Promise<ComputerUseComputersResponse> {
    const settings = this.store.get();
    const broker = await this.brokerInfo();
    if (this.broker === null) {
      return { broker, availability: settings.availability, computers: [] };
    }
    const computers = await this.safeComputers();
    return {
      broker,
      availability: settings.availability,
      computers: this.mapComputers(settings, computers),
    };
  }

  async updateSettings(input: ComputerUseSettingsInput): Promise<ComputerUseOverview> {
    const patch: {
      brokerUrl?: string | null;
      publicBrokerUrl?: string | null;
      caFile?: string | null;
      enabled?: boolean;
    } = {};

    if (input.brokerUrl !== undefined) patch.brokerUrl = normalizeBaseUrl(input.brokerUrl, 'brokerUrl');
    if (input.publicBrokerUrl !== undefined) {
      patch.publicBrokerUrl = normalizeBaseUrl(input.publicBrokerUrl, 'publicBrokerUrl');
    }
    if (input.caFile !== undefined) patch.caFile = normalizeCaFile(input.caFile);
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw invalidParams("'enabled' must be a boolean");
      patch.enabled = input.enabled;
    }
    if (input.token !== undefined) {
      const token = typeof input.token === 'string' ? input.token.trim() : input.token === null ? '' : null;
      if (token === null) throw invalidParams("'token' must be a string or null");
      this.storeToken(token);
    }

    this.store.update(patch);
    if (this.managedId !== null) {
      try {
        await this.supervisor.stop(this.managedId);
      } catch {
        // best effort: the row may already be stopped
      }
    }
    this.reloadBroker();
    this.ensureManagedServer();
    if (this.managedId !== null && this.isActive()) {
      try {
        await this.supervisor.start(this.managedId);
      } catch (error) {
        this.logger.warn('computer-use server failed to start after settings change', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.invalidateCaches();
    return this.overview();
  }

  async setAvailability(input: ComputerUseAvailabilityInput, updatedBy = 'operator'): Promise<ComputerUseOverview> {
    const available = Boolean(input.available);
    const until = normalizeUntil(input.until);
    const reason = available ? null : normalizeReason(input.reason);
    if (input.scope === 'global') {
      this.store.setGlobalAvailability({ available, reason, until, updatedBy });
    } else if (input.scope === 'computer') {
      const computerId = typeof input.computerId === 'string' ? input.computerId.trim() : '';
      if (computerId === '') throw invalidParams("'computerId' is required for computer scope");
      this.store.setComputerAvailability(computerId, { available, reason, until, updatedBy });
    } else {
      throw invalidParams("'scope' must be 'global' or 'computer'");
    }
    this.invalidateCaches();
    return this.overview();
  }

  async startComputer(computerId: string): Promise<ComputerUseComputerInfo> {
    const broker = this.requireBroker();
    const computer = await broker.startComputer(requiredComputerId(computerId));
    this.computersCache = null;
    this.healthCache = null;
    return this.mapComputer(this.store.get(), computer);
  }

  async stopComputer(computerId: string): Promise<ComputerUseComputerInfo> {
    const broker = this.requireBroker();
    const computer = await broker.stopComputer(requiredComputerId(computerId));
    this.computersCache = null;
    this.healthCache = null;
    return this.mapComputer(this.store.get(), computer);
  }

  async frame(computerId: string, maxWidth: number): Promise<ComputerUseFrameResult> {
    const broker = this.requireBroker();
    const width = Math.min(1_600, Math.max(160, Number.isFinite(maxWidth) ? Math.round(maxWidth) : 480));
    return broker.frame(requiredComputerId(computerId), width);
  }

  async activity(limit: number): Promise<AuditEntry[]> {
    if (this.managedId === null || this.audit === undefined) return [];
    const capped = Math.min(500, Math.max(1, Math.round(limit)));
    return this.audit.query({ serverId: this.managedId, limit: capped, offset: 0 }).entries;
  }

  checkCall(tool: ToolDescriptor, args: Record<string, unknown>): ComputerUseCallDecision {
    if (this.managedId === null || tool.serverId !== this.managedId) return { allowed: true };
    const availability = this.store.get().availability;
    const computerId = readComputerId(args);
    if (!availability.available) {
      return {
        allowed: false,
        reason: 'COMPUTER_USE_PAUSED',
        message: pauseMessage('Computer use is paused by the operator', availability),
        computerId,
        until: availability.until,
      };
    }
    if (computerId !== null) {
      const computerAvailability = this.store.computerAvailability(computerId);
      if (!computerAvailability.available) {
        return {
          allowed: false,
          reason: 'COMPUTER_PAUSED',
          message: pauseMessage(`Computer '${computerId}' is paused by the operator`, computerAvailability),
          computerId,
          until: computerAvailability.until,
        };
      }
    }
    return { allowed: true };
  }

  createClient(serverId: string): McpClient | null {
    if (this.managedId === null || serverId !== this.managedId) return null;
    const broker = this.broker ?? this.buildBroker();
    if (broker === null) {
      throw new GatewayError(
        ErrorCodes.INVALID_PARAMS,
        'Computer Broker is not configured. Set MCP_COMPUTER_BROKER_URL and a token in the console.',
        { data: { status: 'COMPUTER_USE_UNCONFIGURED', reason: 'NOT_CONFIGURED' } },
      );
    }
    return new BrokerMcpClient(broker, {
      serverId,
      version: this.brokerVersion ?? '1.0.0',
    });
  }

  async dispose(): Promise<void> {
    this.broker = null;
    this.healthCache = null;
    this.computersCache = null;
    this.managedId = null;
  }

  // -------------------------------------------------------------------------
  // Managed server registration
  // -------------------------------------------------------------------------

  private ensureManagedServer(): void {
    const settings = this.store.get();
    const active = this.isActive(settings);
    const existing = this.repository.getServerByName(COMPUTER_USE_SERVER_NAME);

    if (!active) {
      if (existing) {
        this.repository.deleteServer(existing.id);
        this.logger.info('removed computer-use server row (broker not configured or disabled)');
      }
      this.managedId = null;
      return;
    }

    const now = nowIso();
    const record: ServerRecord = {
      id: existing?.id ?? COMPUTER_USE_SERVER_ID,
      name: COMPUTER_USE_SERVER_NAME,
      runtime: 'remote-agent',
      transport: 'http',
      status: 'stopped',
      command: null,
      args: [],
      url: `${settings.brokerUrl}/mcp`,
      env: {},
      headers: {},
      manifest: null,
      highPrivilegeTools: [...HIGH_PRIVILEGE_TOOLS],
      delegationSupported: false,
      sourceUrl: null,
      workDir: null,
      envFile: null,
      approvalRequiredTools: [...APPROVAL_REQUIRED_TOOLS],
      configProfileIds: [],
      capabilities: existing?.capabilities,
      instructions: existing?.instructions ?? null,
      prompts: existing?.prompts ?? [],
      resources: existing?.resources ?? [],
      lastError: existing?.lastError ?? null,
      pid: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.repository.upsertServer(record);
    this.managedId = record.id;
  }

  private managedServerRecord(): ServerRecord | null {
    if (this.managedId !== null) {
      const byId = this.repository.getServer(this.managedId);
      if (byId) return byId;
    }
    const byName = this.repository.getServerByName(COMPUTER_USE_SERVER_NAME);
    if (byName) this.managedId = byName.id;
    return byName;
  }

  // -------------------------------------------------------------------------
  // Broker plumbing
  // -------------------------------------------------------------------------

  private resolveToken(): TokenResolution {
    const envToken = this.options.config.computerUse?.brokerToken ?? null;
    if (envToken !== null && envToken !== '') return { token: envToken, source: 'env' };
    if (this.vault?.isEnabled()) {
      try {
        const stored = this.vault.getSecret(BROKER_TOKEN_SECRET);
        if (stored !== null && stored !== '') return { token: stored, source: 'vault' };
      } catch {
        // a corrupt secret must not break the whole feature
      }
    }
    return { token: null, source: null };
  }

  private isActive(settings: StoredComputerUseSettings = this.store.get()): boolean {
    if (!settings.enabled) return false;
    if (settings.brokerUrl === null || settings.brokerUrl === '') return false;
    return this.resolveToken().token !== null;
  }

  private buildBroker(): ComputerUseBrokerPort | null {
    const settings = this.store.get();
    if (settings.brokerUrl === null || settings.brokerUrl === '') return null;
    const { token } = this.resolveToken();
    if (token === null) return null;
    if (this.options.brokerFactory) {
      return this.options.brokerFactory({ baseUrl: settings.brokerUrl, token, caFile: settings.caFile });
    }
    return new BrokerHttpClient({
      baseUrl: settings.brokerUrl,
      token,
      caFile: settings.caFile,
      logger: this.logger,
    });
  }

  private reloadBroker(): void {
    this.broker = this.buildBroker();
  }

  private requireBroker(): ComputerUseBrokerPort {
    if (this.broker === null) {
      throw new GatewayError(
        ErrorCodes.INVALID_PARAMS,
        'Computer Broker is not configured. Set the broker URL and token in the computer-use settings.',
        { data: { status: 'COMPUTER_USE_UNCONFIGURED', reason: 'NOT_CONFIGURED' } },
      );
    }
    return this.broker;
  }

  private storeToken(token: string): void {
    const envToken = this.options.config.computerUse?.brokerToken ?? null;
    if (token === '') {
      if (envToken !== null && envToken !== '') {
        throw invalidParams('The broker token is supplied by MCP_COMPUTER_BROKER_TOKEN and cannot be cleared here.');
      }
      if (this.vault?.isEnabled()) this.vault.deleteSecret(BROKER_TOKEN_SECRET);
      return;
    }
    if (!this.vault?.isEnabled()) {
      throw new GatewayError(
        ErrorCodes.INVALID_PARAMS,
        'MCP_VAULT_SECRET must be configured to store the broker token in the gateway vault. Alternatively set MCP_COMPUTER_BROKER_TOKEN.',
        { data: { status: 'VAULT_DISABLED', reason: 'VAULT_DISABLED' } },
      );
    }
    this.vault.setSecret(BROKER_TOKEN_SECRET, token);
  }

  private async brokerInfo(): Promise<ComputerUseBrokerInfo> {
    const settings = this.store.get();
    const { token, source } = this.resolveToken();
    const base: ComputerUseBrokerInfo = {
      configured: settings.brokerUrl !== null && token !== null,
      reachable: false,
      url: settings.brokerUrl,
      version: this.brokerVersion,
      tls: settings.brokerUrl?.startsWith('https://') ?? false,
      computers: null,
      devices: null,
      connectorsOnline: null,
      checkedAt: null,
      error: null,
    };
    if (settings.brokerUrl === null || settings.brokerUrl === '') {
      return { ...base, error: 'No broker URL configured' };
    }
    if (token === null) {
      return { ...base, error: source === null ? 'No broker token configured' : 'Broker token unavailable' };
    }
    const cached = this.healthCache;
    if (cached !== null && Date.now() - cached.at < HEALTH_CACHE_MS) return cached.value;

    try {
      const broker = this.broker ?? this.buildBroker();
      if (broker === null) return { ...base, error: 'Broker client unavailable' };
      const health = await broker.health();
      this.brokerVersion = health.version;
      const value: ComputerUseBrokerInfo = {
        ...base,
        reachable: health.ok,
        version: health.version,
        tls: health.tls || base.tls,
        computers: health.computers,
        devices: health.devices,
        connectorsOnline: health.connectorsOnline,
        checkedAt: nowIso(),
        error: health.ok ? null : 'Broker reported an unhealthy status',
      };
      this.healthCache = { at: Date.now(), value };
      return value;
    } catch (error) {
      const value: ComputerUseBrokerInfo = {
        ...base,
        reachable: false,
        checkedAt: nowIso(),
        error: error instanceof Error ? error.message : String(error),
      };
      this.healthCache = { at: Date.now(), value };
      return value;
    }
  }

  private async safeComputers(): Promise<Awaited<ReturnType<ComputerUseBrokerPort['listComputers']>>> {
    const broker = this.broker ?? this.buildBroker();
    if (broker === null) return [];
    const cached = this.computersCache;
    if (cached !== null && Date.now() - cached.at < COMPUTERS_CACHE_MS) return cached.value;
    try {
      const computers = await broker.listComputers();
      this.computersCache = { at: Date.now(), value: computers };
      return computers;
    } catch (error) {
      this.logger.debug('computer list failed', { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  private invalidateCaches(): void {
    this.healthCache = null;
    this.computersCache = null;
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private mapComputers(
    settings: StoredComputerUseSettings,
    computers: Awaited<ReturnType<ComputerUseBrokerPort['listComputers']>>,
  ): ComputerUseComputerInfo[] {
    return computers.map((computer) => this.mapComputer(settings, computer));
  }

  private mapComputer(
    settings: StoredComputerUseSettings,
    computer: Awaited<ReturnType<ComputerUseBrokerPort['getComputer']>>,
  ): ComputerUseComputerInfo {
    const perComputer = this.store.computerAvailability(computer.id);
    const merged = mergeAvailability(settings.availability, perComputer);
    const liveBase = settings.publicBrokerUrl ?? settings.brokerUrl;
    return {
      id: computer.id,
      name: computer.name,
      template: computer.template,
      provider: computer.provider,
      state: computer.state,
      viewer: computer.viewer,
      error: computer.error,
      createdAt: computer.createdAt,
      ttlAt: computer.ttlAt,
      desktop: computer.desktop,
      connector: computer.connector,
      control: computer.control,
      availability: merged,
      liveUrl: liveBase === null ? null : `${liveBase}/#/d/${encodeURIComponent(computer.id)}`,
    };
  }

  private counts(
    settings: StoredComputerUseSettings,
    computers: Awaited<ReturnType<ComputerUseBrokerPort['listComputers']>>,
  ): ComputerUseCounts {
    const perComputer = this.store.listComputerAvailability();
    let available = 0;
    let paused = 0;
    let ready = 0;
    let connectorsOnline = 0;
    for (const computer of computers) {
      const merged = mergeAvailability(settings.availability, perComputer.get(computer.id) ?? availableRecord());
      if (merged.available) available += 1;
      else paused += 1;
      if (computer.state === 'ready') ready += 1;
      if (computer.connector?.state === 'online') connectorsOnline += 1;
    }
    return { computers: computers.length, available, paused, ready, connectorsOnline };
  }

  private settingsInfo(settings: StoredComputerUseSettings): ComputerUseSettingsInfo {
    const { source } = this.resolveToken();
    return {
      brokerUrl: settings.brokerUrl,
      publicBrokerUrl: settings.publicBrokerUrl,
      caFile: settings.caFile,
      tokenConfigured: source !== null,
      tokenSource: source,
      enabled: settings.enabled,
      updatedAt: settings.updatedAt,
    };
  }

  private toolInfo(server: ServerRecord): ComputerUseToolInfo[] {
    return this.repository.listToolsByServer(server.id).map((tool) => ({
      name: tool.name,
      description: tool.description,
      highPrivilege: tool.highPrivilege,
      approvalRequired: (server.approvalRequiredTools ?? []).includes(tool.name),
      readOnly: READ_ONLY_TOOLS.has(tool.name),
    }));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function availableRecord(): ComputerUseAvailability {
  return { available: true, state: 'available', reason: null, until: null, updatedAt: null, updatedBy: null };
}

/** Effective availability = paused if either the global or computer switch is off. */
function mergeAvailability(
  global: ComputerUseAvailability,
  computer: ComputerUseAvailability,
): ComputerUseAvailability {
  if (!global.available) return global;
  if (!computer.available) return computer;
  return { ...global, updatedAt: global.updatedAt ?? computer.updatedAt, updatedBy: global.updatedBy ?? computer.updatedBy };
}

function readComputerId(args: Record<string, unknown>): string | null {
  const value = args['computer_id'] ?? args['computerId'] ?? args['id'];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function requiredComputerId(value: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '') throw invalidParams("'computerId' is required");
  return trimmed;
}

function pauseMessage(prefix: string, availability: ComputerUseAvailability): string {
  const reason = availability.reason !== null ? ` (${availability.reason})` : '';
  const until = availability.until !== null ? ` until ${availability.until}` : ' until the operator resumes it';
  return `${prefix}${reason}${until}.`;
}

function normalizeReason(value: string | null | undefined): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason === '') return 'Paused by operator';
  return reason.slice(0, MAX_REASON_LENGTH);
}

function normalizeUntil(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw invalidParams("'until' must be an ISO timestamp or null");
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw invalidParams("'until' must be a valid ISO timestamp");
  if (ms <= Date.now()) throw invalidParams("'until' must be a future timestamp");
  return new Date(ms).toISOString();
}

function normalizeBaseUrl(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidParams(`'${field}' must be a string or null`);
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw invalidParams(`'${field}' must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalidParams(`'${field}' must use http or https`);
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw invalidParams(`'${field}' must be a base URL without a path, query or fragment`);
  }
  return trimmed;
}

function normalizeCaFile(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidParams("'caFile' must be a string or null");
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!existsSync(trimmed)) throw invalidParams(`CA file '${trimmed}' does not exist`);
  return trimmed;
}
