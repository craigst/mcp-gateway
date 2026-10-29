/**
 * Shared domain contracts for the MCP Gateway.
 *
 * Every module (rbac, catalog, gateway, delegation, vault, git_engine, ui)
 * depends on these types. Keep them stable and additive.
 */

// ---------------------------------------------------------------------------
// JSON-RPC 2.0
// ---------------------------------------------------------------------------

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** MCP / gateway notification (no id, no response). */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// ---------------------------------------------------------------------------
// JSON Schema (subset used by guardrails + tool input schemas)
// ---------------------------------------------------------------------------

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// API keys & RBAC
// ---------------------------------------------------------------------------

export type KeyType = 'agent' | 'dev' | 'sub' | 'sup' | 'master';

export const KEY_PREFIX_BY_TYPE: Record<KeyType, string> = {
  agent: 'mcp_ag_',
  dev: 'mcp_dev_',
  sub: 'mcp_sub_',
  sup: 'mcp_sup_',
  master: 'mcp_master_',
};

export const KEY_TYPES: readonly KeyType[] = ['agent', 'dev', 'sub', 'sup', 'master'];

export type GuardrailKind = 'regex_applied_to_arguments' | 'json_schema';

export interface ToolGuardrail {
  /** Tool this rule applies to; omitted/null means every tool of the granted server. */
  tool?: string | null;
  kind: GuardrailKind;
  /** Regex source (for `regex_applied_to_arguments`). */
  pattern?: string;
  /** Regex flags, default "i". */
  flags?: string;
  /** If true the pattern must match; if false (default) a match is a denial. */
  mustMatch?: boolean;
  /** JSON Schema applied to tool arguments (for `json_schema`). */
  schema?: JsonSchema;
  message?: string;
}

export interface ServerGrant {
  serverId: string;
  /**
   * Tool whitelist. `null`/omitted = every non-high-privilege tool of the server.
   * `[]` = no tools granted.
   */
  tools?: string[] | null;
  /** High-privilege tool ids explicitly granted for this server. */
  highPrivilegeTools?: string[] | null;
  /** Argument guardrails applied to calls made under this grant. */
  guardrails?: ToolGuardrail[];
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyType: KeyType;
  keyHash: string;
  /** First characters of the plaintext key, safe to display (e.g. `mcp_ag_ab12`). */
  keyPrefix: string;
  serverGrants: ServerGrant[];
  delegationAllowed: boolean;
  /** Whether this key may request transient scope escalation. */
  escalationAllowed: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  metadata: Record<string, unknown>;
}

/** Key context attached to an authenticated request (never contains the plaintext key). */
export type AuthenticatedKey = Omit<ApiKeyRecord, 'keyHash'> & {
  /** Plaintext key, only available on the request that presented it. */
  plaintext?: string;
};

