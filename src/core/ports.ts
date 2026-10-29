/**
 * Cross-module service ports.
 *
 * These interfaces are the ONLY coupling between workstreams:
 *   Lead        → gateway/ingress/supervisor/admin
 *   rbac-catalog→ rbac/* + catalog/*
 *   vault-git   → vault/* + git_engine/*
 *   delegation  → delegation/*
 *   ui          → src/ui/*
 *
 * Implementations are wired together in `src/container.ts`. Modules must not
 * import each other's concrete classes; inject these interfaces instead.
 */
import type {
  ApiKeyRecord,
  BackupEnvelope,
  BackupMetadata,
  CredentialItem,
  CredentialItemQuery,
  CredentialProviderDescriptor,
  CredentialProviderId,
  CredentialProviderStatus,
  CredentialRef,
  CredentialRevealResult,
  AuthenticatedKey,
  AuditEntry,
  AuditStatus,
  AuthorizationDecision,
  CatalogEntry,
  CatalogInstallResult,
  CatalogSource,
  CatalogSourceKind,
  ConfigProfileApplyResult,
  ConfigProfileInput,
  ConfigProfileSummary,
  ComputerUseAvailabilityInput,
  ComputerUseComputerInfo,
  ComputerUseComputersResponse,
  ComputerUseOverview,
  ComputerUseSettingsInput,
  CreateKeyInput,
  GatewaySettingsInfo,
  DelegationResult,
  DelegationTarget,
  EscalationStatus,
  EscalationTicket,
  HarnessImportInput,
  HarnessScanResult,
  HarnessSourceInfo,
  IssuedKey,
  KeyAccessView,
  KeyActivityFilter,
  KeyActivityPage,
  JsonSchema,
  PermittedServerSummary,
  PolicyDenialReason,
  PromptDescriptor,
  ResourceDescriptor,
  ServerRecord,
  RestoreResult,
  ServerSourceInfo,
  ServerStatus,
  ServerUpdateResult,
  UpdateCheckResult,
  ToolDescriptor,
  ToolGuardrail,
  ToolSearchResult,
  UpdateKeyInput,
  VaultSecretMetadata,
} from './types.js';

// ---------------------------------------------------------------------------
// RBAC: key custody + policy decision point
// ---------------------------------------------------------------------------

export interface KeyService {
  /** Hash + look up a presented key. Throws GatewayError(-32005) when invalid. */
  authenticate(plaintextKey: string): AuthenticatedKey;
  issue(input: CreateKeyInput): IssuedKey;
  /** Register a caller-supplied plaintext key (bootstrap master key from env). */
  importKey(plaintext: string, input: CreateKeyInput): ApiKeyRecord;
  get(id: string): ApiKeyRecord | null;
  list(): ApiKeyRecord[];
  revoke(id: string): ApiKeyRecord;
  /** Rename, pause/resume or replace grants for a key. */
  update(id: string, input: UpdateKeyInput): ApiKeyRecord;
  /** Pause authentication for a key (keeps grants intact). */
  pause(id: string): ApiKeyRecord;
  /** Resume a paused key. */
  resume(id: string): ApiKeyRecord;
  /** Removes expired keys; returns count. */
  purgeExpired(now?: Date): number;
}

export interface PolicyEngine {
  /** Server-level grant check (zero-trust visibility). */
  isServerPermitted(key: AuthenticatedKey, serverId: string): boolean;
  /** True when the key's grant for this server is temporarily paused. */
  isServerPaused(key: AuthenticatedKey, serverId: string): boolean;
  /** Tool visibility: server grant + whitelist + high-privilege masking. */
  isToolPermitted(key: AuthenticatedKey, tool: ToolDescriptor): boolean;
  /** Full call check: visibility + argument guardrails. */
  evaluateCall(
    key: AuthenticatedKey,
    tool: ToolDescriptor,
    args: Record<string, unknown>,
  ): AuthorizationDecision;
  canDelegate(key: AuthenticatedKey): boolean;
  canEscalate(key: AuthenticatedKey): boolean;
  guardrailsFor(key: AuthenticatedKey, tool: ToolDescriptor): ToolGuardrail[];
}

