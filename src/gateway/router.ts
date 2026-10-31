import { ErrorCodes, GatewayError, accessDenied, asGatewayError, invalidParams, toolNotFound } from '../core/errors.js';
import { newRequestId } from '../core/ids.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { GatewayConfig } from '../core/config.js';
import type {
  ApprovalService,
  AuditService,
  CatalogService,
  ComputerUseService,
  DelegationService,
  EscalationService,
  KeyService,
  McpClient,
  PolicyEngine,
  Supervisor,
} from '../core/ports.js';
import type {
  AuthenticatedKey,
  AuthorizationDecision,
  JsonRpcRequest,
  PolicyDenialReason,
  RequestContext,
  ServerRecord,
  ToolDescriptor,
} from '../core/types.js';

export interface RouterDeps {
  config: GatewayConfig;
  keys: KeyService;
  policy: PolicyEngine;
  escalations: EscalationService;
  catalog: CatalogService;
  supervisor: Supervisor;
  delegation: DelegationService;
  audit: AuditService;
  /** Optional tool-approval gating (v0.2). */
  approvals?: ApprovalService;
  /** Optional computer-use availability gate (v0.9). */
  computerUse?: ComputerUseService;
  logger?: Logger;
}

const PROTOCOL_VERSION = '2025-06-18';
const GATEWAY_VERSION = '0.12.0';

/**
 * JSON-RPC method dispatch. Authorization, audit recording and escalation
 * ticket creation all happen here so every discovery vector is uniformly
 * censored at the gateway layer.
 */
export class JsonRpcRouter {
  private readonly logger: Logger;

  constructor(private readonly deps: RouterDeps) {
    this.logger = deps.logger ?? createLogger('router');
  }

  /** Execute one JSON-RPC request. Returns the `result` payload, or undefined for notifications. */
  async handle(ctx: RequestContext, request: JsonRpcRequest): Promise<unknown> {
    const started = performance.now();
    const isNotification = request.id === undefined || request.id === null;
    let status: 'ok' | 'error' | 'denied' = 'ok';
    let errorCode: number | null = null;
    let serverId: string | null = null;
    let toolId: string | null = null;
    let denialReason: string | null = null;

    try {
      const params = asObject(request.params);
      const key = ctx.key;
      if (!key) throw new GatewayError(ErrorCodes.KEY_INVALID, 'Unauthorized: missing API key.', { data: { status: 'UNAUTHORIZED', reason: 'MISSING_KEY' } });

      switch (request.method) {
        case 'initialize':
          return {
            protocolVersion: PROTOCOL_VERSION,
            serverInfo: { name: 'mcp-gateway', version: GATEWAY_VERSION },
            capabilities: {
              tools: { listChanged: true },
              prompts: { listChanged: true },
              resources: { listChanged: true, subscribe: false },
              logging: {},
            },
            instructions:
              'Zero-trust MCP gateway. Use tools/search or tools/list to discover permitted tools; tools/call executes directly.',
            _meta: {
              gateway: {
                key_id: key.id,
                key_type: key.keyType,
                delegation_max_depth: this.deps.config.delegationMaxDepth,
              },
            },
          };

        case 'ping':
          return {};

        case 'notifications/initialized':
          return undefined;

        case 'notifications/cancelled':
          return undefined;

        case 'tools/list': {
          const requestedServer = optionalString(params.serverId, 'serverId');
          const listed = this.deps.catalog.listTools(key, requestedServer ? { serverId: requestedServer } : undefined);
          const visibleTools = listed.tools.filter((tool) => !this.deps.policy.isServerPaused(key, tool.server_id));
          const tools = visibleTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            server_id: tool.server_id,
            tool_id: tool.id,
          }));
          return { tools, total: tools.length };
        }

