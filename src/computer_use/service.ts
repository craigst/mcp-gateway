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
  BrokerDeviceSnapshot,
  BrokerVmHostSnapshot,
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
  ComputerUseConnectorRemoveInput,
  ComputerUseConnectorRemoveResult,
  ComputerUseConnectorUpdateResult,
  ComputerUseConnectorsResponse,
  ComputerUseCounts,
  ComputerUseDeviceInfo,
  ComputerUseEnrollmentInput,
  ComputerUseEnrollmentKind,
  ComputerUseEnrollmentResponse,
  ComputerUseHostComputer,
  ComputerUseHostComputerInput,
  ComputerUseOverview,
  ComputerUseSettingsInfo,
  ComputerUseSettingsInput,
  ComputerUseStats,
  ComputerUseTerminalOpenInput,
  ComputerUseTerminalReadInput,
  ComputerUseTerminalReadResult,
  ComputerUseTerminalSendInput,
  ComputerUseTerminalSession,
  ComputerUseToolInfo,
  ComputerUseVmComputerCreateInput,
  ComputerUseVmHostConfigInput,
  ComputerUseVmHostCreateInput,
  ComputerUseVmHostCreateResult,
  ComputerUseVmHostDefaults,
  ComputerUseVmHostDeleteResult,
  ComputerUseVmHostInfo,
  ComputerUseVmHostsResponse,
  ComputerUseVmHostTestResult,
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

/** Ops a connector must advertise before the gateway exposes its terminal. */
const TERMINAL_CAPABILITIES: readonly string[] = ['term.open', 'term.send', 'term.read', 'term.close'];
const TERMINAL_UNSUPPORTED_MESSAGE =
  'This connector does not support terminal control (its policy/capabilities do not advertise term.*)';
const DEFAULT_CONNECTOR_NAME = 'linux-pc';
const MAX_CONNECTOR_NAME_LENGTH = 60;
const DEFAULT_ENROLLMENT_TTL_S = 3_600;
const MIN_ENROLLMENT_TTL_S = 60;
const MAX_ENROLLMENT_TTL_S = 86_400;
const DEFAULT_TERMINAL_LINES = 200;
const MAX_TERMINAL_LINES = 2_000;
const MAX_TERMINAL_WAIT_S = 30;
/** Pairing tokens are opaque but constrained so they can safely be shell-quoted. */
const ENROLLMENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Fallback pairing window when the broker does not report the token expiry. */
const HOST_INSTALL_TTL_MS = 15 * 60 * 1_000;

