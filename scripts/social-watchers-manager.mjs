#!/usr/bin/env node
/**
 * Supervisor + MCP facade for the Remy watchers.
 *
 * The watcher code is the existing Python worker. It reads its allowlist/auto-like
 * settings from this gateway (`WATCHER_BASE_URL`) and delivers private webhook
 * events. The manager keeps both source workers alive and exposes their status
 * as one local MCP server, so they survive a laptop shutdown and a gateway
 * restart through the normal server supervisor.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const ROOT = process.env.WATCHER_ROOT ?? '/data/repos/remy-watchers';
const SCRIPT = `${ROOT}/remy_watchers.py`;
const PYTHON = process.env.WATCHER_PYTHON ?? '/data/repos/instagram-mcp/.venv/bin/python';
const LOG = process.env.WATCHER_LOG ?? `${ROOT}/watchers.log`;
const configuredDelay = Number(process.env.WATCHER_RESTART_DELAY_MS ?? '15000');
const RESTART_DELAY_MS = Number.isFinite(configuredDelay) ? Math.max(0, configuredDelay) : 15000;
mkdirSync(ROOT, { recursive: true });

const sources = new Map();
let shuttingDown = false;

function log(line) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging failure must not stop a watcher.
  }
}

function instagramSessionExpired() {
  const file = process.env.WATCHER_INSTAGRAM_STATE_FILE ?? `${process.env.IG_CONFIG_DIR ?? '/data/secrets/instagram'}/state.json`;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    const error = Date.parse(state.last_error_at ?? '');
    const ok = Date.parse(state.last_ok_at ?? '');
    return Number.isFinite(error) && (!Number.isFinite(ok) || error >= ok);
  } catch {
    // Missing state is unknown, not proof of expiry; keep existing startup behavior.
    return false;
  }
}

function startSource(source) {
  if (shuttingDown) return;
  const previous = sources.get(source);
  if (previous?.pid) return;
  if (source === 'instagram' && instagramSessionExpired()) {
    sources.set(source, { source, pid: null, startedAt: null, restarts: previous?.restarts ?? 0,
      lastExit: previous?.lastExit ?? null, lastError: 'Saved Instagram session is expired; refresh the session before restarting.', restartRequested: false });
    log('instagram paused: saved session is expired');
    return;
  }
  const child = spawn(PYTHON, [SCRIPT, source], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = {
    source,
    pid: child.pid ?? null,
    startedAt: new Date().toISOString(),
    restarts: (sources.get(source)?.restarts ?? 0) + (sources.has(source) ? 1 : 0),
    lastExit: null,
    lastError: null,
    restartRequested: false,
  };
  sources.set(source, state);
  const pump = (stream, level) => {
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    reader.on('line', (line) => {
      if (line.trim() === '') return;
      log(`${source} ${level} ${line}`);
      if (level === 'stderr') state.lastError = line;
    });
  };
  pump(child.stdout, 'stdout');
  pump(child.stderr, 'stderr');
  let finished = false;
  const finish = (code, signal, error) => {
    if (finished || sources.get(source) !== state) return;
    finished = true;
    state.pid = null;
    state.lastExit = { code, signal, at: new Date().toISOString() };
    if (error) state.lastError = `worker failed to start: ${error.code ?? error.name}`;
    log(`${source} exited code=${code} signal=${signal}`);
    if (!shuttingDown && code !== 2) {
      const timer = setTimeout(() => startSource(source), state.restartRequested ? 0 : RESTART_DELAY_MS);
      timer.unref();
    } else if (code === 2) {
      state.lastError = 'exit 2: Instagram challenge/login required; restart with watchers_restart after re-authentication';
      log(`${source} paused: exit 2 (challenge/login required)`);
    }
  };
  child.on('error', (error) => finish(null, null, error));
  child.on('exit', (code, signal) => finish(code, signal, null));
}

// Every source the worker code can run. YouTube is here because its settings
// surface has existed since 0.15.6 and the operator had already switched the
// Shorts toggle ON — with no worker, those settings were decoration.
// X was not previously started by the manager. Starting it can poll paid APIs
// and apply the saved auto-like settings, so it must be deliberately enabled.
const SOURCES = ['whatsapp', 'instagram', 'youtube', ...(/^(1|true|yes)$/i.test(process.env.WATCHER_ENABLE_X ?? '') ? ['x'] : [])];

for (const source of SOURCES) startSource(source);

function status() {
  return {
    ok: true,
    pid: process.pid,
    gateway: process.env.WATCHER_BASE_URL ?? null,
    stateDb: process.env.REMY_STATE_DB ?? null,
    sources: [...sources.values()],
    logFile: LOG,
  };
}

const tools = [
  { name: 'watchers_status', description: `Status of the managed ${SOURCES.join(', ')} workers, including restarts and last exit.`, inputSchema: { type: 'object', properties: {} } },
  { name: 'watchers_restart', description: `Restart the managed ${SOURCES.join(', ')} workers.`, inputSchema: { type: 'object', properties: {} } },
];

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function restart() {
  for (const source of SOURCES) {
    const state = sources.get(source);
    if (state?.pid) {
      state.restartRequested = true;
      try { process.kill(state.pid); } catch { /* already gone */ }
    } else {
      startSource(source);
    }
  }
  return status();
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  if (request.id === undefined) return;
  if (request.method === 'initialize') {
    write({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'social-watchers', version: '1.0.0' } } });
    return;
  }
  if (request.method === 'ping') { write({ jsonrpc: '2.0', id: request.id, result: {} }); return; }
  if (request.method === 'tools/list') { write({ jsonrpc: '2.0', id: request.id, result: { tools } }); return; }
  if (request.method === 'tools/call') {
    const name = request.params?.name;
    try {
      if (name !== 'watchers_restart' && name !== 'watchers_status') {
        write({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown tool' } });
        return;
      }
      const value = name === 'watchers_restart' ? restart() : status();
      write({ jsonrpc: '2.0', id: request.id, result: text(value) });
    } catch (error) {
      write({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: String(error) }], isError: true } });
    }
    return;
  }
  write({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } });
});

function shutdown() {
  shuttingDown = true;
  for (const state of sources.values()) {
    if (state.pid) { try { process.kill(state.pid); } catch { /* gone */ } }
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
