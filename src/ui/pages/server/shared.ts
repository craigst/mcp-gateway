/** Shared helpers for the full server inspector page. */
import type { ServerUsageStats } from '../../../core/types.js';

export type InspectorTab = 'overview' | 'tools' | 'prompts' | 'configuration' | 'activity';

export interface ToolUsage {
  count: number;
  lastUsedAt: string | null;
  avgLatencyMs: number;
}

/** Look up per-tool usage by full tool id or bare name. */
export function usageForTool(stats: ServerUsageStats, toolId: string, toolName: string): ToolUsage | null {
  const entry =
    stats.toolUsage.find((usage) => usage.toolId === toolId || usage.name === toolName) ?? null;
  if (entry === null) return null;
  return { count: entry.count, lastUsedAt: entry.lastUsedAt, avgLatencyMs: entry.avgLatencyMs };
}

export function shortCommit(commit: string | null | undefined): string {
  if (commit === null || commit === undefined || commit.trim() === '') return '—';
  return commit.slice(0, 7);
}

/** Only allow http(s) links from API data. */
export function safeExternalUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** True when an MCP CallToolResult reports an error. */
export function rpcResultIsError(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true;
}
