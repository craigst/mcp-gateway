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
  ConfigProfileService,
  EscalationService,
  GitImportService,
  KeyService,
  PolicyEngine,
  ServerUpdateService,
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
import { MasterKeyControl } from './admin/master-keys.js';
import { SqliteUiAuthService } from './auth/service.js';
import { AuthApi } from './auth/http.js';
import { authenticateRequest } from './auth/request-auth.js';
import { DefaultConfigProfileService } from './config_profiles/index.js';
import { ConfigProfilesApi } from './admin/config-profiles-api.js';
import { DefaultServerUpdateService } from './updates/index.js';
import { UpdatesApi } from './admin/updates-api.js';
import { ServerInspectorService } from './inspector/index.js';
import { InspectorApi } from './admin/inspector-api.js';

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
  configProfiles: ConfigProfileService;
  updates: ServerUpdateService;
  inspector: ServerInspectorService;
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
  const uiAuth = new SqliteUiAuthService(db, config, { logger: createLogger('auth', config.logLevel) });
  uiAuth.ensureBootstrapUser();
  const authApi = new AuthApi({ uiAuth, config, logger });
  const authenticate = (req: import('node:http').IncomingMessage) => authenticateRequest(req, keys, uiAuth);
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

  // The supervisor needs profiles and profiles need the supervisor: resolve lazily.
  const profileHolder: { service: DefaultConfigProfileService | null } = { service: null };
  const supervisor = new DefaultSupervisor({
    repository,
    config,
    vault,
    logger,
    profileResolver: (serverId) =>
      profileHolder.service?.resolveForServer(serverId) ?? { env: {}, headers: {} },
  });
  const configProfiles = new DefaultConfigProfileService({
    db,
    repository,
    vault,
    supervisor,
    logger,
  });
  profileHolder.service = configProfiles;
  const configProfilesApi = new ConfigProfilesApi({ config, keys, configProfiles, logger, authenticate });

  // Server update tracking (v0.4). Catalog installs feed source metadata via a
  // lazy callback because the catalog is constructed before this service.
  const sourceHolder: { record: ((input: import('./core/ports.js').ServerSourceRecordInput) => void) | null } = {
    record: null,
  };
  const pluginCatalog = new GitPluginCatalog({
    db,
    config,
    repository,
    vault,
    supervisor,
    git,
    logger,
    onServerSource: (input) => sourceHolder.record?.(input),
  });
  const updates = new DefaultServerUpdateService({
    db,
    config,
    repository,
    supervisor,
    vault,
    catalog: pluginCatalog,
    git,
    logger,
  });
  sourceHolder.record = (input) => updates.recordSource(input);
  const updatesApi = new UpdatesApi({ config, keys, updates, authenticate, logger });
  const inspector = new ServerInspectorService({
    db,
    repository,
    keys,
    audit,
    vault,
    configProfiles,
    updates,
    logger,
  });
  const inspectorApi = new InspectorApi({ config, keys, inspector, authenticate, logger });

  // v0.2: approval gating for dangerous tools + Vault Warden + harness discovery.
  const approvals = new SqliteApprovalService({ db, repository, supervisor, logger });
  const vaultwardenApi = new VaultwardenApi({ config, keys, catalog, audit, db, logger, authenticate });
  const discovery = new DefaultHarnessDiscoveryService({ repository, logger });
  const discoveryApi = new DiscoveryApi({ config, keys, discovery, logger, authenticate });
  const catalogApi = new CatalogApi({ config, keys, catalog: pluginCatalog, logger, authenticate });
  const masterKeys = new MasterKeyControl({ keys, logger });

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
    masterKeys,
    authenticate,
    vaultwardenApi,
    discoveryApi,
    catalogApi,
    configProfilesApi,
    updatesApi,
    inspectorApi,
    logger,
  });
  const server = new GatewayHttpServer({ config, router, admin, keys, uiAuth, authApi, supervisor, audit, logger });

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
    configProfiles,
    updates,
    inspector,
    router,
    admin,
  };

  return {
    config,
    db,
    logger,
    services,
    server,
    start: async () => {
      const address = await server.start();
      await autostartServers(supervisor, repository, config.autostart, logger);
      return address;
    },
    stop: async () => {
      await server.stop();
      await supervisor.shutdown();
      db.close();
    },
  };
}

/**
 * Starts configured sub-servers after boot (`MCP_AUTOSTART=all` or `name1,name2`).
 * Failures are logged and never block the gateway from coming up.
 */
async function autostartServers(
  supervisor: Supervisor,
  repository: CatalogRepository,
  setting: string | undefined,
  logger: Logger,
): Promise<void> {
  const requested = (setting ?? '').trim();
  if (!requested) return;
  const servers = repository.listServers();
  const selected =
    requested.toLowerCase() === 'all'
      ? servers
      : servers.filter((server) => requested.split(',').map((name) => name.trim()).includes(server.name));
  for (const server of selected) {
    if (server.status === 'running') continue;
    try {
      await supervisor.start(server.id);
      logger.info('autostarted sub-server', { serverId: server.id, name: server.name });
    } catch (error) {
      logger.warn('autostart failed', {
        serverId: server.id,
        name: server.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
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
