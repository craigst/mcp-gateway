/**
 * Collision-safe tool names.
 *
 * MCP tool names are only unique per server (`UNIQUE (server_id, name)` in the
 * catalog). Real fleets contain servers that publish the same bare name — the
 * four OpenMausBot email servers all expose `send_email`, `list_emails`, … — and
 * an agent that mounts them through one gateway endpoint must be able to say
 * which mailbox it means.
 *
 * Rules:
 *  - a bare name published by exactly one server stays bare (`brain_search`);
 *  - a bare name published by more than one server is exposed as
 *    `<server-slug>__<tool>` for every one of them (`email-work__send_email`);
 *  - names are computed over the whole catalog, never per key, so a tool's
 *    exposed name cannot change when a grant changes;
 *  - `resolve()` accepts the exposed name, the qualified form, the tool id or a
 *    bare name (the caller decides what to do with more than one candidate).
 */
import type { ServerRecord, ToolDescriptor } from '../core/types.js';

/** Lowercase, punctuation-free server slug used as the tool-name prefix. */
export function toolSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug.length > 0 ? slug : 'server';
}

function uniqueSuffix(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}_${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export class ToolNameIndex {
  /** tool.id -> exposed name. */
  private readonly exposed = new Map<string, string>();
  private readonly byExposed = new Map<string, ToolDescriptor>();
  private readonly byBare = new Map<string, ToolDescriptor[]>();
  private readonly byId = new Map<string, ToolDescriptor>();
  private readonly serverSlug = new Map<string, string>();
  private readonly slugServer = new Map<string, string>();
  private readonly duplicateBare = new Set<string>();

  constructor(tools: ToolDescriptor[], servers: ServerRecord[]) {
    // Stable, collision-free slugs. Server names are unique; two names can still
    // slugify to the same value (`a-b` / `a_b`), so disambiguate deterministically.
    const takenSlugs = new Set<string>();
    const orderedServers = [...servers].sort((a, b) => a.id.localeCompare(b.id));
    for (const server of orderedServers) {
      const slug = uniqueSuffix(toolSlug(server.name), takenSlugs);
      takenSlugs.add(slug);
      this.serverSlug.set(server.id, slug);
      this.slugServer.set(slug, server.id);
    }

    const bareCounts = new Map<string, number>();
    for (const tool of tools) {
      bareCounts.set(tool.name, (bareCounts.get(tool.name) ?? 0) + 1);
    }
    for (const [name, count] of bareCounts) {
      if (count > 1) this.duplicateBare.add(name);
    }

    const takenExposed = new Set<string>();
    for (const tool of tools) {
      this.byId.set(tool.id, tool);
      const bare = tool.name;
      const list = this.byBare.get(bare) ?? [];
      list.push(tool);
      this.byBare.set(bare, list);

      const slug = this.serverSlug.get(tool.serverId) ?? toolSlug(tool.serverId);
      const base = this.duplicateBare.has(bare) ? `${slug}__${bare}` : bare;
      const name = uniqueSuffix(base, takenExposed);
      takenExposed.add(name);
      this.exposed.set(tool.id, name);
      this.byExposed.set(name, tool);
    }
  }

  /** The name an agent should use for this tool. */
  exposedName(tool: ToolDescriptor): string {
    return this.exposed.get(tool.id) ?? tool.name;
  }

  /** Whether the bare name is shared by more than one server. */
  isAmbiguousBareName(name: string): boolean {
    return this.duplicateBare.has(name);
  }

  /** Every tool that answers to `name`, optionally limited to one server. */
  resolve(name: string, serverId?: string): ToolDescriptor[] {
    const trimmed = name.trim();
    const inServer = (tool: ToolDescriptor): boolean => serverId === undefined || tool.serverId === serverId;

    // Exact id, exposed name, or qualified `<slug>__<tool>` form.
    const direct = this.byId.get(trimmed) ?? this.byExposed.get(trimmed);
    if (direct !== undefined && inServer(direct)) return [direct];

    const separator = trimmed.indexOf('__');
    if (separator > 0) {
      const slug = trimmed.slice(0, separator);
      const bare = trimmed.slice(separator + 2);
      const resolvedServerId = this.slugServer.get(slug);
      if (resolvedServerId !== undefined && (serverId === undefined || serverId === resolvedServerId)) {
        const match = (this.byBare.get(bare) ?? []).find((tool) => tool.serverId === resolvedServerId);
        if (match !== undefined) return [match];
      }
    }

    // Bare name: one candidate is unambiguous, several are not.
    return (this.byBare.get(trimmed) ?? []).filter(inServer);
  }

  /** Qualified names for an ambiguous bare name, for the error message. */
  qualifiedNames(name: string): string[] {
    return (this.byBare.get(name) ?? []).map((tool) => this.exposedName(tool));
  }

  /** All tools, for callers that need to map results. */
  tools(): ToolDescriptor[] {
    return [...this.byId.values()];
  }
}
