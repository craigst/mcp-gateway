/**
 * Shared harness for v0.5 server-inspector tests.
 *
 * Real in-memory SQLite schema, real catalog repository, AES vault, API keys,
 * audit service and configuration-profile service. Nothing here touches the
 * network or the filesystem beyond the in-memory database.
 */
import type { DatabaseSync } from 'node:sqlite';

import type { GatewayConfig } from '../../src/core/config.js';
import { openDatabase } from '../../src/core/db.js';
import { nowIso } from '../../src/core/ids.js';
import type { Logger } from '../../src/core/logger.js';
import type { ServerUpdateService } from '../../src/core/ports.js';
import type {
  AuditStatus,
  PromptDescriptor,
  ResourceDescriptor,
  ServerRecord,
  ServerSourceInfo,
  ToolDescriptor,
} from '../../src/core/types.js';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';
import { DefaultConfigProfileService } from '../../src/config_profiles/service.js';
import { SqliteAuditService } from '../../src/gateway/audit.js';
import { DefaultSupervisor } from '../../src/gateway/supervisor.js';
import { ServerInspectorService } from '../../src/inspector/service.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';
import { SqliteVaultService } from '../../src/vault/store.js';

export const INSPECTOR_VAULT_SECRET = 'inspector-test-vault-secret-0123456789';
export const EXISTING_VAULT_SECRET = 'EXISTING_SECRET';

export interface InspectorHarness {
  config: GatewayConfig;
  db: DatabaseSync;
  repository: SqliteCatalogRepository;
  keys: SqliteKeyService;
  audit: SqliteAuditService;
  vault: SqliteVaultService;
  configProfiles: DefaultConfigProfileService;
  updates: { get: (serverId: string) => ServerSourceInfo | null };
  inspector: ServerInspectorService;
  logger?: Logger;
  dispose(): Promise<void>;
}

export interface CreateInspectorHarnessOptions {
  logger?: Logger;
  /** Update-source lookup used by `overview().source`. */
  source?: ServerSourceInfo | null;
}

export function makeInspectorConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir: '/tmp/inspector-test-data',
    dbPath: '/tmp/inspector-test-data/gateway.db',
    uiDistDir: '/tmp/inspector-test-data/ui',
    vaultSecret: INSPECTOR_VAULT_SECRET,
    bootstrapMasterKey: null,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: [],
    reposDir: '/tmp/inspector-test-data/repos',
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 10_000,
    keyPepper: null,
    publicBaseUrl: 'http://127.0.0.1:8080',
    ...overrides,
  };
}

export function createInspectorHarness(options: CreateInspectorHarnessOptions = {}): InspectorHarness {
  const config = makeInspectorConfig();
  const db = openDatabase(':memory:');
  const repository = new SqliteCatalogRepository(db);
  const keys = new SqliteKeyService(db, { pepper: null });
  const vault = new SqliteVaultService(db, INSPECTOR_VAULT_SECRET);
  const audit = new SqliteAuditService(db);
  const supervisor = new DefaultSupervisor({ repository, config, vault });
  const configProfiles = new DefaultConfigProfileService({ db, repository, vault, supervisor });
  const updates = {
    get: (): ServerSourceInfo | null => options.source ?? null,
  } as unknown as ServerUpdateService;
  const inspector = new ServerInspectorService({
    db,
    repository,
    keys,
    audit,
    vault,
    configProfiles,
    updates,
    logger: options.logger,
  });
  return {
    config,
    db,
    repository,
    keys,
    audit,
    vault,
    configProfiles,
    updates: updates as unknown as InspectorHarness['updates'],
    inspector,
    logger: options.logger,
    dispose: async () => {
      try {
        await supervisor.shutdown();
      } finally {
        db.close();
      }
    },
  };
}

export interface SeedServerOptions {
  id?: string;
  name: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  capabilities?: Record<string, unknown>;
  instructions?: string | null;
  prompts?: PromptDescriptor[];
  resources?: ResourceDescriptor[];
  status?: ServerRecord['status'];
}

export function seedServer(
  harness: InspectorHarness,
  options: SeedServerOptions,
): ServerRecord {
  const now = nowIso();
  const id = options.id ?? `srv_${options.name.replace(/[^a-z0-9]/gi, '').slice(0, 16).padEnd(16, '0')}`;
  const record: ServerRecord = {
    id,
    name: options.name,
    runtime: 'node',
    transport: 'stdio',
    status: options.status ?? 'running',
    command: 'node',
    args: ['server.js'],
    url: null,
    env: options.env ?? {},
    headers: options.headers ?? {},
    manifest: { name: options.name, version: '1.0.0', runtime: 'node20', start_command: 'node server.js' },
    highPrivilegeTools: [],
    delegationSupported: false,
    sourceUrl: null,
    workDir: null,
    envFile: null,
    approvalRequiredTools: [],
    configProfileIds: [],
    capabilities: options.capabilities ?? { tools: { listChanged: true }, logging: {} },
    instructions: options.instructions ?? null,
    prompts: options.prompts ?? [],
    resources: options.resources ?? [],
    lastError: null,
    pid: null,
    createdAt: now,
    updatedAt: now,
  };
  harness.repository.upsertServer(record);
  return record;
}

