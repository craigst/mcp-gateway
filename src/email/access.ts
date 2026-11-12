/**
 * Email access administration (v0.15).
 *
 * The email subsystem is one MCP server for every mailbox, so "who can read
 * this mail" has two layers:
 *
 *  1. the gateway server grant (`email` in the key's `serverGrants`, with a
 *     whole-grant `paused` switch) — can the key reach the server at all;
 *  2. the per-account decisions in `EmailAccountAccessStore` — which mailbox
 *     a key may use once it has reached the server.
 *
 * This service turns both layers into one operator-facing overview, and applies
 * toggles atomically through the normal `KeyService` custody path. Bots are
 * resolved from the `omb` MCP server; a bot is bound to the gateway key it uses
 * (`omb-<slug>`), which is how a bot's email access is visible and switchable.
 */
import type { DatabaseSync } from 'node:sqlite';

import { ErrorCodes, GatewayError, invalidParams } from '../core/errors.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { AuditService, CatalogRepository, KeyService } from '../core/ports.js';
import type { ApiKeyRecord, ServerGrant, ServerRecord, ToolDescriptor } from '../core/types.js';
import type { EmailAccessOverview, EmailAccessSubject, EmailAccessUpdateResult } from './types.js';
import type { EmailService } from './service.js';
import { EmailAccountAccessStore } from './access-store.js';

/** One bot as reported by the `omb` MCP server (`omb_bots`). */
export interface EmailAccessBot {
  id: string;
  name: string;
  title?: string | null;
  /** OMB MCP server entries, e.g. `["gateway-cleo"]`. */
  mcpServers?: string[];
}

export type EmailBotLister = () => Promise<EmailAccessBot[]>;

export interface EmailAccessServiceDeps {
  db: DatabaseSync;
  keys: KeyService;
  email: EmailService;
  repository: CatalogRepository;
  /** Resolves OMB bots. Optional: without it the overview only lists keys. */
  listBots?: EmailBotLister;
  audit?: AuditService;
  logger?: Logger;
}

const EMAIL_SERVER_NAME = 'email';
const BOT_KEY_PREFIX = 'omb-';
const BOT_LIST_TTL_MS = 20_000;

/**
 * The email tools that write or destroy mail. They are the server's
 * high-privilege set, so a grant names them explicitly instead of inheriting
 * them from a wildcard. (The email server registration should carry the same
 * list in `highPrivilegeTools`; this constant keeps the access controller
 * correct even for a record registered without it.)
 */
export const EMAIL_HIGH_PRIVILEGE_TOOLS = [
  'email_move',
  'email_delete',
  'email_send',
  'email_reply',
] as const;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function keyNotFound(id: string): GatewayError {
  return new GatewayError(ErrorCodes.TOOL_NOT_FOUND, `API key '${id}' was not found`, {
    httpStatus: 404,
  });
}

/** Build the grant that gives a key the complete email tool surface. */
export function buildEmailServerGrant(server: ServerRecord, tools: ToolDescriptor[]): ServerGrant {
  const highNames = new Set<string>([
    ...EMAIL_HIGH_PRIVILEGE_TOOLS,
    ...(server.highPrivilegeTools ?? []),
    ...tools.filter((tool) => tool.highPrivilege).map((tool) => tool.name),
  ]);
  if (tools.length === 0) {
    // Discovery has not run yet: `tools: null` grants every non-high tool and
    // the explicit high-privilege list keeps the destructive tools opt-in.
    return {
      serverId: server.id,
      tools: null,
      highPrivilegeTools: [...highNames],
    };
  }
  return {
    serverId: server.id,
    tools: tools.filter((tool) => !highNames.has(tool.name)).map((tool) => tool.name),
    highPrivilegeTools: tools.filter((tool) => highNames.has(tool.name)).map((tool) => tool.name),
  };
}

function isGrantPaused(grant: ServerGrant | undefined): boolean {
  return grant?.paused === true;
}