export interface KeySummary {
  id: string;
  name: string;
  keyType: KeyType;
  keyPrefix: string;
  serverGrants: ServerGrant[];
  delegationAllowed: boolean;
  escalationAllowed: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface CreateKeyInput {
  name: string;
  keyType: KeyType;
  serverGrants?: ServerGrant[];
  delegationAllowed?: boolean;
  escalationAllowed?: boolean;
  /** ISO timestamp or relative duration in seconds. */
  expiresInSeconds?: number | null;
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
}

export interface IssuedKey {
  key: AuthenticatedKey;
  /** Full plaintext key. Shown exactly once at creation time. */
  plaintext: string;
}

export type PolicyDenialReason =
  | 'SERVER_NOT_PERMITTED'
  | 'TOOL_NOT_PERMITTED'
  | 'HIGH_PRIVILEGE_RESTRICTION'
  | 'GUARDRAIL_VIOLATION'
  | 'DELEGATION_NOT_PERMITTED'
  | 'ESCALATION_NOT_PERMITTED'
  | 'KEY_REVOKED'
  | 'KEY_EXPIRED';

export interface AuthorizationDecision {
  allowed: boolean;
  reason?: PolicyDenialReason;
  /** Human-readable detail (not exposed verbatim to agents for invisible denials). */
  detail?: string;
  ticketId?: string;
}

// ---------------------------------------------------------------------------
// Servers & catalog
// ---------------------------------------------------------------------------

export type RuntimeKind = 'node' | 'python' | 'binary' | 'remote-agent';
export type TransportKind = 'stdio' | 'http' | 'sse' | 'websocket';
export type ServerStatus = 'stopped' | 'starting' | 'running' | 'degraded' | 'failed' | 'stopping';

/** `mcp-manifest.json` produced by sub-server repositories. */
export interface ServerManifest {
  name: string;
  version: string;
  runtime: string;
  build_command?: string;
  start_command?: string;
  environment?: Record<string, string>;
  required_secrets?: string[];
  capabilities?: {
    high_privilege_tools?: string[];
    delegation_supported?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ServerRecord {
  id: string;
  name: string;
  runtime: RuntimeKind;
  transport: TransportKind;
  status: ServerStatus;
  command: string | null;
  args: string[];
  url: string | null;
  env: Record<string, string>;
  /** HTTP auth headers for remote transports (values only in DB/local, never exposed by discovery). */
  headers?: Record<string, string>;
  manifest: ServerManifest | null;
  highPrivilegeTools: string[];
  delegationSupported: boolean;
  sourceUrl: string | null;
  workDir: string | null;
  /** Optional env file (KEY=VALUE lines) read at start; values are never persisted. */
  envFile?: string | null;
  /** Tools that require an approved escalation ticket before execution. */
  approvalRequiredTools?: string[];
  /** Config profiles applied to this server (merged into env/headers at start). */
  configProfileIds?: string[];
  lastError: string | null;
  pid: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ToolDescriptor {
  /** Globally unique id: `${serverId}:${name}`. */
  id: string;
  name: string;
  description: string;
  serverId: string;
  inputSchema: JsonSchema;
  highPrivilege: boolean;
  tags: string[];
}

export interface ToolSearchResult {
  tools: Array<{
    id: string;
    name: string;
    description: string;
    server_id: string;
    score: number;
  }>;
  total: number;
  censored: true;
}

export interface PermittedServerSummary {
  id: string;
  name: string;
  runtime: RuntimeKind;
  status: ServerStatus;
  delegation_supported: boolean;
  tool_count: number;
}

// ---------------------------------------------------------------------------
// Delegation / observer pattern
// ---------------------------------------------------------------------------

export interface DelegationTarget {
  id: string;
  name: string;
  url: string;
  protocol: 'http' | 'mcp';
  /** Name of the vault secret holding the bearer token, if any. */
  authSecretName?: string | null;
  timeoutMs: number;
}

export interface DelegationRequest {
  targetId: string;
  payload: unknown;
  mode?: 'delegate' | 'observe_and_verify';
}

export interface DelegationResult {
  targetId: string;
  status: 'approved' | 'denied' | 'error';
  verdict: string | null;
  approvalToken: string | null;
  output: unknown;
  latencyMs: number;
  depth: number;
  traceId: string;
}

// ---------------------------------------------------------------------------
// Audit / escalations
// ---------------------------------------------------------------------------

export type AuditStatus = 'ok' | 'error' | 'denied';

export interface AuditEntry {
  id: number;
  ts: string;
  requestId: string | null;
  keyId: string | null;
  method: string;
  serverId: string | null;
  toolId: string | null;
  status: AuditStatus;
  latencyMs: number;
  errorCode: number | null;
  delegationDepth: number;
  parentId: number | null;
  payload: unknown;
}

export type EscalationStatus = 'pending' | 'approved' | 'denied' | 'expired';

/** `scope` = transient privilege escalation; `tool_approval` = gated tool execution. */
export type EscalationTicketType = 'scope' | 'tool_approval';

export interface EscalationTicket {
  id: string;
  ticketId: string;
  keyId: string;
  toolId: string | null;
  serverId: string | null;
  reason: string;
  requestPayload: unknown;
  status: EscalationStatus;
  ticketType?: EscalationTicketType;
  /** Arguments captured for a gated tool call (executed only after approval). */
  toolArguments?: unknown;
  /** Result of the approved execution (may be a delivery path; never a secret value). */
  result?: unknown;
  consumedAt?: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  note: string | null;
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export interface VaultSecretMetadata {
  name: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Gateway principal / request context
// ---------------------------------------------------------------------------

export interface RequestContext {
  requestId: string;
  key: AuthenticatedKey | null;
  delegationDepth: number;
  parentAuditId: number | null;
  /** Resolved per-request metadata from HTTP headers. */
  headers: Record<string, string>;
  clientIp: string | null;
}


// ---------------------------------------------------------------------------
// v0.2 — plugin catalog (GitHub / private repos)
// ---------------------------------------------------------------------------

export type CatalogSourceKind = 'dsh-umbrella' | 'github-repo' | 'catalog-json';

export interface CatalogSource {
  id: string;
  label: string;
  kind: CatalogSourceKind;
  /** Repository URL (https) or raw catalog JSON URL for `catalog-json`. */
  repoUrl: string;
  ref: string | null;
  subpath: string | null;
  /** Name of the AES-256 vault secret holding the API/clone token. */
  tokenSecretName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogEntry {
  id: string;
  sourceId: string;
  name: string;
  repoUrl: string;
  ref: string | null;
  /** Entry file inside the repository (e.g. `brain-mcp.js`). */
  entry: string | null;
  kind: 'mcp' | 'bundle';
  serverName: string | null;
  description: string | null;
  installCommand: string | null;
  supported: boolean;
  unsupportedReason: string | null;
  installedServerId: string | null;
}

export interface InstallTestResult {
  ok: boolean;
  toolCount: number;
  tools: string[];
  latencyMs: number;
  error: string | null;
}

export interface CatalogInstallResult {
  server: ServerRecord;
  test: InstallTestResult | null;
  buildLogTail: string[];
}

// ---------------------------------------------------------------------------
// v0.2 — local harness discovery (Claude / opencode / OpenMausBot / generic)
// ---------------------------------------------------------------------------

export interface HarnessSourceInfo {
  id: string;
  label: string;
  configPath: string;
  exists: boolean;
  serverCount: number;
}

export type HarnessTransport = 'stdio' | 'http' | 'sse' | 'websocket';

export interface HarnessEntry {
  id: string;
  harness: string;
  name: string;
  transport: HarnessTransport;
  command: string | null;
  args: string[];
  url: string | null;
  /** Env variable NAMES only — values are never returned by discovery. */
  envKeys: string[];
  /** Optional env file the harness loads (values stay on disk). */
  envFile: string | null;
  /** Header NAMES only for remote transports. */
  headerKeys: string[];
  enabled: boolean;
}

export interface HarnessScanResult {
  sources: HarnessSourceInfo[];
  entries: HarnessEntry[];
  errors: Array<{ harness: string; error: string }>;
}

export interface HarnessImportInput {
  harness: string;
  name: string;
  transport?: HarnessTransport;
  command?: string | null;
  args?: string[];
  url?: string | null;
  env?: Record<string, string>;
  envFile?: string | null;
  headers?: Record<string, string>;
  highPrivilegeTools?: string[];
  approvalRequiredTools?: string[];
}


// ---------------------------------------------------------------------------
// v0.4 — update tracking & reusable configuration profiles
// ---------------------------------------------------------------------------

export type UpdateStatus = 'unknown' | 'up-to-date' | 'update-available' | 'error';

export interface ServerSourceInfo {
  serverId: string;
  sourceKind: 'catalog' | 'git' | 'local';
  catalogSourceId: string | null;
  catalogEntryId: string | null;
  repoUrl: string | null;
  requestedRef: string | null;
  installedCommit: string | null;
  installedVersion: string | null;
  latestCommit: string | null;
  latestVersion: string | null;
  latestRef: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  checkError: string | null;
  changelogUrl: string | null;
}

export interface UpdateCheckResult {
  serverId: string;
  serverName: string;
  status: UpdateStatus;
  updateAvailable: boolean;
  fromVersion: string | null;
  toVersion: string | null;
  fromCommit: string | null;
  toCommit: string | null;
  latestRef: string | null;
  checkedAt: string;
  error: string | null;
}

export interface ServerUpdateResult {
  server: ServerRecord;
  before: { version: string | null; commit: string | null };
  after: { version: string | null; commit: string | null };
  test: InstallTestResult | null;
  changed: boolean;
}

/**
 * A configuration/credential value stored entirely in the gateway's AES-256 vault.
 * `encrypted` values are profile-owned secrets; `vault-ref` points at an existing
 * named secret from the Vault page. Values are never returned by the API.
 */
export interface ConfigProfileValue {
  key: string;
  source: 'encrypted' | 'vault-ref';
  /** Vault secret name when source is `vault-ref`. */
  ref: string | null;
}

export interface ConfigProfile {
  id: string;
  name: string;
  description: string | null;
  /** Environment variable names and where their encrypted values live. */
  entries: ConfigProfileValue[];
  /** HTTP header names and their encrypted value references. */
  headers: ConfigProfileValue[];
  createdAt: string;
  updatedAt: string;
}

export interface ConfigProfileInputValue {
  key: string;
  /** New plaintext value: encrypted into the gateway vault. Never returned. */
  value?: string;
  /** Reference to an existing gateway vault secret by name. */
  secretRef?: string;
}

export interface ConfigProfileInput {
  name: string;
  description?: string | null;
  entries?: ConfigProfileInputValue[];
  headers?: ConfigProfileInputValue[];
}

export interface ConfigProfileSummary extends ConfigProfile {
  attachedServerIds: string[];
}

export interface ConfigProfileApplyResult {
  serverId: string;
  serverName: string;
  applied: boolean;
  restarted: boolean;
  test: InstallTestResult | null;
  error: string | null;
}