        case 'tools/search': {
          const query = optionalString(params.query, 'query') ?? '';
          const limit = clampInt(params.limit, 1, 100, 20);
          const requestedServer = optionalString(params.serverId, 'serverId');
          if (requestedServer) {
            if (
              !this.deps.policy.isServerPermitted(key, requestedServer) ||
              this.deps.policy.isServerPaused(key, requestedServer)
            ) {
              // Do not disclose whether the server exists.
              return { tools: [], total: 0, censored: true };
            }
            const result = this.deps.catalog.searchTools(key, query, 100);
            const filtered = result.tools.filter((tool) => tool.server_id === requestedServer).slice(0, limit);
            return { tools: filtered, total: filtered.length, censored: true };
          }
          return this.deps.catalog.searchTools(key, query, limit);
        }

        case 'servers/list_permitted':
          return {
            servers: this.deps.catalog
              .listPermittedServers(key)
              .filter((server) => !this.deps.policy.isServerPaused(key, server.id)),
          };

        case 'tools/call': {
          const name = requiredString(params.name, 'name');
          const requestedServer = optionalString(params.serverId, 'serverId');
          const args = asObject(params.arguments ?? {});
          // Attribute the audit row to the server even when resolution/denial
          // throws (unknown tool, high-privilege denial), so the inspector can
          // show failed and denied requests per server.
          if (requestedServer) serverId = requestedServer;
          const tool = this.resolveTool(key, name, requestedServer);
          serverId = tool.serverId;
          toolId = tool.id;

          const decision = this.deps.policy.evaluateCall(key, tool, args);
          if (!decision.allowed) {
            throw await this.deny(ctx, tool, decision);
          }

          // v0.9: operator availability for computer use. A paused computer
          // refuses the call outright, before approvals or upstream dispatch —
          // a queued click would land on whatever is under it later.
          const computerUse = this.deps.computerUse?.checkCall(tool, args);
          if (computerUse && !computerUse.allowed) {
            throw new GatewayError(
              ErrorCodes.ACCESS_DENIED,
              computerUse.message ?? 'Computer use is currently unavailable.',
              {
                data: {
                  status: 'COMPUTER_UNAVAILABLE',
                  reason: computerUse.reason ?? 'COMPUTER_USE_PAUSED',
                  tool_id: tool.id,
                  server_id: tool.serverId,
                  details: {
                    computer_id: computerUse.computerId ?? null,
                    resume_at: computerUse.until ?? null,
                  },
                },
              },
            );
          }

          const approvals = this.deps.approvals;
          if (approvals?.requiresApproval(tool.serverId, tool.name)) {
            const meta = asObject(params._meta ?? {});
            const supplied = typeof meta.escalation_ticket === 'string' ? meta.escalation_ticket : ctx.headers['x-mcp-escalation-ticket'];
            if (!supplied) {
              const ticket = approvals.createToolApproval({
                key,
                serverId: tool.serverId,
                toolId: tool.id,
                toolName: tool.name,
                arguments: args,
                requestId: ctx.requestId,
              });
              throw new GatewayError(
                ErrorCodes.ESCALATION_REQUIRED,
                `Approval required: '${tool.name}' needs a supervisor ticket before execution.`,
                {
                  data: {
                    status: 'ESCALATION_REQUIRED',
                    reason: 'APPROVAL_REQUIRED',
                    ticket_id: ticket.ticketId,
                    escalation_supported: true,
                    tool_id: tool.id,
                    server_id: tool.serverId,
                  },
                },
              );
            }
            const approval = approvals.takeResult(supplied, key.id, tool.id);
            if (approval.state === 'approved' && approval.result !== undefined && approval.result !== null) {
              return approval.result;
            }
            throw new GatewayError(
              ErrorCodes.ESCALATION_REQUIRED,
              `Approval ticket '${supplied}' is ${approval.state}.`,
              {
                data: {
                  status: 'ESCALATION_REQUIRED',
                  reason: 'APPROVAL_PENDING',
                  ticket_id: supplied,
                  escalation_supported: true,
                  tool_id: tool.id,
                  server_id: tool.serverId,
                },
              },
            );
          }

          if (this.deps.supervisor.status(tool.serverId) !== 'running') {
            await this.deps.supervisor.start(tool.serverId);
          }
          const client = this.deps.supervisor.client(tool.serverId);
          if (!client) throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, `Server '${tool.serverId}' is unavailable`);