export class EmailAccessService {
  private readonly db: DatabaseSync;
  private readonly keys: KeyService;
  private readonly email: EmailService;
  private readonly repository: CatalogRepository;
  private readonly listBots: EmailBotLister | null;
  private readonly audit: AuditService | null;
  private readonly logger: Logger;
  readonly accountAccess: EmailAccountAccessStore;
  private botCache: { at: number; bots: EmailAccessBot[] } | null = null;

  constructor(deps: EmailAccessServiceDeps) {
    this.db = deps.db;
    this.keys = deps.keys;
    this.email = deps.email;
    this.repository = deps.repository;
    this.listBots = deps.listBots ?? null;
    this.audit = deps.audit ?? null;
    this.logger = deps.logger ?? createLogger('email.access');
    this.accountAccess = new EmailAccountAccessStore(deps.db);
  }

  private emailServer(): ServerRecord | null {
    return (
      this.repository.getServerByName(EMAIL_SERVER_NAME) ??
      this.repository.listServers().find((server) => server.name === EMAIL_SERVER_NAME) ??
      null
    );
  }

  private requireEmailServer(): ServerRecord {
    const server = this.emailServer();
    if (server === null) {
      throw new GatewayError(ErrorCodes.TOOL_NOT_FOUND, 'The email MCP server is not registered', {
        httpStatus: 404,
      });
    }
    return server;
  }

  private toolsFor(serverId: string): ToolDescriptor[] {
    return this.repository.listToolsByServer(serverId);
  }