export interface EscalationService {
  create(input: {
    key: AuthenticatedKey;
    toolId: string | null;
    serverId: string | null;
    reason: PolicyDenialReason;
    requestPayload: unknown;
  }): EscalationTicket;
  get(ticketId: string): EscalationTicket | null;
  list(status?: EscalationStatus): EscalationTicket[];
  resolve(
    ticketId: string,
    status: Exclude<EscalationStatus, 'pending'>,
    resolvedBy: string,
    note?: string | null,
  ): EscalationTicket;
}

// ---------------------------------------------------------------------------
// Catalog: servers, tools, zero-trust discovery
// ---------------------------------------------------------------------------

export interface CatalogRepository {
  upsertServer(server: ServerRecord): void;
  getServer(id: string): ServerRecord | null;
  getServerByName(name: string): ServerRecord | null;
  listServers(): ServerRecord[];
  deleteServer(id: string): void;
  setServerStatus(id: string, status: ServerStatus, patch?: Partial<ServerRecord>): void;
  upsertTools(serverId: string, tools: ToolDescriptor[]): void;
  deleteTools(serverId: string): void;
  getTool(id: string): ToolDescriptor | null;
  getToolByName(serverId: string, name: string): ToolDescriptor | null;
  listTools(): ToolDescriptor[];
  listToolsByServer(serverId: string): ToolDescriptor[];
  /** Persist MCP discovery extras (capabilities/instructions/prompts/resources). */
  updateDiscovery(
    serverId: string,
    patch: {
      capabilities?: Record<string, unknown>;
      instructions?: string | null;
      prompts?: PromptDescriptor[];
      resources?: ResourceDescriptor[];
    },
  ): void;
}

export interface CatalogService {
  readonly repository: CatalogRepository;
  /** CENSORED ranked search over tools the key may see. */
  searchTools(key: AuthenticatedKey, query: string, limit: number): ToolSearchResult;
  /** MASKED tool listing; only schemas of permitted tools. */
  listTools(
    key: AuthenticatedKey,
    options?: { serverId?: string },
  ): { tools: Array<{ id: string; name: string; description: string; server_id: string; inputSchema: JsonSchema }>; total: number };
  /** ZERO-TRUST server menu. */
  listPermittedServers(key: AuthenticatedKey): PermittedServerSummary[];
  /** Returns the tool only when the key may see it, else null (anti-probing). */
  getVisibleTool(key: AuthenticatedKey, toolId: string): ToolDescriptor | null;
  upsertServerFromDiscovery(server: ServerRecord, tools: ToolDescriptor[]): void;
}

// ---------------------------------------------------------------------------
// MCP transport + supervisor
// ---------------------------------------------------------------------------

export interface RawToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface McpInitializeResult {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
  instructions?: string | null;
}

export interface RawPromptDefinition {
  name: string;
  description: string;
  arguments: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface RawResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string | null;
}

export interface RawResourceTemplateDefinition {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string | null;
}

export interface McpCallResult {
  content: unknown[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface McpClient {
  readonly serverId: string;
  initialize(): Promise<McpInitializeResult>;
  listTools(): Promise<RawToolDefinition[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number; meta?: Record<string, unknown> },
  ): Promise<McpCallResult>;
  /** Optional MCP capability discovery/proxying (not all servers support them). */
  listPrompts?(): Promise<RawPromptDefinition[]>;
  getPrompt?(name: string, args: Record<string, unknown>): Promise<unknown>;
  listResources?(): Promise<RawResourceDefinition[]>;
  listResourceTemplates?(): Promise<RawResourceTemplateDefinition[]>;
  readResource?(uri: string): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): Promise<void>;
}

export interface SubServerLogLine {
  ts: string;
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
}

