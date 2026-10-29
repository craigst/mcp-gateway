import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import {
  createInspectorHarness,
  issueKey,
  seedAudit,
  seedAuditMatrix,
  seedServer,
  seedTools,
  type InspectorHarness,
} from './support.js';

const harnesses: InspectorHarness[] = [];

beforeEach(() => {
  harnesses.length = 0;
});

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.dispose();
});

function setup(): InspectorHarness {
  const harness = createInspectorHarness();
  harnesses.push(harness);
  return harness;
}

describe('ServerInspectorService.activity', () => {
  it('pages activity with summary covering ok, error and denied calls', () => {
    const harness = setup();
    const server = seedServer(harness, { name: 'brain' });
    seedTools(harness, server.id, [{ name: 'echo' }, { name: 'add' }, { name: 'danger_delete' }]);
    const master = issueKey(harness, 'master-key', 'master');
    const agent = issueKey(harness, 'agent-key', 'agent');
    seedAuditMatrix(harness, server.id, master.id, agent.id);

    const page = harness.inspector.activity(server.id);
    expect(page.total).toBe(11);
    expect(page.entries).toHaveLength(11);
    expect(page.summary).toMatchObject({ total: 10, ok: 7, error: 2, denied: 1, errorRate: 0.3 });

    const limited = harness.inspector.activity(server.id, { limit: 3, offset: 2 });
    expect(limited.total).toBe(11);
    expect(limited.entries).toHaveLength(3);
    const all = harness.inspector.activity(server.id);
    expect(limited.entries.map((entry) => entry.id)).toEqual(all.entries.slice(2, 5).map((entry) => entry.id));
    // Summary is always the full server usage summary, independent of page filters.
    expect(limited.summary.total).toBe(10);
  });

  it('filters by status, tool and key', () => {
    const harness = setup();
    const server = seedServer(harness, { name: 'brain' });
    seedTools(harness, server.id, [{ name: 'echo' }, { name: 'add' }, { name: 'danger_delete' }]);
    const master = issueKey(harness, 'master-key', 'master');
    const agent = issueKey(harness, 'agent-key', 'agent');
    seedAuditMatrix(harness, server.id, master.id, agent.id);

    expect(harness.inspector.activity(server.id, { status: 'ok' }).total).toBe(8); // 7 calls + tools/list
    expect(harness.inspector.activity(server.id, { status: 'error' }).total).toBe(2);
    expect(harness.inspector.activity(server.id, { status: 'denied' }).total).toBe(1);

    const echo = harness.inspector.activity(server.id, { toolId: `${server.id}:echo` });
    expect(echo.total).toBe(5);
    expect(echo.entries.every((entry) => entry.toolId === `${server.id}:echo`)).toBe(true);

    const agentOnly = harness.inspector.activity(server.id, { keyId: agent.id });
    expect(agentOnly.total).toBe(7); // 6 tools/call + 1 tools/list
    expect(agentOnly.entries.every((entry) => entry.keyId === agent.id)).toBe(true);

    const combined = harness.inspector.activity(server.id, { status: 'ok', toolId: `${server.id}:echo` });
    expect(combined.total).toBe(4);
  });

  it('excludes other servers and unknown tools from the summary', () => {
    const harness = setup();
    const first = seedServer(harness, { name: 'first' });
    const second = seedServer(harness, { name: 'second' });
    const key = issueKey(harness, 'agent-key', 'agent');
    seedAudit(harness, first.id, { keyId: key.id, status: 'ok', latencyMs: 10, toolName: 'echo' });
    seedAudit(harness, second.id, { keyId: key.id, status: 'error', latencyMs: 20, toolName: 'echo' });

    const page = harness.inspector.activity(first.id);
    expect(page.total).toBe(1);
    expect(page.summary).toMatchObject({ total: 1, ok: 1, error: 0, denied: 0, errorRate: 0 });
    expect(page.summary.toolUsage[0]).toMatchObject({ name: 'echo', count: 1 });
  });

  it('throws TOOL_NOT_FOUND for an unknown server', () => {
    const harness = setup();
    try {
      harness.inspector.activity('srv_missing');
      throw new Error('expected activity to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe(ErrorCodes.TOOL_NOT_FOUND);
    }
  });
});
