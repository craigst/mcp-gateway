/**
 * Vault Warden admin API (v0.2), mounted at `/mcp/v1/admin/vaultwarden` by the
 * main admin router.
 *
 * The Web UI uses this surface to answer:
 *   - is a Vaultwarden MCP server installed, and what tools does it expose?
 *   - which tools are dangerous / approval-gated, and what are the defaults?
 *   - which credential deliveries are waiting for a supervisor decision?
 *   - who called the vault recently (audit log filtered to vault tools)?
 * and to apply the default protection policy in one click.
 *
 * Auth: master key only (bearer token or `X-MCP-API-Key`), same as the rest of
 * the admin API. Secrets never traverse this route: pending tickets only carry
 * the captured call arguments and results are file paths, not secret values.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { accessDenied, ErrorCodes, GatewayError, invalidParams } from '../core/errors.js';
import { nowIso } from '../core/ids.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { GatewayConfig } from '../core/config.js';
import type { AuditService, CatalogService, KeyService } from '../core/ports.js';
import type { AuditEntry, AuthenticatedKey, EscalationTicket, ServerRecord } from '../core/types.js';
import { readJsonBody } from '../gateway/server.js';
import { mapEscalationRow, type EscalationRow } from '../approvals/service.js';
import {
  VAULTWARDEN_DEFAULT_PROTECTION,
  defaultProtectionForTools,
} from '../vaultwarden/defaults.js';
import type { AdminSubRouter } from './types.js';

const BASE_PATH = '/mcp/v1/admin/vaultwarden';
const ACCESS_LOG_LIMIT = 50;
/** Vault tool names surfaced in the access log (`vault_*` / `secrets_*`). */
const VAULT_TOOL_NAME = /^(vault_|secrets_)/;
const VAULTWARDEN_HINT = 'vaultwarden';

export interface VaultwardenApiDeps {
  config: GatewayConfig;
  keys: KeyService;
  catalog: CatalogService;
  audit: AuditService;
  db: DatabaseSync;
  logger?: Logger;
}

export interface VaultwardenToolSummary {
  name: string;
  description: string;
  highPrivilege: boolean;
  approvalRequired: boolean;
}

export interface VaultwardenDefaults {
  approvalTools: string[];
  highPrivilegeTools: string[];
}

export interface VaultwardenOverview {
  installed: boolean;
  serverId?: string;
  serverName?: string;
  status?: string;
  tools?: VaultwardenToolSummary[];
  defaults: VaultwardenDefaults;
  pendingApprovals: EscalationTicket[];
  accessLog: AuditEntry[];
}

export interface VaultwardenProtectResult {
  server: ServerRecord;
  protectedTools: string[];
}

export class VaultwardenApi implements AdminSubRouter {
  private readonly logger: Logger;

  constructor(private readonly deps: VaultwardenApiDeps) {
    this.logger = deps.logger ?? createLogger('vaultwarden');
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname.replace(/\/+$/, '');
    const method = req.method ?? 'GET';

    if (path === BASE_PATH) {
      if (method !== 'GET') throw methodNotAllowed('Use GET for the Vault Warden overview');
      this.requireMasterKey(req);
      this.sendJson(res, 200, this.overview());
      return true;
    }

    if (path === `${BASE_PATH}/protect`) {
      if (method !== 'POST') throw methodNotAllowed('Use POST for the Vault Warden protect action');
      this.requireMasterKey(req);
      const body = await readJsonBody(req, this.deps.config.requestBodyLimitBytes);
      if (!isRecord(body)) throw invalidParams('JSON object body required');
      this.sendJson(res, 200, this.protect(body.serverId));
      return true;
    }

    return false;
  }

