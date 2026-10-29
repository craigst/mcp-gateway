import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { loadConfig, type GatewayConfig } from './core/config.js';
import { openDatabase } from './core/db.js';
import { createLogger, type Logger } from './core/logger.js';
import type {
  AuditService,
  CatalogRepository,
  CatalogService,
  DelegationService,
  EscalationService,
  GitImportService,
  KeyService,
  PolicyEngine,
  Supervisor,
  VaultService,
} from './core/ports.js';
import type { DelegationTarget } from './core/types.js';
import { SqliteKeyService } from './rbac/keys.js';
import { RbacPolicyEngine } from './rbac/policy.js';
import { SqliteEscalationService } from './rbac/escalations.js';
import { SqliteCatalogRepository } from './catalog/repository.js';
import { DefaultCatalogService } from './catalog/service.js';
import { SqliteVaultService } from './vault/store.js';
import { GitImportService as GitImportServiceImpl } from './git_engine/service.js';
import { DefaultDelegationService } from './delegation/service.js';
import { DefaultSupervisor } from './gateway/supervisor.js';
import { SqliteAuditService } from './gateway/audit.js';
import { JsonRpcRouter } from './gateway/router.js';
import { GatewayHttpServer, type GatewayAddress } from './gateway/server.js';
import { AdminApi } from './admin/router.js';
import { SqliteApprovalService } from './approvals/service.js';
import { VaultwardenApi } from './admin/vaultwarden-api.js';
import { DefaultHarnessDiscoveryService } from './discovery/service.js';
import { DiscoveryApi } from './admin/discovery-api.js';
import { GitPluginCatalog } from './catalog_sources/index.js';
import { CatalogApi } from './admin/catalog-api.js';

export interface GatewayServices {
  keys: KeyService;
  policy: PolicyEngine;
  escalations: EscalationService;
  repository: CatalogRepository;
  catalog: CatalogService;
  vault: VaultService;
  git: GitImportService;
  delegation: DelegationService;
  supervisor: Supervisor;
  audit: AuditService;
  router: JsonRpcRouter;
  admin: AdminApi;
}

export interface GatewayContainer {
  config: GatewayConfig;
  db: DatabaseSync;
  logger: Logger;
  services: GatewayServices;
  server: GatewayHttpServer;
  start(): Promise<GatewayAddress>;
  stop(): Promise<void>;
}

export interface ContainerOptions {
  config?: GatewayConfig;
  logger?: Logger;
  /** Extra delegation targets for observer harnesses (also read from MCP_DELEGATION_TARGETS). */
  delegationTargets?: DelegationTarget[];
}

/**
 * Composition root. Every module receives ports; this is the only place that
 * knows concrete classes. Also performs first-boot master-key bootstrap.
 */
export function createContainer(options: ContainerOptions = {}): GatewayContainer {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger('gateway', config.logLevel);
  mkdirSync(config.dataDir, { recursive: true });

  const db = openDatabase(config.dbPath);
  const repository = new SqliteCatalogRepository(db);
  const keys = new SqliteKeyService(db, { pepper: config.keyPepper, logger: createLogger('rbac', config.logLevel) });
  const policy = new RbacPolicyEngine({ logger: createLogger('policy', config.logLevel) });
  const catalog = new DefaultCatalogService(repository, policy);
  const escalations = new SqliteEscalationService(db, { logger });
  const vault = new SqliteVaultService(db, config.vaultSecret, { logger });
  const git = new GitImportServiceImpl({ config, repository, vault, logger });
  const delegation = new DefaultDelegationService({
    db,
    config,
    vault,
    targets: options.delegationTargets ?? parseDelegationTargets(process.env.MCP_DELEGATION_TARGETS, logger),
    logger,
  });

  // Audit needs live counters; close over the services that own them.
  const audit = new SqliteAuditService(db, {
    serverCounts: () => {
      const servers = repository.listServers();
      return { running: servers.filter((server) => server.status === 'running').length, total: servers.length };
    },
    delegationCounts: () => {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) AS approved,
                  COALESCE(SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END), 0) AS denied
             FROM delegation_traces`,
        )
        .get() as { total: number; approved: number; denied: number } | undefined;
      return {
        total: Number(row?.total ?? 0),
        approved: Number(row?.approved ?? 0),
        denied: Number(row?.denied ?? 0),
      };
    },
  });

  const supervisor = new DefaultSupervisor({ repository, config, vault, logger });

  // v0.2: approval gating for dangerous tools + Vault Warden + harness discovery.
  const approvals = new SqliteApprovalService({ db, repository, supervisor, logger });
  const vaultwardenApi = new VaultwardenApi({ config, keys, catalog, audit, db, logger });
  const discovery = new DefaultHarnessDiscoveryService({ repository, logger });
  const discoveryApi = new DiscoveryApi({ config, keys, discovery, logger });
  const pluginCatalog = new GitPluginCatalog({ db, config, repository, vault, supervisor, git, logger });
  const catalogApi = new CatalogApi({ config, keys, catalog: pluginCatalog, logger });

  const router = new JsonRpcRouter({
    config,
    keys,
    policy,
    escalations,
    catalog,
    supervisor,
    delegation,
    audit,
    approvals,
    logger,
  });
  const admin = new AdminApi({
    config,
    keys,
    policy,
    escalations,
    catalog,
    supervisor,
    vault,
    git,
    audit,
    delegation,
    approvals,
    vaultwardenApi,
    discoveryApi,
    catalogApi,
    logger,
  });
  const server = new GatewayHttpServer({ config, router, admin, keys, supervisor, audit, logger });

  // Reset stale "running" rows from a previous process, then bootstrap the master key.
  for (const record of repository.listServers()) {
    if (record.status !== 'stopped') repository.setServerStatus(record.id, 'stopped', { pid: null });
  }
  bootstrapMasterKey(keys, config, logger);

  const services: GatewayServices = {
    keys,
    policy,
    escalations,
    repository,
    catalog,
    vault,
    git,
    delegation,
    supervisor,
    audit,
    router,
    admin,
  };

  return {
    config,
    db,
    logger,
    services,
    server,
    start: () => server.start(),
    stop: async () => {
      await server.stop();
      await supervisor.shutdown();
      db.close();
    },
  };
}

function bootstrapMasterKey(keys: KeyService, config: GatewayConfig, logger: Logger): void {
  if (keys.list().length > 0) return;

  if (config.bootstrapMasterKey) {
    const record = keys.importKey(config.bootstrapMasterKey, {
      name: 'bootstrap-master',
      keyType: 'master',
      serverGrants: [],
      delegationAllowed: true,
      escalationAllowed: true,
    });
    logger.info('bootstrap master key registered', { keyId: record.id, keyPrefix: record.keyPrefix });
    return;
  }

  const issued = keys.issue({
    name: 'bootstrap-master',
    keyType: 'master',
    serverGrants: [],
    delegationAllowed: true,
    escalationAllowed: true,
  });
  logger.warn(
    'no API keys existed; generated a bootstrap master key. Store this securely — it is shown only once.',
    { masterKey: issued.plaintext },
  );
}

function parseDelegationTargets(raw: string | undefined, logger: Logger): DelegationTarget[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
    return parsed as DelegationTarget[];
  } catch (error) {
    logger.warn('MCP_DELEGATION_TARGETS is not valid JSON; delegation targets disabled', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
