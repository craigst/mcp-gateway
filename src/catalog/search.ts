/**
 * Pure, deterministic tool ranking used by `tools/search`.
 *
 * Scoring (per matching query token):
 *  - exact full-name match: 5 (applied once)
 *  - name token match:      3
 *  - tag token match:       2
 *  - description token:     1
 *
 * An empty query returns every tool with score 0 in original catalog order. A
 * non-empty query returns only matching tools (score > 0), sorted score desc, then
 * name asc, then original order. The output is stable across runs. `limit` defaults
 * to 20 and is capped at 100.
 */
import type { ToolDescriptor, ToolSearchResult } from '../core/types.js';

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;

const TOKEN_RE = /[a-z0-9]+/g;

function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_RE) ?? [];
}

function scoreTool(tool: ToolDescriptor, query: string): number {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === '') return 0;

  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return 0;

  const nameLower = tool.name.toLowerCase();
  const nameTokens = new Set(tokenize(tool.name));
  const tagTokens = new Set(tokenize(tool.tags.join(' ')));
  const descriptionTokens = new Set(tokenize(tool.description));

  let score = nameLower === trimmed ? 5 : 0;
  for (const token of queryTokens) {
    if (nameTokens.has(token)) score += 3;
    if (tagTokens.has(token)) score += 2;
    if (descriptionTokens.has(token)) score += 1;
  }
  return score;
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.max(0, Math.trunc(limit)), MAX_SEARCH_LIMIT);
}

function toResult(tool: ToolDescriptor, score: number): ToolSearchResult['tools'][number] {
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    server_id: tool.serverId,
    score,
  };
}

export function rankTools(
  tools: ToolDescriptor[],
  query: string,
  limit: number,
): ToolSearchResult['tools'] {
  const normalizedLimit = normalizeLimit(limit);
  if (normalizedLimit === 0) return [];

  // Empty query: the whole (already scope-filtered) catalog, original order, score 0.
  if (query.trim() === '' || tokenize(query).length === 0) {
    return tools.slice(0, normalizedLimit).map((tool) => toResult(tool, 0));
  }

  const scored = tools
    .map((tool, index) => ({ tool, index, score: scoreTool(tool, query) }))
    .filter((entry) => entry.score > 0);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.tool.name !== b.tool.name) return a.tool.name < b.tool.name ? -1 : 1;
    return a.index - b.index;
  });

  return scored.slice(0, normalizedLimit).map(({ tool, score }) => toResult(tool, score));
}
