import type { IncomingMessage, ServerResponse } from 'node:http';
import { ErrorCodes, GatewayError, accessDenied, invalidParams } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { GatewayConfig } from '../core/config.js';
import type {
  AuditService,
  CatalogService,
  DelegationService,
  EscalationService,
  GitImportService,
  KeyService,
  PolicyEngine,
  Supervisor,
  VaultService,
} from '../core/ports.js';
import type {
  AuthenticatedKey,
  EscalationStatus,
  KeySummary,
  KeyType,
  RuntimeKind,
  ServerRecord,
  ServerGrant,
  TransportKind,
} from '../core/types.js';
import { KEY_TYPES } from '../core/types.js';
import { readJsonBody } from '../gateway/server.js';

const RUNTIMES: RuntimeKind[] = ['node', 'python', 'binary', 'remote-agent'];
const TRANSPORTS: TransportKind[] = ['stdio', 'http', 'sse', 'websocket'];

export interface AdminDeps {
  config: GatewayConfig;
  keys: KeyService;
  policy: PolicyEngine;
  escalations: EscalationService;
  catalog: CatalogService;
  supervisor: Supervisor;
  vault: VaultService;
  git: GitImportService;
  audit: AuditService;
  delegation: DelegationService;
  logger?: Logger;
}

/**
 * REST management surface used by the Web UI and automation.
 * Authorization is master-only unless documented otherwise.
 */
export class AdminApi {
  private readonly logger: Logger;

  constructor(private readonly deps: AdminDeps) {
    this.logger = deps.logger ?? createLogger('admin');
  }

  /** Returns true when the URL matched an admin route (even if it errored). */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const segments = url.pathname.replace(/^\/mcp\/v1\/admin\/?/, '').split('/').filter(Boolean);
    const [area, ...rest] = segments;