export interface Supervisor {
  start(serverId: string): Promise<ServerRecord>;
  stop(serverId: string): Promise<void>;
  restart(serverId: string): Promise<ServerRecord>;
  status(serverId: string): ServerStatus;
  client(serverId: string): McpClient | null;
  logs(serverId: string, limit?: number): SubServerLogLine[];
  subscribeLogs(serverId: string | null, listener: (line: SubServerLogLine & { serverId: string }) => void): () => void;
  list(): ServerRecord[];
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Delegation / observer pattern
// ---------------------------------------------------------------------------

export interface DelegationService {
  listTargets(): DelegationTarget[];
  addTarget(target: DelegationTarget): DelegationTarget;
  delegate(
    key: AuthenticatedKey,
    input: { targetId: string; payload: unknown; mode?: 'delegate' | 'observe_and_verify' },
    context: { depth: number; parentRequestId: string },
  ): Promise<DelegationResult>;
  listTraces(limit?: number): DelegationTrace[];
}

export interface DelegationTrace {
  id: string;
  traceId: string;
  parentRequestId: string | null;
  childRequestId: string | null;
  target: string;
  depth: number;
  status: 'approved' | 'denied' | 'error';
  verdict: string | null;
  latencyMs: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export interface VaultService {
  /** False when MCP_VAULT_SECRET is not configured. */
  isEnabled(): boolean;
  setSecret(name: string, value: string): VaultSecretMetadata;
  getSecret(name: string): string | null;
  listSecrets(): VaultSecretMetadata[];
  deleteSecret(name: string): boolean;
  /** Resolve named secrets to env values for a sub-server. Missing names throw. */
  resolveSecrets(names: string[]): Record<string, string>;
}

// ---------------------------------------------------------------------------
// Git import engine
// ---------------------------------------------------------------------------

export interface GitImportInput {
  url: string;
  name?: string;
  startAfterBuild?: boolean;
  /** Override auto-detected build/start commands (manifest normally supplies them). */
  buildCommand?: string;
  startCommand?: string;
  /** Git ref (branch/tag) to check out; defaults to the remote default branch. */
  ref?: string | null;
  /** Sub-directory inside a monorepo that contains the manifest/package.json. */
  subpath?: string | null;
  /** Plaintext clone token for private repositories (never logged/persisted). */
  token?: string | null;
  /** Environment supplied by the catalog/import UI (merged into the build env). */
  env?: Record<string, string>;
}

export interface GitImportService {
  importRepository(input: GitImportInput): Promise<ServerRecord>;
}

// ---------------------------------------------------------------------------
// Audit & metrics
// ---------------------------------------------------------------------------

export interface AuditQuery {
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

export interface AuditService {
  record(entry: {
    requestId: string | null;
    keyId: string | null;
    method: string;
    serverId?: string | null;
    toolId?: string | null;
    status: AuditStatus;
    latencyMs: number;
    errorCode?: number | null;
    delegationDepth?: number;
    parentId?: number | null;
    payload?: unknown;
  }): number;
  query(filter?: AuditQuery): { entries: AuditEntry[]; total: number };
  get(id: number): AuditEntry | null;
  /** Live telemetry used by the dashboard. */
  metrics(windowMs?: number): MetricsSnapshot;
}

export interface MetricsSnapshot {
  uptimeMs: number;
  requests: { total: number; ok: number; denied: number; error: number };
  requestsPerMinute: number;
  errorRate: number;
  latencyMs: { p50: number; p95: number; p99: number };
  servers: { running: number; total: number };
  process: { cpuPercent: number; rssBytes: number; heapUsedBytes: number };
  delegations: { total: number; approved: number; denied: number };
}


// Backwards-compatible re-export (canonical definition lives in types.ts).
export type { VaultSecretMetadata } from './types.js';


// ---------------------------------------------------------------------------
// v0.2 — plugin catalog, harness discovery and tool approval gating
// ---------------------------------------------------------------------------

export interface CatalogSourceInput {
  label: string;
  kind: CatalogSourceKind;
  repoUrl: string;
  ref?: string | null;
  subpath?: string | null;
  /** Plaintext token; when supplied it is written to the AES-256 vault. */
  token?: string | null;
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

export interface PluginCatalogService {
  listSources(): CatalogSource[];
  addSource(input: CatalogSourceInput): Promise<CatalogSource>;
  removeSource(id: string): void;
  listEntries(sourceId: string): Promise<CatalogEntry[]>;
  install(input: CatalogInstallRequest): Promise<CatalogInstallResult>;
  importUrl(input: CatalogImportUrlRequest): Promise<CatalogInstallResult>;
}

export interface HarnessDiscoveryService {
  listSources(): HarnessSourceInfo[];
  scan(harnessIds?: string[]): Promise<HarnessScanResult>;
  importEntry(input: HarnessImportInput): Promise<ServerRecord>;
}

export type ApprovalTicketState = 'pending' | 'approved' | 'consumed' | 'denied' | 'expired' | 'invalid';

export interface ApprovalResult {
  state: ApprovalTicketState;
  ticket: EscalationTicket | null;
  /** Stored execution result (CallToolResult); never a raw secret value. */
  result: unknown;
}

/**
 * Approval gating for dangerous tools (e.g. Vaultwarden credential delivery).
 * The gateway creates a ticket, a supervisor approves it in the UI (which
 * executes once and stores the result), and the agent then retries with the
 * ticket to collect the stored result.
 */
export interface ApprovalService {
  requiresApproval(serverId: string, toolName: string): boolean;
  createToolApproval(input: {
    key: AuthenticatedKey;
    serverId: string;
    toolId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    requestId: string;
  }): EscalationTicket;
  /** Atomically mark a ticket consumed and return its stored result. */
  takeResult(ticketId: string, keyId: string, toolId: string): ApprovalResult;
  approveAndExecute(ticketId: string, resolvedBy: string, note?: string | null): Promise<{ ticket: EscalationTicket; result: unknown }>;
  deny(ticketId: string, resolvedBy: string, note?: string | null): EscalationTicket;
}


// ---------------------------------------------------------------------------
// v0.3 — built-in Web UI username/password sessions
// ---------------------------------------------------------------------------

export interface UiUser {
  username: string;
}

export interface UiSession {
  token: string;
  user: UiUser;
  expiresAt: string;
}

/** Session-auth principal used by admin/JSON-RPC when the browser is logged in. */
export interface UiPrincipal extends UiUser {
  via: 'session';
}

export interface UiAuthService {
  /** Creates the configured bootstrap user when the table is empty and a password was configured. */
  ensureBootstrapUser(): void;
  /** True when no Web UI user exists yet (first-run setup required). */
  hasUsers(): boolean;
  /** Create the FIRST user (only when none exists) and return a session. */
  setup(username: string, password: string): UiSession;
  /** Verify an existing user's password (used to derive backup keys). */
  verifyUserPassword(username: string, password: string): boolean;
  /** Verify credentials and create a session. Throws on invalid credentials. */
  login(username: string, password: string): UiSession;
  /** Resolve a raw session token to a user (sliding expiry); null when invalid. */
  authenticate(token: string | null | undefined): UiUser | null;
  logout(token: string | null | undefined): void;
  changePassword(username: string, currentPassword: string, newPassword: string): void;
  /** Number of active (non-revoked, unexpired) sessions for a user. */
  activeSessions(username: string): number;
}


// ---------------------------------------------------------------------------
// v0.4 — server update tracking & reusable configuration profiles
// ---------------------------------------------------------------------------

export interface ServerSourceRecordInput {
  serverId: string;
  sourceKind?: 'catalog' | 'git' | 'local';
  catalogSourceId?: string | null;
  catalogEntryId?: string | null;
  repoUrl: string;
  requestedRef?: string | null;
  installedCommit?: string | null;
  installedVersion?: string | null;
  changelogUrl?: string | null;
}

export interface ServerUpdateService {
  /** Every server that has a tracked upstream repository. */
  listSources(): ServerSourceInfo[];
  get(serverId: string): ServerSourceInfo | null;
  /** Re-read the upstream ref/commit and persist the update state. */
  check(serverId: string): Promise<UpdateCheckResult>;
  checkAll(): Promise<UpdateCheckResult[]>;
  /** Rebuild this one server from its upstream and restart/test it. */
  update(
    serverId: string,
    options?: { ref?: string | null; restart?: boolean; test?: boolean },
  ): Promise<ServerUpdateResult>;
  /** Persist source metadata after an install/import. */
  recordSource(input: ServerSourceRecordInput): void;
}

export interface ConfigProfileResolver {
  /** Merge attached profile env/headers (resolving encrypted vault values) for a server. */
  resolveForServer(serverId: string): {
    env: Record<string, string>;
    headers: Record<string, string>;
    /** External password-manager references resolved at process start. */
    credentialRefs: CredentialRef[];
  };
  profileIdsForServer(serverId: string): string[];
}

export interface ConfigProfileService extends ConfigProfileResolver {
  list(): ConfigProfileSummary[];
  get(id: string): ConfigProfileSummary | null;
  create(input: ConfigProfileInput): Promise<ConfigProfileSummary>;
  update(id: string, input: ConfigProfileInput): Promise<ConfigProfileSummary>;
  remove(id: string): void;
  /** Attach profiles to servers (union), optionally restart + probe. */
  apply(
    profileIds: string[],
    serverIds: string[],
    options?: { restart?: boolean; test?: boolean },
  ): Promise<ConfigProfileApplyResult[]>;
  /** Remove a profile from one server. */
  detach(profileId: string, serverId: string): void;
  /**
   * Migrate a legacy server env file into an encrypted profile attached to that
   * server, then clear the envFile path. Values never touch SQLite in plaintext.
   */
  migrateEnvFile(serverId: string, name?: string): Promise<ConfigProfileSummary>;
}


// ---------------------------------------------------------------------------
// v0.6 — password-encrypted backups
// ---------------------------------------------------------------------------

export interface BackupCreateOptions {
  /** Login password of the requesting operator; derives the backup key. */
  password: string;
  includeAudit?: boolean;
}

export interface BackupService {
  create(options: BackupCreateOptions): BackupMetadata;
  list(): BackupMetadata[];
  read(id: string): { metadata: BackupMetadata; envelope: BackupEnvelope };
  remove(id: string): void;
  /** Decrypt and apply a backup. `confirm` must equal "RESTORE". */
  restore(input: { envelope: BackupEnvelope; password: string; confirm: string }): RestoreResult;
  /** First-run restore: allowed only when no UI users exist. */
  restoreFirstRun(input: { envelope: BackupEnvelope; password: string }): RestoreResult;
}

export interface GatewaySettingsService {
  info(): GatewaySettingsInfo;
}


// ---------------------------------------------------------------------------
// v0.7 — credential provider service
// ---------------------------------------------------------------------------

export interface CredentialProviderService {
  descriptors(): CredentialProviderDescriptor[];
  listProviders(): Promise<CredentialProviderStatus[]>;
  getProvider(id: CredentialProviderId): Promise<CredentialProviderStatus>;
  /** Store provider configuration (secret values encrypted in the gateway vault). */
  configure(id: CredentialProviderId, values: Record<string, string>): Promise<CredentialProviderStatus>;
  /** Clear provider configuration. */
  clear(id: CredentialProviderId): Promise<CredentialProviderStatus>;
  test(id: CredentialProviderId): Promise<CredentialProviderStatus>;
  defaultProvider(): Promise<CredentialProviderId>;
  setDefault(id: CredentialProviderId): Promise<void>;
  listItems(id: CredentialProviderId, query?: CredentialItemQuery): Promise<CredentialItem[]>;
  reveal(id: CredentialProviderId, itemId: string, field?: string | null): Promise<CredentialRevealResult>;
  /** Resolve many references at process start (used by configuration profiles). */
  resolveRefs(refs: CredentialRef[]): Promise<Record<string, string>>;
  /** Materialise provider configuration into sub-server files at boot (Vaultwarden mcp.env). */
  initialize(): Promise<void>;
}


// ---------------------------------------------------------------------------
// v0.8 — per-key access view + activity
// ---------------------------------------------------------------------------

export interface KeyActivityService {
  /** Granted servers/tools with paused/available flags for the RBAC editor. */
  access(keyId: string): KeyAccessView;
  /** Audit activity and usage stats for one key. */
  activity(keyId: string, filter?: KeyActivityFilter): KeyActivityPage;
}


// ---------------------------------------------------------------------------
// v0.9 — computer use (Computer Broker integration)
// ---------------------------------------------------------------------------

export interface ComputerUseBrokerHealth {
  ok: boolean;
  version: string | null;
  computers: number | null;
  devices: number | null;
  connectorsOnline: number | null;
  tls: boolean;
}

/** One broker computer, normalised from the broker's loose JSON snapshot. */
export interface BrokerComputerSnapshot {
  id: string;
  name: string;
  template: string;
  provider: string;
  state: string;
  viewer: string;
  error: string | null;
  createdAt: string | null;
  ttlAt: string | null;
  desktop: { viewer: string; width: number | null; height: number | null };
  connector: { state: string; version: string | null; lastSeen: string | null } | null;
  control: { held: boolean; holder: string | null; heldSince: string | null; expiresAt: string | null };
}

export interface ComputerUseFrameResult {
  data: Buffer;
  contentType: string;
  frameTime: string | null;
}

/**
 * Server-side client for one Computer Broker. Only the broker's documented
 * HTTP surface is used; the token never leaves the gateway process.
 */
export interface ComputerUseBrokerPort {
  readonly baseUrl: string;
  health(): Promise<ComputerUseBrokerHealth>;
  listComputers(): Promise<BrokerComputerSnapshot[]>;
  getComputer(computerId: string): Promise<BrokerComputerSnapshot>;
  startComputer(computerId: string): Promise<BrokerComputerSnapshot>;
  stopComputer(computerId: string): Promise<BrokerComputerSnapshot>;
  frame(computerId: string, maxWidth: number): Promise<ComputerUseFrameResult>;
  /** JSON-RPC request against the broker's MCP endpoint (`POST /mcp`). */
  rpc(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
}

/** Availability verdict enforced by the router before any computer-use call. */
export interface ComputerUseCallDecision {
  allowed: boolean;
  reason?: 'COMPUTER_USE_PAUSED' | 'COMPUTER_PAUSED';
  message?: string;
  computerId?: string | null;
  until?: string | null;
}

export interface ComputerUseService {
  /** Managed MCP server id (null until the broker is configured). */
  readonly serverId: string | null;
  readonly managedServerName: string;
  /** Ensure the managed server exists; start it when configured + enabled. */
  initialize(): Promise<void>;
  /** Reconfigure the broker client, re-register the server and refresh tools. */
  sync(): Promise<ComputerUseOverview>;
  overview(): Promise<ComputerUseOverview>;
  listComputers(): Promise<ComputerUseComputersResponse>;
  updateSettings(input: ComputerUseSettingsInput): Promise<ComputerUseOverview>;
  setAvailability(input: ComputerUseAvailabilityInput, updatedBy?: string): Promise<ComputerUseOverview>;
  startComputer(computerId: string): Promise<ComputerUseComputerInfo>;
  stopComputer(computerId: string): Promise<ComputerUseComputerInfo>;
  frame(computerId: string, maxWidth: number): Promise<ComputerUseFrameResult>;
  /** Recent audit rows for the managed computer-use server. */
  activity(limit: number): Promise<AuditEntry[]>;
  /** Router gate: refusal is returned, never thrown (the router owns audit). */
  checkCall(tool: ToolDescriptor, args: Record<string, unknown>): ComputerUseCallDecision;
  /** Built-in MCP client factory for the supervisor (null for other servers). */
  createClient(serverId: string): McpClient | null;
  dispose(): Promise<void>;
}
