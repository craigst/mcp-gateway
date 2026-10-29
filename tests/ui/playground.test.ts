import { describe, expect, it } from 'vitest';
import {
  buildRpcRequest,
  formatLatencyBreakdown,
  nextPlaygroundId,
  PLAYGROUND_METHODS,
} from '../../src/ui/lib/playground.js';

describe('buildRpcRequest', () => {
  it('builds an object-params JSON-RPC request', () => {
    const result = buildRpcRequest('tools/search', '{"query":"postgres","limit":5}', 'req-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).toEqual({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'tools/search',
      params: { query: 'postgres', limit: 5 },
    });
  });

  it('omits params when the editor is blank and accepts array params', () => {
    const noParams = buildRpcRequest('tools/list', '   ', 'req-2');
    expect(noParams.ok).toBe(true);
    if (noParams.ok) {
      expect('params' in noParams.request).toBe(false);
      expect(noParams.request.method).toBe('tools/list');
    }

    const arrayParams = buildRpcRequest('custom/method', '[1, 2, 3]', 'req-3');
    expect(arrayParams.ok).toBe(true);
    if (arrayParams.ok) expect(arrayParams.request.params).toEqual([1, 2, 3]);
  });

  it('reports invalid JSON instead of throwing', () => {
    const result = buildRpcRequest('tools/call', '{"name": ', 'req-4');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^Invalid JSON:/);
  });

  it('rejects primitive params and blank methods', () => {
    const primitives = ['42', '"just a string"', 'null', 'true'];
    for (const params of primitives) {
      const result = buildRpcRequest('tools/call', params, 'req-5');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('Params must be a JSON object or array');
    }

    const blankMethod = buildRpcRequest('  ', '{}', 'req-6');
    expect(blankMethod.ok).toBe(false);
    if (!blankMethod.ok) expect(blankMethod.error).toBe('Method is required');
  });

  it('generates unique request ids', () => {
    const first = nextPlaygroundId();
    const second = nextPlaygroundId();
    expect(first).not.toBe(second);
    expect(first.startsWith('ui-')).toBe(true);
  });
});

describe('formatLatencyBreakdown', () => {
  it('separates gateway overhead from sub-server time', () => {
    const breakdown = formatLatencyBreakdown(10, { gateway_overhead_ms: 1.4, sub_server_ms: 8 });
    expect(breakdown.gatewayOverheadMs).toBe(1.4);
    expect(breakdown.subServerMs).toBe(8);
    expect(breakdown.gatewayShare).toBeCloseTo(0.14, 5);
    expect(breakdown.subServerShare).toBeCloseTo(0.8, 5);
    expect(breakdown.summary).toContain('Gateway 1.4 ms');
    expect(breakdown.summary).toContain('Sub-server 8.0 ms');
    expect(breakdown.summary).toContain('Round-trip 10 ms');
  });

  it('handles missing timing metadata gracefully', () => {
    const breakdown = formatLatencyBreakdown(42, null);
    expect(breakdown.gatewayOverheadMs).toBeNull();
    expect(breakdown.subServerMs).toBeNull();
    expect(breakdown.gatewayShare).toBeNull();
    expect(breakdown.summary).toContain('Gateway —');
  });

  it('never reports shares above 100%', () => {
    const breakdown = formatLatencyBreakdown(5, { gateway_overhead_ms: 40, sub_server_ms: 60 });
    expect(breakdown.gatewayShare).toBe(1);
    expect(breakdown.subServerShare).toBe(1);
  });
});

describe('PLAYGROUND_METHODS', () => {
  it('covers the documented JSON-RPC ingress methods', () => {
    const methods = PLAYGROUND_METHODS.map((preset) => preset.method);
    expect(methods).toEqual(
      expect.arrayContaining([
        'initialize',
        'tools/list',
        'tools/search',
        'tools/call',
        'servers/list_permitted',
        'agents/delegate',
        'escalations/request',
      ]),
    );
    for (const preset of PLAYGROUND_METHODS) {
      expect(() => JSON.parse(preset.params)).not.toThrow();
      expect(preset.label.length).toBeGreaterThan(0);
    }
  });
});