  /** Build the read model consumed by the `/vaultwarden` UI route. */
  overview(): VaultwardenOverview {
    const server = this.findVaultwardenServer();
    if (!server) {
      return {
        installed: false,
        tools: [],
        defaults: cloneDefaults(VAULTWARDEN_DEFAULT_PROTECTION),
        pendingApprovals: [],
        accessLog: [],
      };
    }

    const tools = this.deps.catalog.repository.listToolsByServer(server.id);
    const approvalRequired = new Set(server.approvalRequiredTools ?? []);
    const highPrivilege = new Set(server.highPrivilegeTools ?? []);

    return {
      installed: true,
      serverId: server.id,
      serverName: server.name,
      status: server.status,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        highPrivilege: tool.highPrivilege || highPrivilege.has(tool.name) || highPrivilege.has(tool.id),
        approvalRequired: approvalRequired.has(tool.name) || approvalRequired.has(tool.id),
      })),
      defaults: tools.length > 0 ? defaultProtectionForTools(tools) : cloneDefaults(VAULTWARDEN_DEFAULT_PROTECTION),
      pendingApprovals: this.pendingApprovals(server.id),
      accessLog: this.accessLog(server.id),
    };
  }

  /** Apply the default protection sets to a Vaultwarden server (idempotent). */
  protect(serverIdInput: unknown): VaultwardenProtectResult {
    const serverId = typeof serverIdInput === 'string' ? serverIdInput.trim() : '';
    if (!serverId) throw invalidParams('serverId is required');
    const server = this.deps.catalog.repository.getServer(serverId);
    if (!server) throw new GatewayError(ErrorCodes.TOOL_NOT_FOUND, 'Server not found', { httpStatus: 404 });

    const tools = this.deps.catalog.repository.listToolsByServer(serverId);
    // A stopped/never-started server has no discovered tools yet; fall back to
    // the known Vaultwarden tool set so protection can be applied beforehand.
    const protection = tools.length > 0 ? defaultProtectionForTools(tools) : cloneDefaults(VAULTWARDEN_DEFAULT_PROTECTION);
    const updated: ServerRecord = {
      ...server,
      // Union with any manually configured entries: applying defaults must never
      // silently remove existing protection.
      highPrivilegeTools: union(server.highPrivilegeTools ?? [], protection.highPrivilegeTools),
      approvalRequiredTools: union(server.approvalRequiredTools ?? [], protection.approvalTools),
      updatedAt: nowIso(),
    };
    this.deps.catalog.repository.upsertServer(updated);
    this.logger.info('vaultwarden default protection applied', {
      serverId,
      protectedTools: protection.approvalTools,
    });
    return { server: updated, protectedTools: protection.approvalTools };
  }

  private findVaultwardenServer(): ServerRecord | null {
    for (const server of this.deps.catalog.repository.listServers()) {
      const haystack = [server.name, server.manifest?.name ?? null, server.sourceUrl]
        .filter((value): value is string => typeof value === 'string')
        .join(' ')
        .toLowerCase();
      if (haystack.includes(VAULTWARDEN_HINT)) return server;
    }
    return null;
  }

  private pendingApprovals(serverId: string): EscalationTicket[] {
    const rows = this.deps.db
      .prepare(
        `SELECT * FROM escalations
          WHERE ticket_type = 'tool_approval' AND status = 'pending' AND server_id = ?
          ORDER BY created_at DESC, rowid DESC`,
      )
      .all(serverId) as unknown as EscalationRow[];
    return rows.map(mapEscalationRow);
  }

  private accessLog(serverId: string): AuditEntry[] {
    const prefix = `${serverId}:`;
    return this.deps.audit
      .query({ serverId, method: 'tools/call', limit: ACCESS_LOG_LIMIT })
      .entries.filter((entry) => {
        if (typeof entry.toolId !== 'string' || entry.toolId === '') return false;
        const toolName = entry.toolId.startsWith(prefix) ? entry.toolId.slice(prefix.length) : entry.toolId;
        return VAULT_TOOL_NAME.test(toolName);
      });
  }

  private requireMasterKey(req: IncomingMessage): AuthenticatedKey {
    const header = req.headers.authorization;
    let plaintext: string | null = null;
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) plaintext = header.slice(7).trim();
    const apiKey = req.headers['x-mcp-api-key'];
    if (!plaintext && typeof apiKey === 'string') plaintext = apiKey.trim();
    if (!plaintext) {
      throw new GatewayError(ErrorCodes.KEY_INVALID, 'Unauthorized: missing API key.', { httpStatus: 401 });
    }
    const key = this.deps.keys.authenticate(plaintext);
    if (key.keyType !== 'master') {
      throw accessDenied('Access Denied: master key required for Vault Warden administration.', {
        reason: 'SCOPE_RESTRICTION',
      });
    }
    return key;
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }
}

function methodNotAllowed(message: string): GatewayError {
  return new GatewayError(ErrorCodes.METHOD_NOT_FOUND, message, { httpStatus: 405 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function union(existing: string[], next: string[]): string[] {
  return [...new Set([...existing, ...next])];
}

function cloneDefaults(defaults: VaultwardenDefaults): VaultwardenDefaults {
  return {
    approvalTools: [...defaults.approvalTools],
    highPrivilegeTools: [...defaults.highPrivilegeTools],
  };
}