/** VM provider kinds accepted by the broker. */
const VM_HOST_KINDS: readonly string[] = ['libvirt', 'qemu'];
/** VM resource bounds mirror the broker's VM_RESOURCE_SPEC. */
const VM_RESOURCE_LIMITS = {
  vcpus: { min: 1, max: 16, fallback: 2 },
  memoryMb: { min: 512, max: 65_536, fallback: 2_048 },
  diskGb: { min: 10, max: 500, fallback: 30 },
} as const;
/** Broker limits: names are at most 64 chars and contain no control characters. */
const MAX_VM_HOST_NAME_LENGTH = 64;
const MAX_VM_COMPUTER_NAME_LENGTH = 64;

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

  // -------------------------------------------------------------------------
  // Connectors, pairing and terminal control (v0.10)
  // -------------------------------------------------------------------------

  async connectors(): Promise<ComputerUseConnectorsResponse> {
    const settings = this.store.get();
    const broker = await this.brokerInfo();
    const publicBrokerUrl = settings.publicBrokerUrl ?? settings.brokerUrl;
    const client = this.broker ?? this.buildBroker();
    if (client === null) {
      // Not configured is a valid state for the connectors page: show the broker
      // info + an empty list instead of failing the whole page.
      return {
        broker,
        devices: [],
        enrollments: [],
        publicBrokerUrl,
        counts: { devices: 0, online: 0, pendingEnrollments: 0 },
      };
    }

    const [devices, enrollments] = await Promise.all([client.devices(), client.enrollments()]);
    const mapped = devices.map((device) => mapDeviceInfo(device));
    return {
      broker,
      devices: mapped,
      enrollments: enrollments.map((enrollment) => ({
        id: enrollment.id,
        kind: enrollment.kind,
        expiresAt: enrollment.expiresAt,
        createdAt: enrollment.createdAt,
      })),
      publicBrokerUrl,
      counts: {
        devices: mapped.length,
        online: mapped.filter((device) => device.state === 'online').length,
        pendingEnrollments: enrollments.length,
      },
    };
  }

  async createEnrollment(
    input: ComputerUseEnrollmentInput,
    updatedBy = 'operator',
  ): Promise<ComputerUseEnrollmentResponse> {
    const kind = normalizeEnrollmentKind(input.kind);
    const computerId = input.computerId === undefined || input.computerId === null
      ? null
      : String(input.computerId).trim();
    if (kind === 'computer') {
      if (computerId === null || computerId === '') {
        throw invalidParams("'computerId' is required for a computer-kind enrollment");
      }
    } else if (computerId !== null && computerId !== '') {
      throw invalidParams("'computerId' is only valid for a computer-kind enrollment");
    }
    const name = normalizeConnectorName(input.name);
    const ttlSeconds = Math.round(
      clampNumber(input.ttlSeconds, MIN_ENROLLMENT_TTL_S, MAX_ENROLLMENT_TTL_S, DEFAULT_ENROLLMENT_TTL_S, 'ttlSeconds'),
    );
    if (input.allowTerminal !== undefined && typeof input.allowTerminal !== 'boolean') {
      throw invalidParams("'allowTerminal' must be a boolean");
    }
    const allowTerminal = input.allowTerminal === true;

    const settings = this.store.get();
    const publicBrokerUrl = settings.publicBrokerUrl ?? settings.brokerUrl;
    const publicUrl = requirePublicBrokerUrl(publicBrokerUrl);

    const broker = this.requireBroker();
    const created = await broker.createEnrollment({ kind, ttlSeconds, computerId });
    const token = typeof created.token === 'string' ? created.token.trim() : '';
    if (!ENROLLMENT_TOKEN_PATTERN.test(token)) {
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, 'Computer Broker returned an unexpected enrollment token', {
        data: { status: 'BROKER_SHAPE_ERROR', reason: 'ENROLLMENT_TOKEN_INVALID' },
        httpStatus: 502,
      });
    }

    const publicBase = publicUrl.replace(/\/+$/, '');
    const connectorUrl = `wss://${new URL(publicBase).host}/connector`;
    this.logger.info('connector enrollment created', {
      enrollmentId: created.id,
      kind,
      name,
      allowTerminal,
      updatedBy,
    });
    return {
      enrollment: {
        id: created.id,
        kind: created.kind,
        expiresAt: created.expiresAt,
        createdAt: created.createdAt,
        token,
      },
      install: {
        command: buildInstallCommand({ publicBase, connectorUrl, token, name, allowTerminal }),
        brokerUrl: publicBase,
        connectorUrl,
        caUrl: `${publicBase}/install/broker-ca.pem`,
        allowTerminal,
        expiresAt: created.expiresAt,
      },
    };
  }

  async revokeEnrollment(enrollmentId: string): Promise<void> {
    const id = typeof enrollmentId === 'string' ? enrollmentId.trim() : '';
    if (id === '') return;
    const broker = this.requireBroker();
    await broker.revokeEnrollment(id);
    this.logger.info('connector enrollment revoked', { enrollmentId: id });
  }

  async liveDesktopUrl(computerId: string): Promise<{ url: string; viaHandoff: boolean }> {
    const id = requiredId(computerId, 'computerId');
    const settings = this.store.get();
    const publicBase = (settings.publicBrokerUrl ?? settings.brokerUrl)?.replace(/\/+$/, '') ?? '';
    if (publicBase === '') {
      throw invalidParams('The public broker URL is not configured; set it in Computer use settings.');
    }
    const direct = `${publicBase}/#/d/${encodeURIComponent(id)}`;
    const broker = this.broker ?? this.buildBroker();
    if (broker === null) return { url: direct, viaHandoff: false };
    try {
      const handoff = await broker.createHandoff({ to: `/#/d/${encodeURIComponent(id)}`, ttlSeconds: 60 });
      return {
        url: `${publicBase}${handoff.path.startsWith('/') ? handoff.path : `/${handoff.path}`}`,
        viaHandoff: true,
      };
    } catch (error) {
      // Fall back to the broker's own login screen rather than failing the click.
      this.logger.warn('live desktop handoff unavailable; falling back to broker login', {
        computerId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { url: direct, viaHandoff: false };
    }
  }

  async openTerminal(input: ComputerUseTerminalOpenInput): Promise<ComputerUseTerminalSession> {
    const deviceId = requiredId(input.deviceId, 'deviceId');
    const broker = this.requireBroker();
    await this.requireTerminalCapable(broker, deviceId);

    const args: Record<string, unknown> = {};
    if (input.rows !== undefined) args.rows = positiveInteger(input.rows, 'rows');
    if (input.cols !== undefined) args.cols = positiveInteger(input.cols, 'cols');
    if (input.shell !== undefined && input.shell !== null) {
      const shell = optionalText(input.shell, 'shell');
      if (shell !== null) args.shell = shell;
    }
    if (input.cwd !== undefined && input.cwd !== null) {
      const cwd = optionalText(input.cwd, 'cwd');
      if (cwd !== null) args.cwd = cwd;
    }

    const data = await broker.deviceCall(deviceId, 'term.open', args);
    const session = isRecord(data) && typeof data.session === 'string' ? data.session.trim() : '';
    if (session === '') {
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, 'Computer Broker returned an unexpected terminal session', {
        data: { status: 'BROKER_SHAPE_ERROR', reason: 'TERMINAL_SESSION_MISSING', details: data },
        httpStatus: 502,
      });
    }
    return { deviceId, session };
  }

  async sendTerminal(input: ComputerUseTerminalSendInput): Promise<{ ok: true }> {
    const deviceId = requiredId(input.deviceId, 'deviceId');
    const session = requiredId(input.session, 'session');
    if (typeof input.input !== 'string') throw invalidParams("'input' must be a string");
    if (input.enter !== undefined && typeof input.enter !== 'boolean') {
      throw invalidParams("'enter' must be a boolean");
    }
    const broker = this.requireBroker();
    await broker.deviceCall(deviceId, 'term.send', {
      session,
      input: input.input,
      // A typed command line is normally submitted with Enter.
      enter: input.enter !== false,
    });
    return { ok: true };
  }

  async readTerminal(input: ComputerUseTerminalReadInput): Promise<ComputerUseTerminalReadResult> {
    const deviceId = requiredId(input.deviceId, 'deviceId');
    const session = requiredId(input.session, 'session');
    const lines = clampNumber(input.lines, 1, MAX_TERMINAL_LINES, DEFAULT_TERMINAL_LINES, 'lines');
    const waitSeconds = clampNumber(input.waitSeconds, 0, MAX_TERMINAL_WAIT_S, 0, 'waitSeconds');
    const broker = this.requireBroker();
    // A read may legitimately block for `wait_s`, so allow for it in the budget.
    const data = await broker.deviceCall(
      deviceId,
      'term.read',
      { session, lines: Math.round(lines), wait_s: waitSeconds },
      (waitSeconds + 10) * 1_000,
    );
    const record = isRecord(data) ? data : {};
    return {
      session,
      lines: Array.isArray(record.lines)
        ? record.lines.filter((line): line is string => typeof line === 'string')
        : [],
      changed: record.changed === true,
    };
  }

  async closeTerminal(input: { deviceId: string; session: string }): Promise<{ ok: true }> {
    const deviceId = requiredId(input.deviceId, 'deviceId');
    const session = requiredId(input.session, 'session');
    const broker = this.requireBroker();
    try {
      await broker.deviceCall(deviceId, 'term.close', { session });
    } catch (error) {
      // Closing is idempotent: an already-gone session is still "closed".
      if (error instanceof GatewayError && error.httpStatus === 404) {
        this.logger.debug('terminal session already closed', { deviceId, session });
        return { ok: true };
      }
      throw error;
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Physical host computers, stats and connector lifecycle (v0.12)
  // -------------------------------------------------------------------------

  async createHostComputer(
    input: ComputerUseHostComputerInput,
    updatedBy = 'operator',
  ): Promise<ComputerUseHostComputer> {
    const name = normalizeConnectorName(input?.name);
    const settings = this.store.get();
    const base = this.installBaseUrl(settings);
    const broker = this.requireBroker();
    const created = await broker.createHostComputer(name);
    const token = typeof created.token === 'string' ? created.token.trim() : '';
    if (!ENROLLMENT_TOKEN_PATTERN.test(token)) {
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, 'Computer Broker returned an unexpected host enrolment token', {
        data: { status: 'BROKER_SHAPE_ERROR', reason: 'ENROLLMENT_TOKEN_INVALID' },
        httpStatus: 502,
      });
    }
    const connectorUrl = `wss://${new URL(base).host}/connector`;
    const expiresAt = created.expiresAt ?? new Date(Date.now() + HOST_INSTALL_TTL_MS).toISOString();
    this.invalidateCaches();
    this.logger.info('host computer created', { computerId: created.computer.id, name, updatedBy });
    return {
      computer: this.mapComputer(settings, created.computer),
      install: {
        command: buildHostInstallCommand({ publicBase: base, connectorUrl, token, name }),
        brokerUrl: base,
        connectorUrl,
        caUrl: `${base}/install/broker-ca.pem`,
        expiresAt,
      },
    };
  }

  async computerStats(computerId: string): Promise<ComputerUseStats> {
    const id = requiredId(computerId, 'computerId');
    return this.requireBroker().computerStats(id);
  }

  async updateConnector(computerId: string, updatedBy = 'operator'): Promise<ComputerUseConnectorUpdateResult> {
    const id = requiredId(computerId, 'computerId');
    const broker = this.requireBroker();
    // The broker holds this request until the connector reports back (up to 240 s).
    const result = await broker.updateConnector(id);
    this.invalidateCaches();
    this.logger.info('host connector update finished', {
      computerId: id,
      ok: result.ok,
      version: result.version,
      connectorVersion: result.connectorVersion,
      updatedBy,
    });
    return {
      ok: result.ok,
      version: result.version,
      connectorVersion: result.connectorVersion,
      result: result.result,
    };
  }

  async removeConnector(
    computerId: string,
    input: ComputerUseConnectorRemoveInput,
    updatedBy = 'operator',
  ): Promise<ComputerUseConnectorRemoveResult> {
    const id = requiredId(computerId, 'computerId');
    if (input?.removeComputer !== undefined && typeof input.removeComputer !== 'boolean') {
      throw invalidParams("'removeComputer' must be a boolean");
    }
    const removeComputer = input?.removeComputer === true;
    const broker = this.requireBroker();
    const result = await broker.removeConnector(id, { uninstall: true, removeComputer });
    this.invalidateCaches();
    this.logger.info('host connector removed', {
      computerId: id,
      connectorRemoved: result.connectorRemoved,
      computerRemoved: result.computerRemoved,
      updatedBy,
    });
    return {
      ok: result.ok,
      connectorRemoved: result.connectorRemoved,
      computerRemoved: result.computerRemoved,
    };
  }

  // -------------------------------------------------------------------------
  // VM providers and VM deployment (v0.13.1)
  // -------------------------------------------------------------------------

  async listVmHosts(): Promise<ComputerUseVmHostsResponse> {
    const broker = this.requireBroker();
    const hosts = await broker.listVmHosts();
    return { vmHosts: hosts.map((host) => mapVmHostInfo(host)) };
  }

  async createVmHost(
    input: ComputerUseVmHostCreateInput,
    updatedBy = 'operator',
  ): Promise<ComputerUseVmHostCreateResult> {
    const name = requireVmName(input?.name, 'name', MAX_VM_HOST_NAME_LENGTH);
    const kind = requireVmHostKind(input?.kind);
    const config = validateVmHostConfig(kind, input?.config);
    const broker = this.requireBroker();
    // The broker bootstraps the base image and runs the backend test (up to 300 s).
    const created = await broker.createVmHost({ name, kind, config });
    this.logger.info('vm host created', {
      vmHostId: created.vmHost.id,
      name,
      kind,
      updatedBy,
    });
    return { vmHost: mapVmHostInfo(created.vmHost), test: created.test };
  }

  async testVmHost(vmHostId: string, updatedBy = 'operator'): Promise<ComputerUseVmHostTestResult> {
    const id = requiredId(vmHostId, 'vmHostId');
    const broker = this.requireBroker();
    const result = await broker.testVmHost(id);
    this.logger.info('vm host tested', {
      vmHostId: id,
      ok: result.ok,
      state: result.vmHost.state,
      updatedBy,
    });
    return {
      ok: result.ok,
      vmHost: mapVmHostInfo(result.vmHost),
      details: result.details,
    };
  }

  async deleteVmHost(vmHostId: string, updatedBy = 'operator'): Promise<ComputerUseVmHostDeleteResult> {
    const id = requiredId(vmHostId, 'vmHostId');
    const broker = this.requireBroker();
    const result = await broker.deleteVmHost(id);
    this.logger.info('vm host deleted', { vmHostId: result.deleted, updatedBy });
    return { ok: result.ok, deleted: result.deleted };
  }

  async createVmComputer(
    input: ComputerUseVmComputerCreateInput,
    updatedBy = 'operator',
  ): Promise<ComputerUseComputerInfo> {
    const vmHostId = requiredId(input?.vmHostId, 'vmHostId');
    const name =
      input?.name === undefined || input?.name === null || String(input.name).trim() === ''
        ? null
        : requireVmName(input.name, 'name', MAX_VM_COMPUTER_NAME_LENGTH);
    const vcpus = optionalVmResource(input?.vcpus, 'vcpus');
    const memoryMb = optionalVmResource(input?.memoryMb, 'memoryMb');
    const diskGb = optionalVmResource(input?.diskGb, 'diskGb');
    const broker = this.requireBroker();
    // Copying the base image and booting the domain can take minutes.
    const computer = await broker.createVmComputer({ vmHostId, name, vcpus, memoryMb, diskGb });
    this.invalidateCaches();
    this.logger.info('vm computer created', {
      computerId: computer.id,
      vmHostId,
      name,
      vcpus,
      memoryMb,
      diskGb,
      updatedBy,
    });
    return this.mapComputer(this.store.get(), computer);
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
      approvalRequiredTools: this.approvalRequiredTools(),
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

  /** Approval gate from config; the managed row is rebuilt from this every sync. */
  private approvalRequiredTools(): string[] {
    return this.options.config.computerUse?.approvalRequiredTools ?? [...APPROVAL_REQUIRED_TOOLS];
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

  /**
   * Base URL advertised to a new host. Prefers MCP_COMPUTER_INSTALL_BASE_URL
   * (the address this gateway/broker will be reachable at), then the console's
   * public broker URL.
   */
  private installBaseUrl(settings: StoredComputerUseSettings): string {
    const configured = this.options.config.computerUse?.installBaseUrl ?? null;
    return requireInstallBaseUrl(configured ?? settings.publicBrokerUrl ?? settings.brokerUrl);
  }

  /** Terminal operations need a live connector that advertises the `term.*` policy. */
  private async requireTerminalCapable(broker: ComputerUseBrokerPort, deviceId: string): Promise<void> {
    const devices = await broker.devices();
    const device = devices.find((candidate) => candidate.id === deviceId);
    if (device === undefined) {
      throw new GatewayError(ErrorCodes.INVALID_PARAMS, `Unknown connector '${deviceId}'`, {
        data: { status: 'NOT_FOUND', reason: 'CONNECTOR_NOT_FOUND', details: { device_id: deviceId } },
        httpStatus: 404,
      });
    }
    if (!isTerminalCapable(device.capabilities)) {
      throw new GatewayError(ErrorCodes.INVALID_PARAMS, TERMINAL_UNSUPPORTED_MESSAGE, {
        data: {
          status: 'CONNECTOR_TERMINAL_UNSUPPORTED',
          reason: 'TERMINAL_UNSUPPORTED',
          details: { device_id: deviceId, capabilities: device.capabilities },
        },
        httpStatus: 409,
      });
    }
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
      resources: computer.resources,
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
// Helpers — v0.10 connectors, pairing and terminal
// ---------------------------------------------------------------------------

function mapDeviceInfo(device: BrokerDeviceSnapshot): ComputerUseDeviceInfo {
  return {
    id: device.id,
    name: device.name,
    state: device.state,
    location: device.location,
    tags: device.tags,
    capabilities: device.capabilities,
    meta: device.meta,
    lastSeen: device.lastSeen,
    terminalCapable: isTerminalCapable(device.capabilities),
  };
}

function isTerminalCapable(capabilities: readonly string[]): boolean {
  // Either every term.* op is advertised, or the connector advertises the
  // entry-point `term.open` only and the broker enforces the rest.
  if (capabilities.includes('term.open')) return true;
  return TERMINAL_CAPABILITIES.every((capability) => capabilities.includes(capability));
}

function normalizeEnrollmentKind(value: ComputerUseEnrollmentKind | undefined): ComputerUseEnrollmentKind {
  if (value === undefined || value === null) return 'device';
  if (value === 'device' || value === 'computer') return value;
  throw invalidParams("'kind' must be 'device' or 'computer'");
}

function normalizeConnectorName(value: string | null | undefined): string {
  if (value === undefined || value === null) return DEFAULT_CONNECTOR_NAME;
  if (typeof value !== 'string') throw invalidParams("'name' must be a string or null");
  // Strip control characters (the name is embedded in a shell command and in
  // the broker's registry) and collapse whitespace.
  const cleaned = stripControlCharacters(value).replace(/\s+/g, ' ').trim();
  if (cleaned === '') return DEFAULT_CONNECTOR_NAME;
  return cleaned.slice(0, MAX_CONNECTOR_NAME_LENGTH).trim();
}

function stripControlCharacters(value: string): string {
  let cleaned = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    cleaned += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  return cleaned;
}

function requirePublicBrokerUrl(value: string | null): string {
  const message =
    'A public broker URL is required to pair a connector. Set the public broker URL in Computer-use settings.';
  if (value === null || value === '') throw invalidParams(message);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidParams(message);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw invalidParams(message);
  return value.replace(/\/+$/, '');
}

function buildInstallCommand(input: {
  publicBase: string;
  connectorUrl: string;
  token: string;
  name: string;
  allowTerminal: boolean;
}): string {
  const installUrl = `${input.publicBase}/install/install-connector.sh`;
  const parts = [
    `curl -fsSLk ${shellQuote(installUrl)}`,
    '| bash -s --',
    `--broker ${shellQuote(input.connectorUrl)}`,
    `--enroll ${shellQuote(input.token)}`,
    `--name ${shellQuote(input.name)}`,
  ];
  if (input.allowTerminal) parts.push('--terminal');
  return parts.join(' ');
}

/** POSIX single-quote a value: `'` becomes `'\''`. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Resolve and validate the base URL a new host's installer must reach. */
function requireInstallBaseUrl(value: string | null): string {
  const message =
    'A public install base URL is required to create a host computer. Set MCP_COMPUTER_INSTALL_BASE_URL ' +
    '(or the public broker URL in Computer-use settings) to the address the new PC can reach.';
  if (value === null || value === '') throw invalidParams(message);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidParams(message);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw invalidParams(message);
  return value.replace(/\/+$/, '');
}

/**
 * One-line installer for a physical host:
 *   curl … | bash -s -- --broker 'wss://…/connector' --enroll '<token>'
 *     --kind computer --backend wayland --name '<name>'
 */
function buildHostInstallCommand(input: {
  publicBase: string;
  connectorUrl: string;
  token: string;
  name: string;
}): string {
  return [
    `curl -fsSLk ${shellQuote(`${input.publicBase}/install/install-connector.sh`)}`,
    '| bash -s --',
    `--broker ${shellQuote(input.connectorUrl)}`,
    `--enroll ${shellQuote(input.token)}`,
    '--kind computer',
    '--backend wayland',
    `--name ${shellQuote(input.name)}`,
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Helpers — v0.13.1 VM providers
// ---------------------------------------------------------------------------

function mapVmHostInfo(host: BrokerVmHostSnapshot): ComputerUseVmHostInfo {
  return {
    id: host.id,
    name: host.name,
    kind: host.kind,
    config: host.config,
    defaults: host.defaults,
    template: host.template,
    baseReady: host.baseReady,
    state: host.state,
    lastError: host.lastError,
    createdAt: host.createdAt,
  };
}

function requireVmName(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw invalidParams(`'${field}' is required`);
  const cleaned = stripControlCharacters(value).replace(/\s+/g, ' ').trim();
  if (cleaned === '') throw invalidParams(`'${field}' is required`);
  if (cleaned.length > maxLength) {
    throw invalidParams(`'${field}' must be at most ${maxLength} characters`);
  }
  return cleaned;
}

function requireVmHostKind(value: unknown): 'libvirt' | 'qemu' {
  const kind = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!VM_HOST_KINDS.includes(kind)) throw invalidParams("'kind' must be 'libvirt' or 'qemu'");
  return kind === 'qemu' ? 'qemu' : 'libvirt';
}

/** Validate/normalise the operator-provided provider config before it reaches the broker. */
function validateVmHostConfig(kind: 'libvirt' | 'qemu', raw: unknown): ComputerUseVmHostConfigInput {
  if (!isRecord(raw)) throw invalidParams("'config' must be an object");
  const baseImage = requireVmConfigString(raw.baseImage, 'config.baseImage');
  const storageDir = requireVmConfigString(raw.storageDir, 'config.storageDir');
  const input: ComputerUseVmHostConfigInput = { baseImage, storageDir };

  const sshHost = optionalVmConfigString(raw.sshHost, 'config.sshHost');
  const sshUser = optionalVmConfigString(raw.sshUser, 'config.sshUser');
  if (kind === 'libvirt') {
    if (sshHost === null) throw invalidParams("'config.sshHost' is required for a libvirt VM host");
    if (/\s/.test(sshHost)) throw invalidParams("'config.sshHost' must not contain whitespace");
    input.sshHost = sshHost;
  } else {
    if (sshHost !== null) throw invalidParams("'config.sshHost' is only valid for a libvirt VM host");
    if (sshUser !== null) throw invalidParams("'config.sshUser' is only valid for a libvirt VM host");
  }
  if (sshUser !== null) {
    if (/\s/.test(sshUser)) throw invalidParams("'config.sshUser' must not contain whitespace");
    input.sshUser = sshUser;
  }

  const network = optionalVmConfigString(raw.network, 'config.network');
  if (network !== null) input.network = network;
  const cloudImageUrl = optionalVmConfigString(raw.cloudImageUrl, 'config.cloudImageUrl');
  if (cloudImageUrl !== null) input.cloudImageUrl = cloudImageUrl;
  if (raw.installBrowser !== undefined && raw.installBrowser !== null) {
    if (typeof raw.installBrowser !== 'boolean') throw invalidParams("'config.installBrowser' must be a boolean");
    input.installBrowser = raw.installBrowser;
  }
  if (raw.defaults !== undefined && raw.defaults !== null) {
    if (!isRecord(raw.defaults)) throw invalidParams("'config.defaults' must be an object");
    const defaults: Partial<ComputerUseVmHostDefaults> = {};
    if (raw.defaults.vcpus !== undefined) defaults.vcpus = clampVmResource(raw.defaults.vcpus, 'vcpus');
    if (raw.defaults.memoryMb !== undefined) defaults.memoryMb = clampVmResource(raw.defaults.memoryMb, 'memoryMb');
    if (raw.defaults.diskGb !== undefined) defaults.diskGb = clampVmResource(raw.defaults.diskGb, 'diskGb');
    if (Object.keys(defaults).length > 0) input.defaults = defaults;
  }
  return input;
}

function requireVmConfigString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalidParams(`'${field}' is required`);
  return value.trim();
}

function optionalVmConfigString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidParams(`'${field}' must be a string`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Clamp one VM resource to the broker's bounds (used for provider defaults). */
function clampVmResource(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidParams(`'${field}' must be a number`);
  const limits = VM_RESOURCE_LIMITS[field as keyof typeof VM_RESOURCE_LIMITS];
  return Math.min(limits.max, Math.max(limits.min, Math.round(value)));
}

/** Optional per-VM override; omitted means "use the provider defaults". */
function optionalVmResource(value: unknown, field: 'vcpus' | 'memoryMb' | 'diskGb'): number | undefined {
  if (value === undefined || value === null) return undefined;
  return clampVmResource(value, field);
}

function requiredId(value: string, field: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '') throw invalidParams(`'${field}' is required`);
  return trimmed;
}

function positiveInteger(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidParams(`'${field}' must be a number`);
  const rounded = Math.round(value);
  if (rounded < 1) throw invalidParams(`'${field}' must be at least 1`);
  return rounded;
}

function optionalText(value: string, field: string): string | null {
  if (typeof value !== 'string') throw invalidParams(`'${field}' must be a string or null`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function clampNumber(
  value: number | undefined | null,
  min: number,
  max: number,
  fallback: number,
  field: string,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidParams(`'${field}' must be a number`);
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Helpers — v0.9 availability and settings
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
