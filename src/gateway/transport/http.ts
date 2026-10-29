import { GatewayError, ErrorCodes } from '../../core/errors.js';
import { createLogger, type Logger } from '../../core/logger.js';
import type {
  McpCallResult,
  McpClient,
  McpInitializeResult,
  RawPromptDefinition,
  RawResourceDefinition,
  RawResourceTemplateDefinition,
  RawToolDefinition,
} from '../../core/ports.js';

export interface HttpClientOptions {
  serverId: string;
  url: string;
  headers?: Record<string, string>;
  logger?: Logger;
  requestTimeoutMs?: number;
  clientInfo?: { name: string; version: string };
}

const PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcEnvelope {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * MCP client for remote servers exposed over HTTP (Streamable HTTP transport).
 * Supports JSON and SSE-encoded responses and session-id propagation.
 */
export class HttpMcpClient implements McpClient {
  readonly serverId: string;
  private sessionId: string | null = null;
  private nextId = 1;
  private readonly logger: Logger;
  private serverInfo: { name: string; version: string } = { name: 'unknown', version: '0.0.0' };

  constructor(private readonly options: HttpClientOptions) {
    this.serverId = options.serverId;
    this.logger = options.logger ?? createLogger('http-transport');
  }

  async initialize(): Promise<McpInitializeResult> {
    const result = await this.request<McpInitializeResult>('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.options.clientInfo ?? { name: 'mcp-gateway', version: '0.8.0' },
    });
    this.serverInfo = result?.serverInfo ?? this.serverInfo;
    this.notify('notifications/initialized', {});
    return {
      protocolVersion: result?.protocolVersion ?? PROTOCOL_VERSION,
      serverInfo: this.serverInfo,
      capabilities: result?.capabilities ?? {},
      instructions: typeof result?.instructions === 'string' ? result.instructions : null,
    };
  }

  async listTools(): Promise<RawToolDefinition[]> {
    const result = await this.request<{ tools?: RawToolDefinition[] }>('tools/list', {});
    return (result?.tools ?? []).map((tool) => ({
      name: String(tool.name),
      description: String(tool.description ?? ''),
      inputSchema: (tool.inputSchema ?? { type: 'object' }) as RawToolDefinition['inputSchema'],
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number; meta?: Record<string, unknown> },
  ): Promise<McpCallResult> {
    const params: Record<string, unknown> = { name, arguments: args };
    if (options?.meta) params._meta = options.meta;
    return this.request<McpCallResult>('tools/call', params, options?.timeoutMs);
  }

  async listPrompts(): Promise<RawPromptDefinition[]> {
    const result = await this.request<{ prompts?: unknown }>('prompts/list', {});
    return toArray(result?.prompts)
      .filter(isRecord)
      .map((prompt) => ({
        name: asString(prompt.name),
        description: asString(prompt.description),
        arguments: toArray(prompt.arguments)
          .filter(isRecord)
          .map((argument) => {
            const mapped: RawPromptDefinition['arguments'][number] = {
              name: asString(argument.name),
            };
            if (argument.description !== undefined) {
              mapped.description = asString(argument.description);
            }
            if (argument.required !== undefined) mapped.required = Boolean(argument.required);
            return mapped;
          }),
      }));
  }

  async getPrompt(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('prompts/get', { name, arguments: args });
  }

  async listResources(): Promise<RawResourceDefinition[]> {
    const result = await this.request<{ resources?: unknown }>('resources/list', {});
    return toArray(result?.resources)
      .filter(isRecord)
      .map((resource) => ({
        uri: asString(resource.uri),
        name: asString(resource.name),
        description: asString(resource.description),
        mimeType: asStringOrNull(resource.mimeType),
      }));
  }

  async listResourceTemplates(): Promise<RawResourceTemplateDefinition[]> {
    const result = await this.request<{ resourceTemplates?: unknown }>('resources/templates/list', {});
    return toArray(result?.resourceTemplates)
      .filter(isRecord)
      .map((template) => ({
        uriTemplate: asString(template.uriTemplate),
        name: asString(template.name),
        description: asString(template.description),
        mimeType: asStringOrNull(template.mimeType),
      }));
  }

  async readResource(uri: string): Promise<unknown> {
    return this.request<unknown>('resources/read', { uri });
  }

  notify(method: string, params?: unknown): void {
    // Fire-and-forget notification; failures are logged only.
    this.post({ jsonrpc: '2.0', method, params: params ?? {} }).catch((error: unknown) => {
      this.logger.debug('notification failed', { serverId: this.serverId, error: String(error) });
    });
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(this.options.url, {
        method: 'DELETE',
        headers: this.headers(),
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      // Remote may not support session termination.
    }
    this.sessionId = null;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.options.headers ?? {}),
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    return headers;
  }

  private async post(payload: unknown, timeoutMs?: number): Promise<Response> {
    try {
      return await fetch(this.options.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs ?? this.options.requestTimeoutMs ?? 60_000),
      });
    } catch (error) {
      this.logger.warn('http transport failure', { serverId: this.serverId, error: String(error) });
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, `Remote MCP server unreachable: ${String(error)}`);
    }
  }

  private async request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs);
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;

    if (!response.ok) {
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, `Remote MCP server returned HTTP ${response.status}`, {
        data: { status: 'UPSTREAM_ERROR', reason: method, details: response.status },
      });
    }

    const envelope = await this.parseEnvelope(response);
    if (!envelope) {
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, `Remote MCP server returned an empty response to '${method}'`);
    }
    if (envelope.error) {
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, envelope.error.message || 'Remote MCP error', {
        data: { status: 'UPSTREAM_ERROR', reason: method, details: envelope.error.data },
      });
    }
    return envelope.result as T;
  }

  private async parseEnvelope(response: Response): Promise<JsonRpcEnvelope | null> {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      const text = await response.text();
      const dataLines = text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);
      for (const dataLine of dataLines.reverse()) {
        try {
          const parsed = JSON.parse(dataLine) as JsonRpcEnvelope;
          if (parsed.result !== undefined || parsed.error !== undefined) return parsed;
        } catch {
          // keep scanning
        }
      }
      return null;
    }
    try {
      return (await response.json()) as JsonRpcEnvelope;
    } catch {
      return null;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value);
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
