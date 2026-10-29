/**
 * In-process MCP client for the Computer Broker.
 *
 * The broker's `/mcp` endpoint is a Streamable-HTTP JSON-RPC surface. Rather
 * than teaching the generic HTTP transport about bearer tokens and the
 * broker's TLS trust, the gateway fronts it with this small adapter: the
 * supervisor treats it like any other `McpClient`, and every call still flows
 * through the gateway's RBAC, guardrail and audit layers.
 *
 * Tool-level errors are passed through as `isError: true` results (the broker
 * reports a refusal honestly, with its reason), never as a successful text.
 */
import { ErrorCodes, GatewayError } from '../core/errors.js';
import type { McpCallResult, McpClient, McpInitializeResult, RawToolDefinition } from '../core/ports.js';
import type { ComputerUseBrokerPort } from '../core/ports.js';

export interface BrokerMcpClientOptions {
  serverId: string;
  version?: string;
  instructions?: string;
}

const PROTOCOL_VERSION = '2025-06-18';

export class BrokerMcpClient implements McpClient {
  readonly serverId: string;
  private readonly broker: ComputerUseBrokerPort;
  private readonly version: string;
  private readonly instructions: string;

  constructor(broker: ComputerUseBrokerPort, options: BrokerMcpClientOptions) {
    this.broker = broker;
    this.serverId = options.serverId;
    this.version = options.version ?? '1.0.0';
    this.instructions =
      options.instructions ??
      'Computer use via the Computer Broker. Availability is managed by the gateway operator; ' +
        'calls are refused while computer use is paused and are never queued.';
  }

  async initialize(): Promise<McpInitializeResult> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: 'computer-broker', version: this.version },
      capabilities: { tools: { listChanged: false } },
      instructions: this.instructions,
    };
  }

  async listTools(): Promise<RawToolDefinition[]> {
    const result = await this.broker.rpc('tools/list', {});
    const tools = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
    return tools.filter(isRecord).map((tool) => ({
      name: String(tool.name ?? ''),
      description: String(tool.description ?? ''),
      inputSchema: isRecord(tool.inputSchema)
        ? (tool.inputSchema as RawToolDefinition['inputSchema'])
        : { type: 'object' },
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number; meta?: Record<string, unknown> },
  ): Promise<McpCallResult> {
    const params: Record<string, unknown> = { name, arguments: args };
    if (options?.meta) params._meta = options.meta;
    const result = await this.broker.rpc('tools/call', params, options?.timeoutMs);
    if (!isRecord(result) || !Array.isArray(result.content)) {
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, 'Computer Broker returned an invalid tool result.', {
        data: { status: 'UPSTREAM_ERROR', reason: 'BROKER_MCP_SHAPE' },
        httpStatus: 502,
      });
    }
    return {
      content: result.content,
      isError: result.isError === true,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    };
  }

  notify(): void {
    // The broker exposes no subscriptions; nothing to send.
  }

  async close(): Promise<void> {
    // HTTP is stateless here; there is no session to terminate.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
