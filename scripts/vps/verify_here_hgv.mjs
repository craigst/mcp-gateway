#!/usr/bin/env node
/**
 * verify_here_hgv.mjs — end-to-end verification of the `here-hgv` MCP server THROUGH the gateway.
 *
 * Run ON the gateway host (VPS), with MK set to the master key:
 *   MK=$(grep -oP '^MCP_MASTER_KEY=\K.*' /opt/mcp-gateway/gateway.env) \
 *     node verify_here_hgv.mjs
 *
 * It opens ONE Streamable-HTTP MCP session at the gateway's /mcp/v1, lists the
 * tools it can see, then calls every here_* tool with real arguments and prints
 * a compact result line per tool. Nothing here targets the HERE API directly:
 * every call goes gateway -> supervised stdio server -> HERE.
 */

const URL_BASE = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8484/mcp/v1';
const KEY = process.env.MK;
if (!KEY) {
  console.error('MK (master key) is required');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${KEY}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

/** Parse either a JSON body or an SSE stream into the JSON-RPC message(s). */
async function readRpc(res) {
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        try {
          return JSON.parse(line.slice(5).trim());
        } catch {
          /* keep scanning */
        }
      }
    }
    throw new Error(`no JSON-RPC data in SSE body: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

async function rpc(body, sid, expectResponse = true) {
  const res = await fetch(URL_BASE, {
    method: 'POST',
    headers: sid ? { ...headers, 'mcp-session-id': sid } : headers,
    body: JSON.stringify(body),
  });
  if (expectResponse) return { msg: await readRpc(res), sid: res.headers.get('mcp-session-id') ?? sid };
  return { msg: null, sid: res.headers.get('mcp-session-id') ?? sid };
}

function pick(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  for (const key of keys) if (key in obj && obj[key] !== null && obj[key] !== undefined) return obj[key];
  for (const value of Object.values(obj)) {
    const found = pick(value, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function summarize(name, data) {
  if (!data || typeof data !== 'object') return String(data).slice(0, 160);
  const interesting = [
    'distanceKm', 'distanceText', 'durationText', 'trafficDelaySeconds', 'baseDurationSeconds',
    'travelTimes', 'count', 'title', 'jamFactor', 'criticality', 'type', 'points',
    'polygons', 'bytes', 'totalTollCost', 'price', 'cost', 'ok',
    'distance', 'duration', 'stopCount', 'status', 'numOrigins', 'numDestinations',
  ];
  const bits = [];
  for (const key of interesting) {
    const value = pick(data, [key]);
    if (value !== null && !(Array.isArray(value) && value.length === 0)) {
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
      bits.push(`${key}=${text.slice(0, 90)}`);
    }
  }
  const line = bits.slice(0, 8).join(' ');
  return line || `keys=${Object.keys(data).join(',')}`.slice(0, 200);
}

const TRUCK = { heightM: 4.2, grossWeightKg: 44000, axleCount: 6 };
const O = '53.4808,-2.2426'; // Manchester
const D = '53.8008,-1.5491'; // Leeds

const calls = [
  ['here_api_health', {}],
  ['here_geocode', { q: 'Trafford Park, Manchester', limit: 1 }],
  ['here_reverse_geocode', { latitude: 53.4808, longitude: -2.2426, limit: 1 }],
  ['here_search_places', { at: O, q: 'fuel station', limit: 2 }],
  ['here_autosuggest', { q: 'M1 post', at: O, limit: 2 }],
  ['here_route', {
    origin: O, destination: D, transportMode: 'truck', truck: TRUCK,
    departureTime: '2026-11-03T08:30:00+00:00', includeTolls: true, includeInstructions: true,
  }],
  ['here_route_tolls', { origin: O, destination: D, transportMode: 'truck', truck: TRUCK, currency: 'GBP' }],
  ['here_route_matrix', { origins: [O, '53.5,-2.3'], destinations: [D] }],
  ['here_isoline', { origin: O, rangeType: 'time', ranges: [900, 1800], transportMode: 'truck', truck: TRUCK }],
  ['here_waypoint_sequence', {
    start: O, end: D, waypoints: ['53.5,-2.2', '53.6,-2.1'], transportMode: 'truck', truck: TRUCK,
  }],
  ['here_traffic_incidents', { bbox: [-2.4, 53.4, -1.4, 53.9], limit: 3 }],
  ['here_traffic_flow', { bbox: [-2.4, 53.4, -1.4, 53.9], limit: 3 }],
  ['here_map_image', {
    latitude: 53.4808, longitude: -2.2426, zoom: 12, width: 640, height: 400,
    saveToFile: true, filename: 'gateway-verify-manchester.png',
  }],
  ['here_flexible_polyline_decode', { encoded: 'BFoz5xJ67i1B1B7PzIhaxL7Y' }],
];

const init = await rpc({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-here-hgv', version: '1' } },
});
// The gateway's /mcp/v1 is stateless: it may not issue a session id at all,
// in which case every request is authorised independently by the bearer key.
const sid = init.sid ?? null;
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid, false);

const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid);
const tools = list.msg?.result?.tools ?? [];
const hereTools = tools.filter((t) => t.name.startsWith('here_'));
console.log(`session=${sid ? sid.slice(0, 8) + '…' : 'stateless'}  tools=${tools.length}  here_*=${hereTools.length}`);
console.log(`here tools: ${hereTools.map((t) => t.name).join(', ')}\n`);

let id = 10;
let pass = 0;
let fail = 0;
for (const [name, args] of calls) {
  const t0 = performance.now();
  let line;
  try {
    const { msg } = await rpc({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }, sid);
    const ms = Math.round(performance.now() - t0);
    if (msg?.error) {
      line = `FAIL rpc ${JSON.stringify(msg.error).slice(0, 160)}`;
      fail++;
    } else {
      const result = msg?.result ?? {};
      const blocks = (result.content ?? []).filter((c) => c.type === 'text');
      // A tool returns the structured JSON block first and may add a short
      // human-readable summary block after it; parse the first JSON block only.
      let data = result.structuredContent ?? null;
      if (!data) {
        for (const block of blocks) {
          try { data = JSON.parse(block.text ?? ''); break; } catch { /* try next block */ }
        }
      }
      const text = (blocks.at(-1)?.text ?? '').trim();
      const meta = result._meta ?? {};
      const isErr = result.isError === true || data?.ok === false;
      const summary = data ? summarize(name, data) : text.slice(0, 200).replace(/\n/g, ' ');
      if (isErr) {
        line = `FAIL ${summary} (${meta.sub_server_ms ?? '?'}ms sub-server)`;
        fail++;
      } else {
        line = `OK   ${summary} (${meta.sub_server_ms ?? '?'}ms sub-server, ${ms}ms total)`;
        pass++;
      }
    }
  } catch (error) {
    line = `FAIL ${String(error).slice(0, 180)}`;
    fail++;
  }
  console.log(`${name.padEnd(30)} ${line}`);
}

console.log(`\n${pass} passed, ${fail} failed, ${calls.length} tools called through the gateway`);
process.exit(fail === 0 ? 0 : 1);
