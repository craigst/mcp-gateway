import { describe, expect, it } from 'vitest';
import type { ToolDescriptor } from '../../src/core/types.js';
import { rankTools } from '../../src/catalog/search.js';

function tool(name: string, overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    id: `srv:${name}`,
    name,
    description: '',
    serverId: 'srv',
    inputSchema: { type: 'object' },
    highPrivilege: false,
    tags: [],
    ...overrides,
  };
}

function names(tools: Array<{ name: string }>): string[] {
  return tools.map((entry) => entry.name);
}

describe('rankTools', () => {
  it('returns all tools with score 0 in original order for an empty query', () => {
    const tools = [tool('charlie'), tool('alpha'), tool('bravo')];
    const result = rankTools(tools, '', 20);

    expect(names(result)).toEqual(['charlie', 'alpha', 'bravo']);
    expect(result.every((entry) => entry.score === 0)).toBe(true);
  });

  it('treats a whitespace/punctuation-only query as empty', () => {
    const tools = [tool('bravo'), tool('alpha')];
    expect(names(rankTools(tools, '   ', 20))).toEqual(['bravo', 'alpha']);
    expect(names(rankTools(tools, ' -- ', 20))).toEqual(['bravo', 'alpha']);
  });

  it('ranks an exact name match above a partial name match', () => {
    const tools = [tool('widget_wrangler'), tool('widget')];
    const result = rankTools(tools, 'widget', 20);

    expect(names(result)).toEqual(['widget', 'widget_wrangler']);
    expect(result[0]?.score).toBe(8); // exact (5) + name token (3)
    expect(result[1]?.score).toBe(3); // name token only
  });

  it('ranks name matches above tags above description', () => {
    const tools = [
      tool('widget_alpha'), // name token => 3
      tool('beta', { tags: ['widget'] }), // tag => 2
      tool('gamma', { description: 'widget helper' }), // description => 1
    ];
    expect(names(rankTools(tools, 'widget', 20))).toEqual([
      'widget_alpha',
      'beta',
      'gamma',
    ]);
    expect(rankTools(tools, 'widget', 20).map((entry) => entry.score)).toEqual([3, 2, 1]);
  });

  it('accumulates score across name, tags and description', () => {
    const tools = [
      tool('widget', { tags: ['widget'], description: 'a widget tool' }),
      tool('other', { tags: ['widget'] }),
    ];
    const result = rankTools(tools, 'widget', 20);
    expect(result[0]?.name).toBe('widget');
    expect(result[0]?.score).toBe(11); // 5 exact + 3 name + 2 tag + 1 description
    expect(result[1]?.score).toBe(2);
  });

  it('accumulates score across multiple query tokens', () => {
    const tools = [tool('postgres_read_query'), tool('github_create_issue')];
    const result = rankTools(tools, 'postgres query', 20);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('postgres_read_query');
    expect(result[0]?.score).toBe(6); // two name tokens
  });

  it('is case-insensitive', () => {
    const tools = [tool('postgres_read_query')];
    expect(rankTools(tools, 'POSTGRES', 20)[0]?.name).toBe('postgres_read_query');
    expect(rankTools(tools, 'Postgres', 20)[0]?.score).toBe(3);
  });

  it('breaks score ties by tool name ascending', () => {
    const tools = [
      tool('zeta', { tags: ['database'] }),
      tool('alpha', { tags: ['database'] }),
      tool('mike', { tags: ['database'] }),
    ];
    expect(names(rankTools(tools, 'database', 20))).toEqual(['alpha', 'mike', 'zeta']);
  });

  it('returns no tools when nothing matches a non-empty query', () => {
    const tools = [tool('alpha', { description: 'first' })];
    expect(rankTools(tools, 'zzz', 20)).toEqual([]);
  });

  it('caps the result count at the limit', () => {
    const tools = Array.from({ length: 25 }, (_, index) => tool(`tool_${index}`));
    expect(rankTools(tools, '', 5)).toHaveLength(5);
    expect(rankTools(tools, '', 0)).toEqual([]);
    expect(rankTools(tools, '', -3)).toEqual([]);
  });

  it('defaults to 20 and caps at 100', () => {
    const twentyFive = Array.from({ length: 25 }, (_, index) => tool(`tool_${index}`));
    expect(rankTools(twentyFive, '', Number.NaN)).toHaveLength(20);
    expect(rankTools(twentyFive, '', undefined as unknown as number)).toHaveLength(20);

    const oneHundredTwenty = Array.from({ length: 120 }, (_, index) => tool(`tool_${index}`));
    expect(rankTools(oneHundredTwenty, '', 1000)).toHaveLength(100);
  });

  it('maps the search result shape used by tools/search', () => {
    const tools = [
      tool('read_query', {
        id: 'srv_pg:read_query',
        serverId: 'srv_pg',
        description: 'Execute read-only SQL',
      }),
    ];
    const [entry] = rankTools(tools, 'read', 20);
    expect(entry).toEqual({
      id: 'srv_pg:read_query',
      name: 'read_query',
      description: 'Execute read-only SQL',
      server_id: 'srv_pg',
      // 'read' matches the name token (3) and the description token (1).
      score: 4,
    });
  });
});
