/**
 * Zero-trust catalog service.
 *
 * Every discovery vector filters through the PolicyEngine BEFORE serialization:
 * unauthorized tools/servers are absent (not merely redacted), and search results are
 * ranked only over the visible subset. See spec §3 (`CENSORED` / `MASKED` /
 * `ZERO-TRUST` visibility modes).
 */
import type { CatalogRepository, CatalogService, PolicyEngine } from '../core/ports.js';
import type {
  AuthenticatedKey,
  JsonSchema,
  PermittedServerSummary,
  ServerRecord,
  ToolDescriptor,
  ToolSearchResult,
} from '../core/types.js';
import { rankTools } from './search.js';

export class DefaultCatalogService implements CatalogService {
  readonly repository: CatalogRepository;
  private readonly policy: PolicyEngine;

  constructor(repository: CatalogRepository, policy: PolicyEngine) {
    this.repository = repository;
    this.policy = policy;
  }

  /** CENSORED: filter by key scope before ranking; high-privilege tools stay hidden. */
  searchTools(key: AuthenticatedKey, query: string, limit: number): ToolSearchResult {
    const visible = this.repository.listTools().filter((tool) => this.policy.isToolPermitted(key, tool));
    const tools = rankTools(visible, query, limit);
    return { tools, total: tools.length, censored: true };
  }

  /** MASKED: schemas are only emitted for tools the key may actually see. */
  listTools(
    key: AuthenticatedKey,
    options?: { serverId?: string },
  ): {
    tools: Array<{
      id: string;
      name: string;
      description: string;
      server_id: string;
      inputSchema: JsonSchema;
    }>;
    total: number;
  } {
    const serverId = options?.serverId;
    const tools = this.repository
      .listTools()
      .filter((tool) => (serverId === undefined ? true : tool.serverId === serverId))
      .filter((tool) => this.policy.isToolPermitted(key, tool))
      .map((tool) => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        server_id: tool.serverId,
        inputSchema: tool.inputSchema,
      }));
    return { tools, total: tools.length };
  }

  /** ZERO-TRUST: unpermitted servers are absent from the menu entirely. */
  listPermittedServers(key: AuthenticatedKey): PermittedServerSummary[] {
    return this.repository
      .listServers()
      .filter((server) => this.policy.isServerPermitted(key, server.id))
      .map((server) => {
        const visibleTools = this.repository
          .listToolsByServer(server.id)
          .filter((tool) => this.policy.isToolPermitted(key, tool));
        return {
          id: server.id,
          name: server.name,
          runtime: server.runtime,
          status: server.status,
          delegation_supported: server.delegationSupported,
          tool_count: visibleTools.length,
        };
      });
  }

  /** Anti-probing: invisible tools are indistinguishable from non-existent ones. */
  getVisibleTool(key: AuthenticatedKey, toolId: string): ToolDescriptor | null {
    const tool = this.repository.getTool(toolId);
    if (!tool) return null;
    return this.policy.isToolPermitted(key, tool) ? tool : null;
  }

  /** Persist a sub-server and atomically replace its discovered tool set. */
  upsertServerFromDiscovery(server: ServerRecord, tools: ToolDescriptor[]): void {
    this.repository.upsertServer(server);
    const normalized = tools.map((tool) => ({
      ...tool,
      serverId: server.id,
      id: tool.id || `${server.id}:${tool.name}`,
    }));
    this.repository.upsertTools(server.id, normalized);
  }
}
