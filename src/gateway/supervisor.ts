import { GatewayError, ErrorCodes } from '../core/errors.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { GatewayConfig } from '../core/config.js';
import type { CatalogRepository, McpClient, RawToolDefinition, SubServerLogLine, Supervisor, VaultService } from '../core/ports.js';
import type { ServerRecord, ServerStatus, ToolDescriptor } from '../core/types.js';
import { HttpMcpClient } from './transport/http.js';
import { StdioMcpClient } from './transport/stdio.js';

const MAX_LOG_LINES = 500;

interface ManagedServer {
  record: ServerRecord;
  client: McpClient | null;
  logs: SubServerLogLine[];
}

export interface SupervisorOptions {
  repository: CatalogRepository;
  config: GatewayConfig;
  vault?: VaultService;
  logger?: Logger;
}

/**
 * Owns the lifecycle of every sub-server process: spawn, MCP handshake,
 * tool discovery, restart, log ring buffers and status transitions.
 */
export class DefaultSupervisor implements Supervisor {
  private readonly managed = new Map<string, ManagedServer>();
  private readonly starting = new Map<string, Promise<ServerRecord>>();
  private readonly logListeners = new Set<(line: SubServerLogLine & { serverId: string }) => void>();
  private readonly logger: Logger;

  constructor(private readonly options: SupervisorOptions) {
    this.logger = options.logger ?? createLogger('supervisor');
  }

  async start(serverId: string): Promise<ServerRecord> {
    const inflight = this.starting.get(serverId);
    if (inflight) return inflight;

    const promise = this.doStart(serverId).finally(() => this.starting.delete(serverId));
    this.starting.set(serverId, promise);
    return promise;
  }

  private async doStart(serverId: string): Promise<ServerRecord> {
    const existing = this.managed.get(serverId);
    if (existing?.client && existing.record.status === 'running') return existing.record;

    const record = this.options.repository.getServer(serverId);
    if (!record) throw new GatewayError(ErrorCodes.INVALID_PARAMS, `Unknown server '${serverId}'`);

    this.updateStatus(record.id, 'starting', { lastError: null });
    const managed: ManagedServer = {
      record: { ...record, status: 'starting' },
      client: null,
      logs: existing?.logs ?? [],
    };
    this.managed.set(serverId, managed);
    this.pushLog(serverId, 'system', `starting server '${record.name}' (${record.runtime}/${record.transport})`);

    try {
      const client = await this.createClient(record, (line) => this.pushLog(serverId, line.stream, line.line));
      managed.client = client;
      this.pushLog(serverId, 'system', 'performing MCP initialize handshake');
      const info = await client.initialize();
      this.pushLog(serverId, 'system', `initialized ${info.serverInfo.name}@${info.serverInfo.version} (protocol ${info.protocolVersion})`);

      const rawTools = await client.listTools();
      const tools = this.toDescriptors(record, rawTools);
      this.options.repository.upsertTools(serverId, tools);
      this.pushLog(serverId, 'system', `discovered ${tools.length} tool(s)`);

      const pid = client instanceof StdioMcpClient ? (client.pid ?? null) : null;
      const updated = this.updateStatus(serverId, 'running', { pid, lastError: null });
      this.logger.info('sub-server started', { serverId, name: record.name, tools: tools.length, pid });
      return updated ?? managed.record;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pushLog(serverId, 'system', `start failed: ${message}`);
      this.logger.error('sub-server start failed', { serverId, error: message });
      try {
        await managed.client?.close();
      } catch {
        /* ignore */
      }
      managed.client = null;
      this.updateStatus(serverId, 'failed', { lastError: message });
      throw error instanceof GatewayError ? error : new GatewayError(ErrorCodes.UPSTREAM_ERROR, message, { cause: error });
    }
  }

