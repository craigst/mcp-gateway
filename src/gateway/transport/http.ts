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

interface JsonRpcRequestPayload {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown;
}

/** Raised when the remote rejected a session-bound request because it expired. */
class SessionExpiredError extends GatewayError {
  constructor(
    readonly staleSessionId: string,
    method: string,
  ) {
    super(
      ErrorCodes.UPSTREAM_ERROR,
      `Remote MCP session expired before '${method}' was dispatched`,
      { data: { status: 'UPSTREAM_ERROR', reason: 'SESSION_EXPIRED' } },
    );
    this.name = 'SessionExpiredError';
  }
}

/**
 * MCP client for remote servers exposed over HTTP (Streamable HTTP transport).
 * Supports JSON and SSE-encoded responses and session-id propagation.
 */
export class HttpMcpClient implements McpClient {
  readonly serverId: string;
  private sessionId: string | null = null;
  private nextId = 1;
  private recovery: Promise<void> | null = null;
  private readonly logger: Logger;
  private serverInfo: { name: string; version: string } = { name: 'unknown', version: '0.0.0' };

  constructor(private readonly options: HttpClientOptions) {
    this.serverId = options.serverId;
    this.logger = options.logger ?? createLogger('http-transport');
  }

  async initialize(): Promise<McpInitializeResult> {
    const result = await this.request<McpInitializeResult>('initialize', this.initializeParams());
    this.serverInfo = result?.serverInfo ?? this.serverInfo;
    this.notify('notifications/initialized', {});
    return {
      protocolVersion: result?.protocolVersion ?? PROTOCOL_VERSION,
      serverInfo: this.serverInfo,
      capabilities: result?.capabilities ?? {},
      instructions: typeof result?.instructions === 'string' ? result.instructions : null,
    };
  }

  private initializeParams(): Record<string, unknown> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.options.clientInfo ?? { name: 'mcp-gateway', version: '0.14.2' },
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
    // While a recovery handshake is running the client has no session id, so a
    // request sent now would be rejected as sessionless and could never be
    // retried. Serialize callers behind the handshake instead: they then go out
    // on the fresh session. Concurrent expiries still share one handshake via
    // `recoverSession`.
    await this.awaitRecovery();
    const payload: JsonRpcRequestPayload = { jsonrpc: '2.0', id: this.nextId++, method, params };
    try {
      return await this.send<T>(payload, method, timeoutMs);
    } catch (error) {
      if (!(error instanceof SessionExpiredError)) throw error;
      this.logger.warn('remote MCP session expired; re-initializing', {
        serverId: this.serverId,
        method,
      });
      await this.recoverSession(error.staleSessionId);
      try {
        return await this.send<T>(payload, method, timeoutMs);
      } catch (retryError) {
        if (retryError instanceof SessionExpiredError) {
          throw new GatewayError(
            ErrorCodes.UPSTREAM_ERROR,
            `Remote MCP session expired during '${method}' and the new session was rejected as well`,
            { data: { status: 'UPSTREAM_ERROR', reason: 'SESSION_EXPIRED' } },
          );
        }
        throw retryError;
      }
    }
  }

  private async send<T>(
    payload: JsonRpcRequestPayload,
    method: string,
    timeoutMs?: number,
  ): Promise<T> {
    const sentSessionId = this.sessionId;
    const response = await this.post(payload, timeoutMs);

    if (!response.ok) {
      const envelope = await this.parseEnvelope(response);
      if (sentSessionId !== null && isExpiredSessionResponse(response.status, envelope)) {
        // Remotes validate `mcp-session-id` before dispatching the message, so a
        // 404 here proves the upstream tool did not run. Re-sending it after a
        // fresh handshake therefore cannot duplicate a write.
        throw new SessionExpiredError(sentSessionId, method);
      }
      const upstreamMessage = envelope?.error?.message;
      throw new GatewayError(
        ErrorCodes.UPSTREAM_ERROR,
        upstreamMessage
          ? `Remote MCP server returned HTTP ${response.status}: ${upstreamMessage}`
          : `Remote MCP server returned HTTP ${response.status}`,
        {
          data: { status: 'UPSTREAM_ERROR', reason: method, details: response.status },
        },
      );
    }

    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;

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

  /**
   * Wait until no recovery handshake is in flight.
   *
   * `recoverSession` clears `sessionId` before the handshake and only restores
   * it on success, so a caller must not send during that window. The loop also
   * covers a retry that starts a second recovery just as the first settles.
   * A failed handshake propagates to the waiting caller rather than being
   * retried silently.
   */
  private async awaitRecovery(): Promise<void> {
    while (this.recovery) {
      await this.recovery;
    }
  }

  /**
   * Re-establish the Streamable HTTP session after the remote drops it.
   *
   * One handshake at a time: concurrent callers that saw the same expiry await
   * the same recovery instead of each opening a session. A caller whose stale
   * observation was already superseded returns immediately.
   */
  private recoverSession(staleSessionId: string): Promise<void> {
    if (this.recovery) return this.recovery;
    this.recovery = (async () => {
      if (this.sessionId !== staleSessionId) return;
      this.sessionId = null;
      const payload: JsonRpcRequestPayload = {
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'initialize',
        params: this.initializeParams(),
      };
      const result = await this.send<McpInitializeResult>(payload, 'initialize');
      this.serverInfo = result?.serverInfo ?? this.serverInfo;
      await this.sendInitialized();
      this.logger.info('remote MCP session re-established', { serverId: this.serverId });
    })().finally(() => {
      this.recovery = null;
    });
    return this.recovery;
  }

  private async sendInitialized(): Promise<void> {
    try {
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    } catch (error) {
      this.logger.debug('initialized notification failed after session recovery', {
        serverId: this.serverId,
        error: String(error),
      });
    }
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

/**
 * True when a session-bound request was rejected because the remote no longer
 * knows that session. `mcp-proxy` answers with HTTP 404 and
 * `{"error":{"code":-32001,"message":"Session not found"}}`; the MCP spec
 * requires a new `initialize` in that case.
 */
function isExpiredSessionResponse(status: number, envelope: JsonRpcEnvelope | null): boolean {
  if (status !== 404) return false;
  const error = envelope?.error;
  if (!error) return true;
  if (error.code === -32001) return true;
  const message = error.message ?? '';
  return /session/i.test(message) && /(not found|expired|invalid|unknown|terminated|closed)/i.test(message);
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