    try {
      switch (area) {
        case 'keys':
          await this.handleKeys(req, res, rest);
          return true;
        case 'servers':
          await this.handleServers(req, res, rest);
          return true;
        case 'vault':
          await this.handleVault(req, res, rest);
          return true;
        case 'tools':
          this.handleTools(req, res);
          return true;
        case 'audit':
          this.requireKey(req, ['master', 'sup']);
          this.listAudit(res, url);
          return true;
        case 'delegations':
          this.requireKey(req, ['master', 'sup']);
          this.sendJson(res, 200, { traces: this.deps.delegation.listTraces(numberParam(url, 'limit', 100)) });
          return true;
        case 'escalations':
          await this.handleEscalations(req, res, rest, url);
          return true;
        default:
          return false;
      }
    } catch (error) {
      const gatewayError = error instanceof GatewayError ? error : new GatewayError(ErrorCodes.INTERNAL_ERROR, String(error), { httpStatus: 500 });
      this.logger.debug('admin request failed', { path: url.pathname, code: gatewayError.code, message: gatewayError.message });
      this.sendJson(res, gatewayError.httpStatus, { error: gatewayError.toJSONRpcError() });
      return true;
    }
  }

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------

  private async handleKeys(req: IncomingMessage, res: ServerResponse, rest: string[]): Promise<void> {
    this.requireKey(req, ['master']);
    const method = req.method ?? 'GET';

    if (rest.length === 0 && method === 'GET') {
      this.sendJson(res, 200, { keys: this.deps.keys.list().map(toKeySummary) });
      return;
    }
    if (rest[0]! === 'create' && method === 'POST') {
      const body = await readJsonBody(req, this.deps.config.requestBodyLimitBytes);
      this.assertObject(body);
      const keyType = body.keyType as KeyType;
      if (!KEY_TYPES.includes(keyType)) throw invalidParams(`keyType must be one of ${KEY_TYPES.join(', ')}`);
      const issued = this.deps.keys.issue({
        name: String(body.name ?? ''),
        keyType,
        serverGrants: Array.isArray(body.serverGrants) ? (body.serverGrants as never) : [],
        delegationAllowed: Boolean(body.delegationAllowed),
        escalationAllowed: Boolean(body.escalationAllowed),
        expiresInSeconds: typeof body.expiresInSeconds === 'number' ? body.expiresInSeconds : null,
        metadata: typeof body.metadata === 'object' && body.metadata !== null ? (body.metadata as Record<string, unknown>) : {},
      });
      this.sendJson(res, 201, { key: toKeySummary(issued.key), plaintext: issued.plaintext });
      return;
    }
    if (rest.length === 1 && method === 'GET') {
      const record = this.deps.keys.get(rest[0]!);
      if (!record) throw new GatewayError(ErrorCodes.TOOL_NOT_FOUND, 'Key not found', { httpStatus: 404 });
      this.sendJson(res, 200, { key: toKeySummary(record) });
      return;
    }
    if (rest.length === 2 && rest[1]! === 'revoke' && method === 'POST') {
      const record = this.deps.keys.revoke(rest[0]!);
      this.sendJson(res, 200, { key: toKeySummary(record) });
      return;
    }
    throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Unknown key endpoint', { httpStatus: 404 });
  }

  // -------------------------------------------------------------------------
  // Servers
  // -------------------------------------------------------------------------

  private async handleServers(req: IncomingMessage, res: ServerResponse, rest: string[]): Promise<void> {
    this.requireKey(req, ['master']);
    const method = req.method ?? 'GET';

    if (rest.length === 0 && method === 'GET') {
      this.sendJson(res, 200, { servers: this.deps.supervisor.list() });
      return;
    }
    if (rest[0]! === 'import' && method === 'POST') {
      const body = await readJsonBody(req, this.deps.config.requestBodyLimitBytes);
      this.assertObject(body);
      const record = await this.deps.git.importRepository({
        url: String(body.url ?? ''),
        name: body.name ? String(body.name) : undefined,
        startAfterBuild: Boolean(body.startAfterBuild),
        buildCommand: body.buildCommand ? String(body.buildCommand) : undefined,
        startCommand: body.startCommand ? String(body.startCommand) : undefined,
      });
      const started = body.startAfterBuild ? await this.deps.supervisor.start(record.id) : record;
      this.sendJson(res, 201, { server: started });
      return;
    }
    if (rest.length === 0 && method === 'POST') {
      const body = await readJsonBody(req, this.deps.config.requestBodyLimitBytes);
      this.assertObject(body);
      const record = this.buildServerRecord(body);
      this.deps.catalog.repository.upsertServer(record);
      this.sendJson(res, 201, { server: record });
      return;
    }
    if (rest.length === 2 && method === 'POST' && ['start', 'stop', 'restart'].includes(rest[1]!)) {
      const id = rest[0]!;
      if (rest[1]! === 'start') this.sendJson(res, 200, { server: await this.deps.supervisor.start(id) });
      else if (rest[1]! === 'stop') {
        await this.deps.supervisor.stop(id);
        this.sendJson(res, 200, { server: this.deps.catalog.repository.getServer(id) });
      } else this.sendJson(res, 200, { server: await this.deps.supervisor.restart(id) });
      return;
    }
    if (rest.length === 1 && method === 'DELETE') {
      try {
        await this.deps.supervisor.stop(rest[0]!);
      } catch {
        // Already stopped/unknown; deletion below is authoritative.
      }
      this.deps.catalog.repository.deleteServer(rest[0]!);
      this.sendJson(res, 200, { deleted: true });
      return;
    }
    if (rest.length === 2 && rest[1]! === 'logs' && method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://localhost');
      this.sendJson(res, 200, { lines: this.deps.supervisor.logs(rest[0]!, numberParam(url, 'limit', 200)) });
      return;
    }
    throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Unknown server endpoint', { httpStatus: 404 });
  }

  private buildServerRecord(body: Record<string, unknown>): ServerRecord {
    const name = String(body.name ?? '').trim();
    if (!name) throw invalidParams('name is required');
    const runtime = String(body.runtime ?? 'node') as RuntimeKind;
    if (!RUNTIMES.includes(runtime)) throw invalidParams(`runtime must be one of ${RUNTIMES.join(', ')}`);
    const transport = String(body.transport ?? 'stdio') as TransportKind;
    if (!TRANSPORTS.includes(transport)) throw invalidParams(`transport must be one of ${TRANSPORTS.join(', ')}`);
    const command = body.command ? String(body.command) : null;
    const url = body.url ? String(body.url) : null;
    if (transport === 'stdio' && !command) throw invalidParams('command is required for stdio transport');
    if (transport !== 'stdio' && !url) throw invalidParams('url is required for remote transports');

    const now = nowIso();
    return {
      id: newId('srv'),
      name,
      runtime,
      transport,
      status: 'stopped',
      command,
      args: Array.isArray(body.args) ? body.args.map(String) : [],
      url,
      env: isRecord(body.env) ? (Object.fromEntries(Object.entries(body.env).map(([k, v]) => [k, String(v)])) as Record<string, string>) : {},
      manifest: null,
      highPrivilegeTools: Array.isArray(body.highPrivilegeTools) ? body.highPrivilegeTools.map(String) : [],
      delegationSupported: Boolean(body.delegationSupported),
      sourceUrl: null,
      workDir: body.workDir ? String(body.workDir) : null,
      lastError: null,
      pid: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  // -------------------------------------------------------------------------
  // Vault
  // -------------------------------------------------------------------------

  private async handleVault(req: IncomingMessage, res: ServerResponse, rest: string[]): Promise<void> {
    this.requireKey(req, ['master']);
    if (!this.deps.vault.isEnabled()) {
      throw new GatewayError(ErrorCodes.NOT_IMPLEMENTED, 'Vault is not configured (set MCP_VAULT_SECRET)', {
        httpStatus: 503,
        data: { status: 'NOT_CONFIGURED', reason: 'VAULT_DISABLED' },
      });
    }
    const method = req.method ?? 'GET';

    if (rest[0]! !== 'secrets') throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Unknown vault endpoint', { httpStatus: 404 });

    if (rest.length === 1 && method === 'GET') {
      this.sendJson(res, 200, { enabled: true, secrets: this.deps.vault.listSecrets() });
      return;
    }
    if (rest.length === 2 && method === 'PUT') {
      const body = await readJsonBody(req, this.deps.config.requestBodyLimitBytes);
      this.assertObject(body);
      if (typeof body.value !== 'string' || body.value.length === 0) throw invalidParams('value is required');
      const secret = this.deps.vault.setSecret(rest[1]!, body.value);
      this.sendJson(res, 200, { secret });
      return;
    }
    if (rest.length === 2 && method === 'DELETE') {
      const deleted = this.deps.vault.deleteSecret(rest[1]!);
      this.sendJson(res, 200, { deleted });
      return;
    }
    throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Unknown vault endpoint', { httpStatus: 404 });
  }

  // -------------------------------------------------------------------------
  // Tools (RBAC scope grid)
  // -------------------------------------------------------------------------

  private handleTools(req: IncomingMessage, res: ServerResponse): void {
    if ((req.method ?? 'GET') !== 'GET') {
      throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Use GET for /admin/tools', { httpStatus: 405 });
    }
    const key = this.requireKey(req, ['master', 'sup']);
    const tools =
      key.keyType === 'master'
        ? this.deps.catalog.repository.listTools()
        : this.deps.catalog.repository.listTools().filter((tool) => this.deps.policy.isToolPermitted(key, tool));
    this.sendJson(res, 200, {
      tools: tools.map((tool) => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        server_id: tool.serverId,
        high_privilege: tool.highPrivilege,
        inputSchema: tool.inputSchema,
      })),
      total: tools.length,
    });
  }

  // -------------------------------------------------------------------------
  // Audit & escalations
  // -------------------------------------------------------------------------

  private listAudit(res: ServerResponse, url: URL): void {
    const status = url.searchParams.get('status');
    this.sendJson(
      res,
      200,
      this.deps.audit.query({
        keyId: url.searchParams.get('keyId') ?? undefined,
        serverId: url.searchParams.get('serverId') ?? undefined,
        toolId: url.searchParams.get('toolId') ?? undefined,
        method: url.searchParams.get('method') ?? undefined,
        status: status === 'ok' || status === 'error' || status === 'denied' ? status : undefined,
        search: url.searchParams.get('search') ?? undefined,
        since: url.searchParams.get('since') ?? undefined,
        until: url.searchParams.get('until') ?? undefined,
        limit: numberParam(url, 'limit', 50),
        offset: numberParam(url, 'offset', 0),
      }),
    );
  }

  private async handleEscalations(req: IncomingMessage, res: ServerResponse, rest: string[], url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    if (rest.length === 0 && method === 'GET') {
      const key = this.requireKey(req, ['master', 'sup']);
      void key;
      const status = url.searchParams.get('status');
      const allowed = status === 'pending' || status === 'approved' || status === 'denied' || status === 'expired';
      this.sendJson(res, 200, {
        escalations: this.deps.escalations.list(allowed ? (status as EscalationStatus) : undefined),
      });
      return;
    }
    if (rest.length === 2 && rest[1]! === 'resolve' && method === 'POST') {
      const key = this.requireKey(req, ['master', 'sup']);
      const body = await readJsonBody(req, this.deps.config.requestBodyLimitBytes);
      this.assertObject(body);
      const status = body.status;
      if (status !== 'approved' && status !== 'denied') throw invalidParams("status must be 'approved' or 'denied'");
      const ticket = this.deps.escalations.resolve(rest[0]!, status, key.name, body.note ? String(body.note) : null);
      this.sendJson(res, 200, { escalation: ticket });
      return;
    }
    throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'Unknown escalation endpoint', { httpStatus: 404 });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private requireKey(req: IncomingMessage, allowed: KeyType[]): AuthenticatedKey {
    const header = req.headers.authorization;
    let plaintext: string | null = null;
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) plaintext = header.slice(7).trim();
    const apiKey = req.headers['x-mcp-api-key'];
    if (!plaintext && typeof apiKey === 'string') plaintext = apiKey.trim();
    if (!plaintext) throw new GatewayError(ErrorCodes.KEY_INVALID, 'Unauthorized: missing API key.', { httpStatus: 401 });
    const key = this.deps.keys.authenticate(plaintext);
    // Master is a superset of every role.
    if (key.keyType === 'master') return key;
    if (!allowed.includes(key.keyType)) {
      throw accessDenied('Access Denied: key type is not permitted for this admin resource.', {
        reason: 'SCOPE_RESTRICTION',
      });
    }
    return key;
  }

  private assertObject(body: unknown): asserts body is Record<string, unknown> {
    if (!isRecord(body)) throw invalidParams('JSON object body required');
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toKeySummary(record: KeySummary): KeySummary {
  const grants: ServerGrant[] = record.serverGrants;
  return { ...record, serverGrants: grants };
}

function numberParam(url: URL, name: string, fallback: number): number {
  const value = Number.parseInt(url.searchParams.get(name) ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}