export function seedTools(
  harness: InspectorHarness,
  serverId: string,
  tools: Array<Pick<ToolDescriptor, 'name'> & Partial<ToolDescriptor>>,
): ToolDescriptor[] {
  const descriptors: ToolDescriptor[] = tools.map((tool) => ({
    id: `${serverId}:${tool.name}`,
    name: tool.name,
    description: tool.description ?? `${tool.name} tool`,
    serverId,
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    highPrivilege: tool.highPrivilege ?? false,
    tags: tool.tags ?? [],
  }));
  harness.repository.upsertTools(serverId, descriptors);
  return descriptors;
}

export interface IssueKeyResult {
  id: string;
  plaintext: string;
  name: string;
}

export function issueKey(
  harness: InspectorHarness,
  name: string,
  keyType: 'master' | 'agent' | 'dev' | 'sub' | 'sup' = 'agent',
): IssueKeyResult {
  const issued = harness.keys.issue({ name, keyType });
  return { id: issued.key.id, plaintext: issued.plaintext, name };
}

export interface AuditSeed {
  keyId: string | null;
  status: AuditStatus;
  latencyMs: number;
  toolId?: string | null;
  toolName?: string;
  method?: string;
}

/** Inserts one audit row (defaults to a `tools/call` row). */
export function seedAudit(harness: InspectorHarness, serverId: string, seed: AuditSeed): number {
  const toolId =
    seed.toolId ?? (seed.toolName === undefined ? null : `${serverId}:${seed.toolName}`);
  return harness.audit.record({
    requestId: null,
    keyId: seed.keyId,
    method: seed.method ?? 'tools/call',
    serverId,
    toolId,
    status: seed.status,
    latencyMs: seed.latencyMs,
  });
}

/** Seeds a deterministic tools/call matrix: 10 calls across 2 keys and 3 tools. */
export function seedAuditMatrix(
  harness: InspectorHarness,
  serverId: string,
  masterKeyId: string,
  agentKeyId: string,
): void {
  const statuses: AuditStatus[] = ['ok', 'ok', 'ok', 'ok', 'ok', 'error', 'error', 'denied', 'ok', 'ok'];
  const tools = ['echo', 'echo', 'echo', 'add', 'add', 'echo', 'add', 'danger_delete', 'echo', 'add'];
  const keys = [
    masterKeyId,
    agentKeyId,
    agentKeyId,
    agentKeyId,
    masterKeyId,
    agentKeyId,
    masterKeyId,
    agentKeyId,
    agentKeyId,
    masterKeyId,
  ];
  for (let index = 0; index < statuses.length; index += 1) {
    seedAudit(harness, serverId, {
      keyId: keys[index] as string,
      status: statuses[index] as AuditStatus,
      latencyMs: (index + 1) * 10,
      toolName: tools[index] as string,
    });
  }
  // A non-tools/call row must be visible in activity but excluded from stats.
  seedAudit(harness, serverId, {
    keyId: agentKeyId,
    status: 'ok',
    latencyMs: 5,
    method: 'tools/list',
  });
}

/** Creates and attaches an encrypted + vault-ref configuration profile. */
export async function seedProfile(
  harness: InspectorHarness,
  serverId: string,
): Promise<{ profileId: string; name: string }> {
  harness.vault.setSecret(EXISTING_VAULT_SECRET, 'vault-ref-secret-value');
  const profile = await harness.configProfiles.create({
    name: 'Example credentials',
    description: 'Fixture profile',
    entries: [
      { key: 'API_TOKEN', value: 'profile-encrypted-token' },
      { key: 'BASE_URL', value: 'https://config.example.internal' },
      { key: 'EXISTING_KEY', secretRef: EXISTING_VAULT_SECRET },
    ],
    headers: [{ key: 'AUTHORIZATION', value: 'Bearer profile-header-token' }],
  });
  const results = await harness.configProfiles.apply([profile.id], [serverId], {
    restart: false,
    test: false,
  });
  const result = results[0];
  if (result === undefined || result.error !== null) {
    throw new Error(`failed to attach fixture profile: ${result?.error ?? 'no result'}`);
  }
  return { profileId: profile.id, name: profile.name };
}
