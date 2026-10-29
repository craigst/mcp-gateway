/** JSON-RPC playground helpers: request construction + latency breakdown. */
import { formatDuration } from './format.js';

let requestCounter = 0;

export interface RpcRequestObject {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: unknown;
}

export type BuildRpcRequestResult =
  | { ok: true; request: RpcRequestObject }
  | { ok: false; error: string };

export function nextPlaygroundId(): string {
  requestCounter += 1;
  return `ui-${requestCounter}`;
}

/**
 * Build a JSON-RPC request from a method + raw params text.
 * Returns a typed error (never throws) so the editor can show inline feedback.
 */
export function buildRpcRequest(
  method: string,
  paramsJson: string,
  id: string = nextPlaygroundId(),
): BuildRpcRequestResult {
  const trimmedMethod = method.trim();
  if (trimmedMethod.length === 0) return { ok: false, error: 'Method is required' };

  const request: RpcRequestObject = { jsonrpc: '2.0', id, method: trimmedMethod };
  const trimmedParams = paramsJson.trim();
  if (trimmedParams.length === 0) return { ok: true, request };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedParams) as unknown;
  } catch (error) {
    return { ok: false, error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, error: 'Params must be a JSON object or array' };
  }
  request.params = parsed;
  return { ok: true, request };
}

export interface LatencyBreakdown {
  roundTripMs: number;
  gatewayOverheadMs: number | null;
  subServerMs: number | null;
  /** Gateway overhead as a share of the round trip (0..1), when known. */
  gatewayShare: number | null;
  /** Sub-server time as a share of the round trip (0..1), when known. */
  subServerShare: number | null;
  summary: string;
}

/** Normalise the gateway timing `_meta` into a renderable latency breakdown. */
export function formatLatencyBreakdown(
  roundTripMs: number,
  meta?: { gateway_overhead_ms?: number | null; sub_server_ms?: number | null } | null,
): LatencyBreakdown {
  const gatewayOverheadMs =
    meta && typeof meta.gateway_overhead_ms === 'number' ? meta.gateway_overhead_ms : null;
  const subServerMs = meta && typeof meta.sub_server_ms === 'number' ? meta.sub_server_ms : null;
  const share = (part: number | null): number | null =>
    part !== null && roundTripMs > 0 ? Math.min(1, part / roundTripMs) : null;

  const parts: string[] = [];
  parts.push(`Gateway ${gatewayOverheadMs === null ? '—' : formatDuration(gatewayOverheadMs)}`);
  parts.push(`Sub-server ${subServerMs === null ? '—' : formatDuration(subServerMs)}`);
  parts.push(`Round-trip ${formatDuration(roundTripMs)}`);

  return {
    roundTripMs,
    gatewayOverheadMs,
    subServerMs,
    gatewayShare: share(gatewayOverheadMs),
    subServerShare: share(subServerMs),
    summary: parts.join(' · '),
  };
}

export interface PlaygroundMethodPreset {
  method: string;
  label: string;
  params: string;
}

/** Method presets shown in the playground picker. */
export const PLAYGROUND_METHODS: readonly PlaygroundMethodPreset[] = [
  { method: 'initialize', label: 'initialize — handshake', params: '{\n  "protocolVersion": "2025-06-18",\n  "capabilities": {}\n}' },
  { method: 'tools/list', label: 'tools/list — discover tools', params: '{}' },
  {
    method: 'tools/search',
    label: 'tools/search — ranked search',
    params: '{\n  "query": "database postgres query",\n  "limit": 5\n}',
  },
  {
    method: 'tools/call',
    label: 'tools/call — invoke tool',
    params: '{\n  "name": "echo",\n  "arguments": { "message": "hello gateway" }\n}',
  },
  { method: 'servers/list_permitted', label: 'servers/list_permitted — zero-trust menu', params: '{}' },
  {
    method: 'agents/delegate',
    label: 'agents/delegate — observer delegation',
    params: '{\n  "targetId": "observer-bot",\n  "payload": { "action": "deploy" },\n  "mode": "observe_and_verify"\n}',
  },
  {
    method: 'escalations/request',
    label: 'escalations/request — raise ticket',
    params:
      '{\n  "toolId": "db:drop_table",\n  "reason": "HIGH_PRIVILEGE_RESTRICTION",\n  "requestPayload": {}\n}',
  },
];
