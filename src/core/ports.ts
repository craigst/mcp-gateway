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
  AuthenticatedKey,
  AuditEntry,
  AuditStatus,
  AuthorizationDecision,
  CreateKeyInput,
  DelegationResult,
  DelegationTarget,
  EscalationStatus,
  EscalationTicket,
  IssuedKey,
  JsonSchema,
  PermittedServerSummary,
  PolicyDenialReason,
  ServerRecord,
  ServerStatus,
  ToolDescriptor,
  ToolGuardrail,
  ToolSearchResult,
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
  /** Removes expired keys; returns count. */
  purgeExpired(now?: Date): number;
}

export interface PolicyEngine {
  /** Server-level grant check (zero-trust visibility). */
  isServerPermitted(key: AuthenticatedKey, serverId: string): boolean;
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