  private async bots(): Promise<EmailAccessBot[]> {
    if (this.listBots === null) return [];
    const now = Date.now();
    if (this.botCache !== null && now - this.botCache.at < BOT_LIST_TTL_MS) return this.botCache.bots;
    try {
      const bots = await this.listBots();
      this.botCache = { at: now, bots };
      return bots;
    } catch (error) {
      this.logger.warn('could not resolve OMB bots for email access', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Keep serving keys even when OMB is unreachable; retry on the next call.
      this.botCache = { at: now, bots: [] };
      return [];
    }
  }

  private countGrantedTools(grant: ServerGrant | undefined, tools: ToolDescriptor[]): number {
    if (grant === undefined) return 0;
    const pausedTools = new Set(grant.pausedTools ?? []);
    const whitelist = grant.tools === undefined || grant.tools === null ? null : new Set(grant.tools);
    const high = new Set(grant.highPrivilegeTools ?? []);
    if (tools.length === 0) {
      return (grant.tools?.length ?? 0) + (grant.highPrivilegeTools?.length ?? 0);
    }
    return tools.filter((tool) => {
      if (pausedTools.has(tool.name)) return false;
      if (tool.highPrivilege) return high.has(tool.name);
      return whitelist === null || whitelist.has(tool.name);
    }).length;
  }

  private accountMap(keyId: string | null, record: ApiKeyRecord | null): Record<string, boolean> {
    const accounts = this.email.listAccounts();
    if (keyId === null || record === null) {
      return Object.fromEntries(accounts.map((account) => [account.id, false]));
    }
    if (record.keyType === 'master') {
      return Object.fromEntries(accounts.map((account) => [account.id, true]));
    }
    const decisions = this.accountAccess.decisionsFor(keyId);
    return Object.fromEntries(
      accounts.map((account) => [account.id, decisions.get(account.id) ?? true]),
    );
  }

  private subjectForKey(
    record: ApiKeyRecord,
    accountMap?: Record<string, boolean>,
  ): EmailAccessSubject {
    const server = this.emailServer();
    const tools = server === null ? [] : this.toolsFor(server.id);
    const grant = server === null ? undefined : record.serverGrants.find((entry) => entry.serverId === server.id);
    const locked = record.keyType === 'master';
    const revoked = record.revokedAt !== null;
    const emailGranted = locked || grant !== undefined;
    const emailPaused = !locked && isGrantPaused(grant);
    const emailEnabled = locked || (!revoked && emailGranted && !emailPaused);
    return {
      id: `key:${record.id}`,
      kind: 'key',
      name: record.name,
      title: null,
      slug: null,
      botId: null,
      keyId: record.id,
      keyName: record.name,
      keyType: record.keyType,
      keyPrefix: record.keyPrefix,
      emailGranted,
      emailPaused,
      emailEnabled,
      grantedToolCount: locked ? tools.length : this.countGrantedTools(grant, tools),
      totalToolCount: tools.length,
      lastUsedAt: record.lastUsedAt,
      revoked,
      locked,
      accounts: accountMap ?? this.accountMap(record.id, record),
    };
  }

  private subjectForBot(bot: EmailAccessBot, record: ApiKeyRecord | null): EmailAccessSubject {
    const server = this.emailServer();
    const tools = server === null ? [] : this.toolsFor(server.id);
    const slug = slugify(bot.name);
    if (record === null) {
      return {
        id: `bot:${bot.id}`,
        kind: 'bot',
        name: bot.name,
        title: bot.title ?? null,
        slug,
        botId: bot.id,
        keyId: null,
        keyName: null,
        keyType: null,
        keyPrefix: null,
        emailGranted: false,
        emailPaused: false,
        emailEnabled: false,
        grantedToolCount: 0,
        totalToolCount: tools.length,
        lastUsedAt: null,
        revoked: false,
        locked: false,
        accounts: Object.fromEntries(this.email.listAccounts().map((account) => [account.id, false])),
      };
    }
    const key = this.subjectForKey(record);
    return {
      ...key,
      id: `bot:${bot.id}`,
      kind: 'bot',
      name: bot.name,
      title: bot.title ?? null,
      slug,
      botId: bot.id,
    };
  }

  /** Map a bot to the gateway key named `omb-<slug>` (current, non-revoked). */
  private botKeyName(bot: EmailAccessBot): string | null {
    const candidates: string[] = [];
    for (const entry of bot.mcpServers ?? []) {
      if (entry.startsWith('gateway-')) candidates.push(entry.slice('gateway-'.length));
      else if (entry.startsWith('gateway_')) candidates.push(entry.slice('gateway_'.length));
    }
    const slug = slugify(bot.name);
    if (!candidates.includes(slug)) candidates.push(slug);
    for (const candidate of candidates) {
      const name = `${BOT_KEY_PREFIX}${slugify(candidate)}`;
      const match = this.keyForBotName(name);
      if (match !== null) return match.name;
    }
    return null;
  }

  private keyForBotName(name: string): ApiKeyRecord | null {
    const matches = this.keys
      .list()
      .filter((record) => record.revokedAt === null && record.name === name)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return matches[0] ?? null;
  }

  async overview(): Promise<EmailAccessOverview> {
    const server = this.emailServer();
    const tools = server === null ? [] : this.toolsFor(server.id);
    const accounts = this.email.listAccounts().map((account) => ({
      id: account.id,
      name: account.name,
      email: account.email,
      isDefault: account.isDefault,
      enabled: account.enabled,
    }));

    const records = this.keys.list();
    const active = new Map<string, ApiKeyRecord>();
    for (const record of records) {
      if (record.revokedAt === null) active.set(record.id, record);
    }

    const botRows = await this.bots();
    const usedKeyIds = new Set<string>();
    const bots: EmailAccessSubject[] = botRows.map((bot) => {
      const keyName = this.botKeyName(bot);
      const record = keyName === null ? null : this.keyForBotName(keyName);
      if (record !== null) usedKeyIds.add(record.id);
      return this.subjectForBot(bot, record);
    });

    const keys: EmailAccessSubject[] = records
      .filter((record) => record.revokedAt === null && !usedKeyIds.has(record.id))
      .map((record) => this.subjectForKey(record));

    return {
      server:
        server === null
          ? null
          : {
              id: server.id,
              name: server.name,
              status: server.status,
              toolCount: tools.length,
              highPrivilegeTools: tools.filter((tool) => tool.highPrivilege).map((tool) => tool.name),
            },
      accounts,
      bots,
      keys,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Toggle server-level and/or per-account access for one API key. */
  updateKeyAccess(
    keyId: string,
    input: { enabled?: boolean; accounts?: Record<string, boolean> },
    actorKeyId: string | null = null,
  ): EmailAccessUpdateResult {
    const record = this.keys.get(keyId);
    if (record === null) throw keyNotFound(keyId);
    if (record.revokedAt !== null) {
      throw invalidParams('A revoked API key cannot be given email access.');
    }
    if (record.keyType === 'master') {
      throw invalidParams('A master key always has email access and cannot be switched off.');
    }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw invalidParams('email access update must be an object');
    }

    const server = this.requireEmailServer();
    const tools = this.toolsFor(server.id);
    const grants: ServerGrant[] = record.serverGrants.map((grant) => ({ ...grant }));
    let index = grants.findIndex((grant) => grant.serverId === server.id);

    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw invalidParams('"enabled" must be a boolean');
      if (input.enabled) {
        if (index === -1) {
          grants.push(buildEmailServerGrant(server, tools));
          index = grants.length - 1;
        } else {
          const grant = grants[index] as ServerGrant;
          delete grant.paused;
        }
      } else if (index !== -1) {
        const grant = grants[index] as ServerGrant;
        grant.paused = true;
      }
    }

    if (input.accounts !== undefined) {
      if (input.accounts === null || typeof input.accounts !== 'object' || Array.isArray(input.accounts)) {
        throw invalidParams('"accounts" must be an object of accountId -> boolean');
      }
      const known = new Set(this.email.listAccounts().map((account) => account.id));
      const decisions: Array<[string, boolean]> = [];
      for (const [accountId, allowed] of Object.entries(input.accounts)) {
        if (!known.has(accountId)) throw invalidParams(`Unknown email account '${accountId}'.`);
        if (typeof allowed !== 'boolean') {
          throw invalidParams(`"accounts.${accountId}" must be a boolean`);
        }
        decisions.push([accountId, allowed]);
      }
      if (decisions.length > 0) {
        // Choosing mailboxes implies access to the server itself.
        if (index === -1 && decisions.some(([, allowed]) => allowed)) {
          grants.push(buildEmailServerGrant(server, tools));
        }
        for (const [accountId, allowed] of decisions) {
          if (allowed) this.accountAccess.clear(keyId, accountId);
          else this.accountAccess.set(keyId, accountId, false);
        }
      }
    }

    const updated = this.keys.update(keyId, { serverGrants: grants });
    const grant = updated.serverGrants.find((entry) => entry.serverId === server.id);
    const emailGranted = grant !== undefined;
    const emailPaused = isGrantPaused(grant);
    const emailEnabled = emailGranted && !emailPaused;

    this.audit?.record({
      requestId: null,
      keyId: actorKeyId,
      method: 'admin.email.access',
      serverId: server.id,
      toolId: null,
      status: 'ok',
      latencyMs: 0,
      payload: {
        targetKeyId: keyId,
        targetKeyName: updated.name,
        enabled: input.enabled,
        accounts: input.accounts,
      },
    });
    this.logger.info('email access updated', {
      keyId,
      keyName: updated.name,
      enabled: input.enabled,
      accounts: input.accounts,
    });

    return {
      key: {
        id: updated.id,
        name: updated.name,
        emailGranted,
        emailPaused,
        emailEnabled,
        accounts: this.accountMap(updated.id, updated),
      },
    };
  }

  /** Accounts a key may use, keyed by account id (used by the MCP server). */
  accountsFor(keyId: string): Record<string, boolean> {
    const record = this.keys.get(keyId);
    return this.accountMap(keyId, record);
  }
}