          const callStarted = performance.now();
          const result = await client.callTool(tool.name, args, {
            timeoutMs: this.deps.config.defaultToolTimeoutMs,
            meta: { trace_id: ctx.requestId, key_id: key.id, delegation_depth: ctx.delegationDepth },
          });
          const subServerMs = Number((performance.now() - callStarted).toFixed(2));
          return {
            ...result,
            _meta: {
              server_id: tool.serverId,
              tool_id: tool.id,
              sub_server_ms: subServerMs,
              gateway_overhead_ms: Number((performance.now() - started).toFixed(2)),
              delegation_depth: ctx.delegationDepth,
            },
          };
        }

        case 'prompts/list': {
          const requestedServer = optionalString(params.serverId, 'serverId');
          return this.listPromptCollection(key, requestedServer);
        }

        case 'prompts/get': {
          const name = requiredString(params.name, 'name');
          const args = asObject(params.arguments ?? {});
          const requestedServer = optionalString(params.serverId, 'serverId');
          const server = this.resolveCapabilityServer(key, requestedServer, (record) =>
            (record.prompts ?? []).some((prompt) => prompt.name === name),
          );
          serverId = server.id;
          const client = await this.ensureClient(server.id);
          if (typeof client.getPrompt !== 'function') {
            throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'This server does not expose MCP prompts');
          }
          return client.getPrompt(name, args);
        }

        case 'resources/list': {
          const requestedServer = optionalString(params.serverId, 'serverId');
          return this.listResourceCollection(key, requestedServer);
        }

        case 'resources/templates/list': {
          const requestedServer = optionalString(params.serverId, 'serverId');
          if (requestedServer) {
            if (!this.deps.policy.isServerPermitted(key, requestedServer)) throw toolNotFound();
            serverId = requestedServer;
            const client = await this.ensureClient(requestedServer);
            if (typeof client.listResourceTemplates !== 'function') return { resourceTemplates: [] };
            const templates = await client.listResourceTemplates();
            return { resourceTemplates: templates };
          }
          const templates: unknown[] = [];
          for (const server of this.visibleServers(key)) {
            const client = this.deps.supervisor.client(server.id);
            if (!client || typeof client.listResourceTemplates !== 'function') continue;
            try {
              for (const template of await client.listResourceTemplates()) {
                templates.push({ ...template, server_id: server.id });
              }
            } catch {
              // best effort
            }
          }
          return { resourceTemplates: templates };
        }

        case 'resources/read': {
          const uri = requiredString(params.uri, 'uri');
          const requestedServer = optionalString(params.serverId, 'serverId');
          const server = this.resolveCapabilityServer(key, requestedServer, (record) =>
            (record.resources ?? []).some((resource) => resource.uri === uri),
          );
          serverId = server.id;
          const client = await this.ensureClient(server.id);
          if (typeof client.readResource !== 'function') {
            throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, 'This server does not expose MCP resources');
          }
          return client.readResource(uri);
        }

        case 'agents/delegate': {
          if (!this.deps.policy.canDelegate(key)) {
            throw accessDenied('Access Denied: key has no delegation claim.', { reason: 'DELEGATION_NOT_PERMITTED' });
          }
          const targetId = requiredString(params.targetId, 'targetId');
          const mode = params.mode === 'observe_and_verify' ? 'observe_and_verify' : 'delegate';
          const result = await this.deps.delegation.delegate(
            key,
            { targetId, payload: params.payload ?? {}, mode },
            { depth: ctx.delegationDepth, parentRequestId: ctx.requestId },
          );
          return {
            target_id: result.targetId,
            status: result.status,
            verdict: result.verdict,
            approval_token: result.approvalToken,
            output: result.output,
            latency_ms: result.latencyMs,
            depth: result.depth,
            trace_id: result.traceId,
          };
        }

        case 'escalations/request': {
          if (!this.deps.policy.canEscalate(key)) {
            throw accessDenied('Access Denied: key cannot request escalation.', { reason: 'ESCALATION_NOT_PERMITTED' });
          }
          const ticket = this.deps.escalations.create({
            key,
            toolId: optionalString(params.toolId, 'toolId') ?? null,
            serverId: optionalString(params.serverId, 'serverId') ?? null,
            reason: (optionalString(params.reason, 'reason') ?? 'HIGH_PRIVILEGE_RESTRICTION') as PolicyDenialReason,
            requestPayload: params.requestPayload ?? null,
          });
          return { ticket_id: ticket.ticketId, status: ticket.status, created_at: ticket.createdAt };
        }

        default:
          throw new GatewayError(ErrorCodes.METHOD_NOT_FOUND, `Method not found: ${request.method}`, {
            data: { status: 'METHOD_NOT_FOUND' },
          });
      }
    } catch (error) {
      const gatewayError = asGatewayError(error);
      status = gatewayError.code === ErrorCodes.ACCESS_DENIED ? 'denied' : 'error';
      errorCode = gatewayError.code;
      const reason = (gatewayError.data as { reason?: unknown } | undefined)?.reason;
      if (typeof reason === 'string') denialReason = reason;
      if (status === 'error' && gatewayError.code === ErrorCodes.INTERNAL_ERROR) {
        this.logger.error('jsonrpc method failed', { method: request.method, error: gatewayError.message });
      }
      throw gatewayError;
    } finally {
      if (!isNotification || status !== 'ok') {
        try {
          this.deps.audit.record({
            requestId: ctx.requestId,
            keyId: ctx.key?.id ?? null,
            method: request.method,
            serverId,
            toolId,
            status,
            latencyMs: Number((performance.now() - started).toFixed(2)),
            errorCode,
            delegationDepth: ctx.delegationDepth,
            parentId: ctx.parentAuditId,
            payload:
              denialReason === null
                ? (request.params ?? null)
                : { ...(asObject(request.params ?? {})), denial_reason: denialReason },
          });
        } catch (auditError) {
          this.logger.warn('audit record failed', { error: String(auditError) });
        }
      }
    }
  }

  private async ensureClient(serverId: string): Promise<McpClient> {
    if (this.deps.supervisor.status(serverId) !== 'running') {
      await this.deps.supervisor.start(serverId);
    }
    const client = this.deps.supervisor.client(serverId);
    if (!client) throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, `Server '${serverId}' is unavailable`);
    return client;
  }

  private visibleServers(key: AuthenticatedKey): ServerRecord[] {
    return this.deps.catalog.repository
      .listServers()
      .filter(
        (server) =>
          this.deps.policy.isServerPermitted(key, server.id) && !this.deps.policy.isServerPaused(key, server.id),
      );
  }

  private resolveCapabilityServer(
    key: AuthenticatedKey,
    requestedServer: string | undefined,
    predicate: (server: ServerRecord) => boolean,
  ): ServerRecord {
    if (requestedServer) {
      const server = this.deps.catalog.repository.getServer(requestedServer);
      if (
        !server ||
        !this.deps.policy.isServerPermitted(key, requestedServer) ||
        this.deps.policy.isServerPaused(key, requestedServer)
      ) {
        throw toolNotFound();
      }
      return server;
    }
    const match = this.visibleServers(key).find(predicate);
    if (!match) throw toolNotFound();
    return match;
  }

  private async listPromptCollection(
    key: AuthenticatedKey,
    requestedServer?: string,
  ): Promise<{ prompts: unknown[]; total: number }> {
    const prompts: unknown[] = [];
    const servers = requestedServer
      ? this.visibleServers(key).filter((server) => server.id === requestedServer)
      : this.visibleServers(key);
    if (requestedServer && servers.length === 0) throw toolNotFound();
    for (const server of servers) {
      const client = this.deps.supervisor.client(server.id);
      if (!client || typeof client.listPrompts !== 'function') continue;
      try {
        for (const prompt of await client.listPrompts()) {
          prompts.push({ ...prompt, server_id: server.id });
        }
      } catch {
        // best effort; discovery stored whatever the server advertised at start
      }
    }
    return { prompts, total: prompts.length };
  }

  private async listResourceCollection(
    key: AuthenticatedKey,
    requestedServer?: string,
  ): Promise<{ resources: unknown[]; total: number }> {
    const resources: unknown[] = [];
    const servers = requestedServer
      ? this.visibleServers(key).filter((server) => server.id === requestedServer)
      : this.visibleServers(key);
    if (requestedServer && servers.length === 0) throw toolNotFound();
    for (const server of servers) {
      const client = this.deps.supervisor.client(server.id);
      if (!client || typeof client.listResources !== 'function') continue;
      try {
        for (const resource of await client.listResources()) {
          resources.push({ ...resource, server_id: server.id });
        }
      } catch {
        // best effort
      }
    }
    return { resources, total: resources.length };
  }

  /** Resolve a tool name to a visible tool, enforcing anti-probing semantics. */
  private resolveTool(key: AuthenticatedKey, name: string, serverId?: string): ToolDescriptor {
    const repository = this.deps.catalog.repository;
    // Server-level grants are checked FIRST so an unpermitted server can never
    // leak tool existence (including high-privilege tools) through denials.
    const candidates = (
      serverId
        ? repository.listToolsByServer(serverId)
        : repository.listTools()
    ).filter(
      (tool) =>
        (tool.name === name || tool.id === name) && this.deps.policy.isServerPermitted(key, tool.serverId),
    );

    const visible = candidates.find((tool) => this.deps.policy.isToolPermitted(key, tool));
    if (visible) return visible;

    const hiddenHighPrivilege = candidates.find((tool) => tool.highPrivilege);
    if (hiddenHighPrivilege) {
      // Structured denial is safe here: the key is explicitly allowed to know
      // high-privilege tools exist, it just lacks a signed grant.
      return this.denySync(key, hiddenHighPrivilege, {
        allowed: false,
        reason: 'HIGH_PRIVILEGE_RESTRICTION',
        detail: `Agent '${key.name}' lacks an explicit grant for '${hiddenHighPrivilege.name}'.`,
      });
    }
    // Unknown or invisible: indistinguishable response.
    throw toolNotFound();
  }

  private denySync(key: AuthenticatedKey, tool: ToolDescriptor, decision: AuthorizationDecision): never {
    let ticketId: string | undefined;
    if (decision.reason === 'HIGH_PRIVILEGE_RESTRICTION' && this.deps.policy.canEscalate(key)) {
      const ticket = this.deps.escalations.create({
        key,
        toolId: tool.id,
        serverId: tool.serverId,
        reason: 'HIGH_PRIVILEGE_RESTRICTION',
        requestPayload: null,
      });
      ticketId = ticket.ticketId;
    }
    throw accessDenied(
      decision.detail ??
        `Access Denied: Agent '${key.name}' lacks permission for '${tool.name}'.`,
      {
        reason: decision.reason ?? 'TOOL_NOT_PERMITTED',
        ticketId,
        escalationSupported: Boolean(ticketId),
        toolId: tool.id,
        serverId: tool.serverId,
      },
    );
  }

  private async deny(ctx: RequestContext, tool: ToolDescriptor, decision: AuthorizationDecision): Promise<GatewayError> {
    const key = ctx.key;
    if (!key) return accessDenied('Access Denied: missing key.', { reason: 'TOKEN_NOT_PERMITTED' });
    try {
      return this.denySync(key, tool, decision);
    } catch (error) {
      return error instanceof GatewayError ? error : internalDenial(tool);
    }
  }
}

function internalDenial(tool: ToolDescriptor): GatewayError {
  return accessDenied('Access Denied.', { toolId: tool.id, serverId: tool.serverId });
}

export function createRequestContext(
  key: AuthenticatedKey | null,
  headers: Record<string, string>,
  clientIp: string | null,
): RequestContext {
  const depthRaw = headers['x-mcp-delegation-depth'];
  const parsedDepth = depthRaw ? Number.parseInt(depthRaw, 10) : 0;
  return {
    requestId: newRequestId(),
    key,
    delegationDepth: Number.isFinite(parsedDepth) && parsedDepth > 0 ? parsedDepth : 0,
    parentAuditId: null,
    headers,
    clientIp,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw invalidParams('params must be an object');
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalidParams(`'${field}' is required`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalidParams(`'${field}' must be a string`);
  return value;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
