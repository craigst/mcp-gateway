import { describe, expect, it } from 'vitest';
import { ToolNameIndex, toolSlug } from '../../src/catalog/names.js';
import type { ServerRecord, ToolDescriptor } from '../../src/core/types.js';

function tool(serverId: string, name: string): ToolDescriptor {
  return {
    id: `${serverId}:${name}`,
    name,
    description: `${serverId} ${name}`,
    serverId,
    inputSchema: { type: 'object' },
    highPrivilege: false,
    tags: [],
  };
}

function server(id: string, name: string): ServerRecord {
  return {
    id,
    name,
    runtime: 'node',
    transport: 'http',
    status: 'running',
    command: null,
    args: [],
    url: 'http://127.0.0.1:1/mcp',
    env: {},
    manifest: null,
    highPrivilegeTools: [],
    delegationSupported: false,
    sourceUrl: null,
    workDir: null,
    lastError: null,
    pid: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('ToolNameIndex', () => {
  it('leaves a bare name that only one server publishes untouched', () => {
    const index = new ToolNameIndex([tool('srv_a', 'brain_search')], [server('srv_a', 'brain')]);
    expect(index.exposedName(tool('srv_a', 'brain_search'))).toBe('brain_search');
    expect(index.isAmbiguousBareName('brain_search')).toBe(false);
  });

  it('qualifies a name that more than one server publishes', () => {
    const tools = [tool('srv_a', 'send_email'), tool('srv_b', 'send_email')];
    const index = new ToolNameIndex(tools, [server('srv_a', 'email-work'), server('srv_b', 'email-mum')]);
    expect(index.exposedName(tool('srv_a', 'send_email'))).toBe('email_work__send_email');
    expect(index.exposedName(tool('srv_b', 'send_email'))).toBe('email_mum__send_email');
    expect(index.isAmbiguousBareName('send_email')).toBe(true);
  });

  it('resolves exposed, qualified, bare and id forms', () => {
    const tools = [tool('srv_a', 'send_email'), tool('srv_b', 'send_email')];
    const index = new ToolNameIndex(tools, [server('srv_a', 'email-work'), server('srv_b', 'email-mum')]);

    expect(index.resolve('email_work__send_email').map((t) => t.serverId)).toEqual(['srv_a']);
    expect(index.resolve('email__send_email')).toEqual([]);
    expect(index.resolve('send_email').map((t) => t.serverId)).toEqual(['srv_a', 'srv_b']);
    expect(index.resolve('srv_b:send_email').map((t) => t.serverId)).toEqual(['srv_b']);
    expect(index.resolve('send_email', 'srv_b').map((t) => t.serverId)).toEqual(['srv_b']);
  });

  it('disambiguates server names that slugify to the same value', () => {
    const tools = [tool('srv_a', 'x'), tool('srv_b', 'x')];
    const index = new ToolNameIndex(tools, [server('srv_a', 'a-b'), server('srv_b', 'a_b')]);
    const names = tools.map((t) => index.exposedName(t));
    expect(new Set(names).size).toBe(2);
    expect(toolSlug('a-b')).toBe('a_b');
  });

  it('keeps every exposed name unique', () => {
    const tools = [tool('srv_a', 'x'), tool('srv_b', 'x'), tool('srv_a', 'y')];
    const index = new ToolNameIndex(tools, [server('srv_a', 's'), server('srv_b', 's_2')]);
    const names = tools.map((t) => index.exposedName(t));
    expect(new Set(names).size).toBe(names.length);
  });
});