  private async createClient(record: ServerRecord, onLog: (line: SubServerLogLine) => void): Promise<McpClient> {
    if (record.transport === 'stdio') {
      if (!record.command) throw new GatewayError(ErrorCodes.INVALID_PARAMS, `Server '${record.name}' has no command`);
      const env = { ...record.env };
      const requiredSecrets = record.manifest?.required_secrets ?? [];
      if (requiredSecrets.length > 0 && this.options.vault) {
        Object.assign(env, this.options.vault.resolveSecrets(requiredSecrets));
      }
      const client = new StdioMcpClient({
        serverId: record.id,
        command: record.command,
        args: record.args,
        cwd: record.workDir ?? undefined,
        env,
        onLog,
        requestTimeoutMs: this.options.config.defaultToolTimeoutMs,
      });
      return client.start();
    }

    if (!record.url) throw new GatewayError(ErrorCodes.INVALID_PARAMS, `Server '${record.name}' has no url`);
    const client = new HttpMcpClient({
      serverId: record.id,
      url: record.url,
      requestTimeoutMs: this.options.config.defaultToolTimeoutMs,
    });
    return client;
  }

  private toDescriptors(record: ServerRecord, rawTools: RawToolDefinition[]): ToolDescriptor[] {
    const highPrivilege = new Set(record.highPrivilegeTools);
    return rawTools.map((tool) => ({
      id: `${record.id}:${tool.name}`,
      name: tool.name,
      description: tool.description,
      serverId: record.id,
      inputSchema: tool.inputSchema,
      highPrivilege: highPrivilege.has(tool.name),
      tags: [],
    }));
  }

  async stop(serverId: string): Promise<void> {
    const managed = this.managed.get(serverId);
    const record = managed?.record ?? this.options.repository.getServer(serverId);
    if (!record) throw new GatewayError(ErrorCodes.INVALID_PARAMS, `Unknown server '${serverId}'`);

    this.updateStatus(serverId, 'stopping');
    if (managed?.client) {
      try {
        await managed.client.close();
      } catch (error) {
        this.logger.warn('error closing sub-server client', { serverId, error: String(error) });
      }
      managed.client = null;
    }
    if (managed) this.pushLog(serverId, 'system', 'server stopped');
    this.updateStatus(serverId, 'stopped', { pid: null });
  }

  async restart(serverId: string): Promise<ServerRecord> {
    await this.stop(serverId);
    return this.start(serverId);
  }

  status(serverId: string): ServerStatus {
    const managed = this.managed.get(serverId);
    if (managed) return managed.record.status;
    return this.options.repository.getServer(serverId)?.status ?? 'stopped';
  }

  client(serverId: string): McpClient | null {
    const managed = this.managed.get(serverId);
    if (!managed || managed.record.status !== 'running') return null;
    return managed.client;
  }

  logs(serverId: string, limit = 200): SubServerLogLine[] {
    const managed = this.managed.get(serverId);
    if (!managed) return [];
    return managed.logs.slice(Math.max(0, managed.logs.length - limit));
  }

  subscribeLogs(
    serverId: string | null,
    listener: (line: SubServerLogLine & { serverId: string }) => void,
  ): () => void {
    const wrapped = (line: SubServerLogLine & { serverId: string }): void => {
      if (serverId === null || line.serverId === serverId) listener(line);
    };
    this.logListeners.add(wrapped);
    return () => this.logListeners.delete(wrapped);
  }

  list(): ServerRecord[] {
    return this.options.repository.listServers();
  }

  async shutdown(): Promise<void> {
    const ids = this.options.repository.listServers().map((s) => s.id);
    await Promise.allSettled(ids.map((id) => this.stop(id)));
  }

  private updateStatus(serverId: string, status: ServerStatus, patch: Partial<ServerRecord> = {}): ServerRecord | null {
    const managed = this.managed.get(serverId);
    this.options.repository.setServerStatus(serverId, status, patch);
    const refreshed = this.options.repository.getServer(serverId);
    if (managed && refreshed) {
      managed.record = { ...refreshed, status };
      managed.record = refreshed;
    }
    return refreshed;
  }

  private pushLog(serverId: string, stream: SubServerLogLine['stream'], line: string): void {
    const managed = this.managed.get(serverId);
    if (!managed) return;
    const entry: SubServerLogLine = { ts: new Date().toISOString(), stream, line };
    managed.logs.push(entry);
    if (managed.logs.length > MAX_LOG_LINES) managed.logs.splice(0, managed.logs.length - MAX_LOG_LINES);
    for (const listener of this.logListeners) {
      try {
        listener({ ...entry, serverId });
      } catch {
        /* listener isolation */
      }
    }
  }
}
