import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
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
  SubServerLogLine,
} from '../../core/ports.js';


export interface StdioClientOptions {
  serverId: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  logger?: Logger;
  onLog?: (line: SubServerLogLine) => void;
  requestTimeoutMs?: number;
  /** Overrides used in tests. */
  clientInfo?: { name: string; version: string };
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const PROTOCOL_VERSION = '2025-06-18';

/**
 * Minimal MCP client speaking newline-delimited JSON-RPC 2.0 over a child
 * process's stdio pipes. Implemented directly (no SDK) so the gateway controls
 * framing, timeouts, and log capture.
 */
export class StdioMcpClient implements McpClient {
  readonly serverId: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private readonly logger: Logger;
  private serverInfo: { name: string; version: string } = { name: 'unknown', version: '0.0.0' };

  constructor(private readonly options: StdioClientOptions) {
    this.serverId = options.serverId;
    this.logger = options.logger ?? createLogger('stdio-transport');
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  async start(): Promise<this> {
    const { command, args = [], cwd, env } = this.options;
    if (!command) throw new GatewayError(ErrorCodes.INVALID_PARAMS, 'stdio transport requires a command');

    try {
      this.child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, `Failed to spawn ${command}`, { cause: error });
    }

    this.child.on('error', (error) => {
      this.logger.error('sub-server process error', { serverId: this.serverId, error: error.message });
      this.rejectAll(new GatewayError(ErrorCodes.UPSTREAM_ERROR, `Sub-server process error: ${error.message}`));
    });

    this.child.on('exit', (code, signal) => {
      this.closed = true;
      this.rejectAll(
        new GatewayError(ErrorCodes.UPSTREAM_ERROR, `Sub-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`),
      );
      this.options.onLog?.({
        ts: new Date().toISOString(),
        stream: 'system',
        line: `process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      });
    });

    this.reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.reader.on('line', (line) => this.handleLine(line, 'stdout'));

    const stderrReader = createInterface({ input: this.child.stderr, crlfDelay: Infinity });
    stderrReader.on('line', (line) => this.handleLine(line, 'stderr'));

    return this;
  }

  private handleLine(rawLine: string, stream: 'stdout' | 'stderr'): void {
    const line = rawLine.trim();
    if (!line) return;

    if (stream === 'stderr') {
      this.options.onLog?.({ ts: new Date().toISOString(), stream, line });
      return;
    }

    interface IncomingMessage {
      jsonrpc?: string;
      id?: number | string | null;
      method?: string;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
      params?: unknown;
    }
    let message: IncomingMessage;
    try {
      message = JSON.parse(line) as IncomingMessage;
    } catch {
      // Not JSON: surface as a log line rather than killing the stream.
      this.options.onLog?.({ ts: new Date().toISOString(), stream: 'stdout', line });
      return;
    }

    this.options.onLog?.({
      ts: new Date().toISOString(),
      stream: 'stdout',
      line: truncateForLog(line),
    });

    if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new GatewayError(ErrorCodes.UPSTREAM_ERROR, message.error.message || 'Upstream error', {
            data: { status: 'UPSTREAM_ERROR', reason: pending.method, details: message.error.data },
          }),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Server-initiated notification: ignore. Server-initiated request: answer politely.
    if (typeof message.id === 'number' && typeof message.method === 'string') {
      this.write({ jsonrpc: '2.0', id: message.id, error: { code: ErrorCodes.METHOD_NOT_FOUND, message: 'Method not supported by gateway client' } });
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private write(payload: unknown): void {
    if (!this.child || this.closed) {
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, `Sub-server ${this.serverId} is not running`);
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new GatewayError(ErrorCodes.UPSTREAM_ERROR, `Upstream '${method}' timed out after ${timeoutMs}ms`, {
            data: { status: 'TIMEOUT', reason: method },
          }),
        );
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error as Error);
      }
    });
  }

  async initialize(): Promise<McpInitializeResult> {
    const timeout = this.options.requestTimeoutMs ?? 20_000;
    const result = await this.request<McpInitializeResult>(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: this.options.clientInfo ?? { name: 'mcp-gateway', version: '0.13.1' },
      },
      timeout,
    );
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
    const result = await this.request<{ tools?: RawToolDefinition[] }>('tools/list', {}, this.options.requestTimeoutMs ?? 20_000);
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
    return this.request<McpCallResult>('tools/call', params, options?.timeoutMs ?? this.options.requestTimeoutMs ?? 60_000);
  }

  async listPrompts(): Promise<RawPromptDefinition[]> {
    const result = await this.request<{ prompts?: unknown }>(
      'prompts/list',
      {},
      this.requestTimeout(),
    );
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
    return this.request<unknown>(
      'prompts/get',
      { name, arguments: args },
      this.requestTimeout(),
    );
  }

  async listResources(): Promise<RawResourceDefinition[]> {
    const result = await this.request<{ resources?: unknown }>(
      'resources/list',
      {},
      this.requestTimeout(),
    );
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
    const result = await this.request<{ resourceTemplates?: unknown }>(
      'resources/templates/list',
      {},
      this.requestTimeout(),
    );
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
    return this.request<unknown>('resources/read', { uri }, this.requestTimeout());
  }

  private requestTimeout(): number {
    return this.options.requestTimeoutMs ?? 20_000;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    try {
      this.write({ jsonrpc: '2.0', method, params: params ?? {} });
    } catch {
      // Best effort: notifications are fire-and-forget.
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.reader?.close();
    const child = this.child;
    this.child = null;
    if (!child || child.killed) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
        resolve();
      }, 2_000);
      force.unref?.();
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(force);
        resolve();
      }
    });
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

function truncateForLog(line: string, max = 2_000): string {
  return line.length <= max ? line : `${line.slice(0, max)}… [truncated ${line.length - max} chars]`;
}
