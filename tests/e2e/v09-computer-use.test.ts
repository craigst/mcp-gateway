/**
 * v0.9 end-to-end: computer use.
 *
 *   - the gateway fronts a Computer Broker as the managed `computer-use` MCP server
 *   - tools are discovered and exposed through the normal RBAC/censorship layer
 *   - global and per-computer availability pauses refuse calls with -32001 and
 *     record a denied audit row; resuming restores access
 *   - console admin API: overview, fleet, settings, frames, start/stop, activity
 *   - console configuration: broker URL + vault-stored token enable the feature
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { createContainer, type GatewayContainer } from '../../src/container.js';
import type { GatewayConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import type {
  BrokerComputerSnapshot,
  BrokerDeviceSnapshot,
  BrokerEnrollmentCreated,
  BrokerEnrollmentSnapshot,
  ComputerUseBrokerHealth,
  ComputerUseBrokerPort,
  ComputerUseFrameResult,
} from '../../src/core/ports.js';

const MASTER_KEY = `mcp_master_${'e'.repeat(48)}`;
const VAULT_SECRET = 'v09-vault-secret-0123456789abcdefgh';
const BROKER_URL = 'https://broker.test:7443';
const rootDir = join(process.cwd(), '.test-data', `v09-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);

function buildConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir: join(rootDir, 'data'),
    dbPath: join(rootDir, 'data', 'gateway.db'),
    uiDistDir: join(rootDir, 'ui'),
    vaultSecret: VAULT_SECRET,
    bootstrapMasterKey: MASTER_KEY,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: [],
    reposDir: join(rootDir, 'repos'),
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 10_000,
    keyPepper: null,
    publicBaseUrl: 'http://127.0.0.1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A fake Computer Broker (same interfaces, no network)
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = [
  { name: 'list_templates', description: 'List templates', inputSchema: { type: 'object' } },
  { name: 'list_computers', description: 'List computers', inputSchema: { type: 'object' } },
  { name: 'computer_status', description: 'Computer status', inputSchema: { type: 'object' } },
  { name: 'computer_screenshot', description: 'Screenshot', inputSchema: { type: 'object' } },
  { name: 'computer_click', description: 'Click', inputSchema: { type: 'object' } },
  { name: 'computer_type', description: 'Type', inputSchema: { type: 'object' } },
  { name: 'start_computer', description: 'Start', inputSchema: { type: 'object' } },
  { name: 'stop_computer', description: 'Stop', inputSchema: { type: 'object' } },
  { name: 'destroy_computer', description: 'Destroy', inputSchema: { type: 'object' } },
  { name: 'list_devices', description: 'List devices', inputSchema: { type: 'object' } },
  { name: 'device_exec', description: 'Exec', inputSchema: { type: 'object' } },
];

function computer(id: string, name: string, state = 'ready'): BrokerComputerSnapshot {
  return {
    id,
    name,
    template: 'desktop-base',
    provider: 'container',
    state,
    viewer: 'rfb',
    error: null,
    createdAt: '2026-10-29T22:00:00Z',
    ttlAt: '2026-10-29T23:30:00Z',
    desktop: { viewer: 'rfb', width: 1280, height: 800 },
    connector: { state: 'online', version: '1.0.0', lastSeen: '2026-10-29T23:00:00Z' },
    control: { held: false, holder: null, heldSince: null, expiresAt: null },
  };
}

class FakeBroker implements ComputerUseBrokerPort {
  readonly baseUrl = BROKER_URL;
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly computers = new Map<string, BrokerComputerSnapshot>([
    ['cmp_alpha', computer('cmp_alpha', 'alpha')],
    ['cmp_beta', computer('cmp_beta', 'beta')],
  ]);
  token: string | null;

  constructor(token: string | null) {
    this.token = token;
  }

  async health(): Promise<ComputerUseBrokerHealth> {
    return { ok: true, version: '1.0.0', computers: this.computers.size, devices: 1, connectorsOnline: 2, tls: true };
  }

  async listComputers(): Promise<BrokerComputerSnapshot[]> {
    return [...this.computers.values()];
  }

  async getComputer(id: string): Promise<BrokerComputerSnapshot> {
    const found = this.computers.get(id);
    if (!found) throw new Error('unknown computer');
    return found;
  }

  async startComputer(id: string): Promise<BrokerComputerSnapshot> {
    const found = { ...(await this.getComputer(id)), state: 'ready' };
    this.computers.set(id, found);
    return found;
  }

  async stopComputer(id: string): Promise<BrokerComputerSnapshot> {
    const found = { ...(await this.getComputer(id)), state: 'stopped' };
    this.computers.set(id, found);
    return found;
  }

  async frame(_id: string, _maxWidth: number): Promise<ComputerUseFrameResult> {
    return { data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), contentType: 'image/jpeg', frameTime: '2026-10-29T23:00:00Z' };
  }

  async rpc(method: string, params?: unknown): Promise<unknown> {
    if (method === 'tools/list') return { tools: TOOL_DEFINITIONS };
    if (method === 'tools/call') {
      const call = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      this.calls.push({ name: String(call.name), args: call.arguments ?? {} });
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, op: call.name, args: call.arguments ?? {} }) }],
        isError: false,
      };
    }
    return {};
  }

  // v0.10 connector/terminal surface: the v0.9 scenarios do not use it, but the
  // port requires it, so these are deliberately minimal stubs.
  async devices(): Promise<BrokerDeviceSnapshot[]> {
    return [];
  }

  async enrollments(): Promise<BrokerEnrollmentSnapshot[]> {
    return [];
  }

  async createEnrollment(input: { kind: 'device' | 'computer'; ttlSeconds: number }): Promise<BrokerEnrollmentCreated> {
    const now = Date.now();
    return {
      id: 'enr_stub',
      kind: input.kind,
      token: 'brk_stub_token',
      expiresAt: new Date(now + input.ttlSeconds * 1_000).toISOString(),
      createdAt: new Date(now).toISOString(),
    };
  }

  async revokeEnrollment(_enrollmentId: string): Promise<void> {
    // no-op stub
  }

  async createHandoff(_input: { to: string; ttlSeconds: number }): Promise<{ token: string; expiresAt: string; path: string }> {
    return {
      token: 'handoff-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      path: '/login/handoff?token=handoff-token',
    };
  }

  async deviceCall(
    _deviceId: string,
    _op: string,
    _args?: Record<string, unknown>,
  ): Promise<unknown> {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface JsonResponse {
  status: number;
  body: any;
}

function makeHttp(baseUrl: string, key: string) {
  const admin = async (method: string, path: string, body?: unknown): Promise<JsonResponse> => {
    const response = await fetch(`${baseUrl}/mcp/v1/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const rpc = async (
    callKey: string,
    method: string,
    params?: unknown,
  ): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${baseUrl}/mcp/v1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${callKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { admin, rpc };
}

async function callTool(
  rpc: (key: string, method: string, params?: unknown) => Promise<{ status: number; body: any }>,
  key: string,
  serverId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const response = await rpc(key, 'tools/call', { name, serverId, arguments: args });
  return response.body;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v0.9 computer use (configured from env)', () => {
  let container: GatewayContainer | null = null;
  let baseUrl = '';
  let broker: FakeBroker;
  let http: ReturnType<typeof makeHttp>;
  let agentKey = '';
  let serverId = '';

  afterAll(async () => {
    await container?.stop();
    container = null;
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('registers the managed computer-use server and exposes its tools', async () => {
    broker = new FakeBroker('brk_env_token');
    const config = buildConfig({
      computerUse: {
        enabled: true,
        brokerUrl: BROKER_URL,
        brokerToken: 'brk_env_token',
        publicBrokerUrl: BROKER_URL,
        caFile: null,
      },
    });
    mkdirSync(config.dataDir, { recursive: true });
    container = createContainer({
      config,
      logger: createLogger('test', 'silent'),
      computerUseBrokerFactory: ({ token }) => {
        broker.token = token;
        return broker;
      },
    });
    const address = await container.start();
    baseUrl = address.url;
    http = makeHttp(baseUrl, MASTER_KEY);

    const managed = container.services.repository.getServerByName('computer-use');
    expect(managed).not.toBeNull();
    expect(managed?.status).toBe('running');
    expect(managed?.url).toBe(`${BROKER_URL}/mcp`);
    expect(managed?.highPrivilegeTools).toContain('computer_click');
    expect(managed?.highPrivilegeTools).not.toContain('computer_status');
    expect(container.services.repository.listToolsByServer(managed?.id as string)).toHaveLength(
      TOOL_DEFINITIONS.length,
    );
    serverId = managed?.id as string;
  });

  it('reports the broker and fleet in the console overview', async () => {
    const overview = await http.admin('GET', '/computer-use');
    expect(overview.status).toBe(200);
    expect(overview.body.settings.brokerUrl).toBe(BROKER_URL);
    expect(overview.body.settings.tokenConfigured).toBe(true);
    expect(overview.body.settings.tokenSource).toBe('env');
    expect(overview.body.broker.reachable).toBe(true);
    expect(overview.body.server).toMatchObject({ id: serverId, status: 'running' });
    expect(overview.body.counts).toMatchObject({ computers: 2, available: 2, ready: 2 });
    expect(overview.body.availability.available).toBe(true);

    const computers = await http.admin('GET', '/computer-use/computers');
    expect(computers.status).toBe(200);
    expect(computers.body.computers).toHaveLength(2);
    expect(computers.body.computers[0]).toMatchObject({
      id: 'cmp_alpha',
      name: 'alpha',
      state: 'ready',
      availability: { available: true },
      liveUrl: `${BROKER_URL}/#/d/cmp_alpha`,
    });
  });

  it('issues an agent key with a read-only + high-privilege tool grant', async () => {
    const created = await http.admin('POST', '/keys/create', {
      name: 'computer-agent',
      keyType: 'agent',
      serverGrants: [
        {
          serverId,
          tools: ['list_computers', 'computer_status', 'computer_screenshot'],
          highPrivilegeTools: ['computer_click'],
        },
      ],
    });
    expect(created.status).toBe(201);
    agentKey = created.body.plaintext as string;

    const listed = await http.rpc(agentKey, 'tools/list', {});
    const names = (listed.body.result.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
    expect(names).toEqual(['computer_click', 'computer_screenshot', 'computer_status', 'list_computers']);
  });

  it('executes a computer-use tool through the gateway', async () => {
    const result = await callTool(http.rpc, agentKey, serverId, 'computer_status', { computer_id: 'cmp_alpha' });
    expect(result.result.isError).toBe(false);
    expect(broker.calls.at(-1)).toMatchObject({ name: 'computer_status', args: { computer_id: 'cmp_alpha' } });
  });

  it('refuses every call while global availability is paused and audits the refusal', async () => {
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const paused = await http.admin('POST', '/computer-use/availability', {
      scope: 'global',
      available: false,
      reason: 'Lunch break',
      until,
    });
    expect(paused.status).toBe(200);
    expect(paused.body.availability).toMatchObject({ available: false, state: 'paused', reason: 'Lunch break', until });
    expect(paused.body.counts.available).toBe(0);

    const refused = await callTool(http.rpc, agentKey, serverId, 'computer_status', { computer_id: 'cmp_alpha' });
    expect(refused.error.code).toBe(-32001);
    expect(refused.error.data).toMatchObject({
      status: 'COMPUTER_UNAVAILABLE',
      reason: 'COMPUTER_USE_PAUSED',
      server_id: serverId,
    });
    expect(refused.error.data.details).toMatchObject({ computer_id: 'cmp_alpha', resume_at: until });

    const activity = await http.admin('GET', '/computer-use/activity?limit=10');
    expect(activity.status).toBe(200);
    const denied = activity.body.activity.find((entry: any) => entry.status === 'denied');
    expect(denied).toBeDefined();
    expect(JSON.stringify(denied.payload)).toContain('COMPUTER_USE_PAUSED');

    const resumed = await http.admin('POST', '/computer-use/availability', {
      scope: 'global',
      available: true,
    });
    expect(resumed.body.availability.available).toBe(true);
    const allowed = await callTool(http.rpc, agentKey, serverId, 'computer_status', { computer_id: 'cmp_alpha' });
    expect(allowed.result.isError).toBe(false);
  });

  it('pauses one computer without affecting the other', async () => {
    const paused = await http.admin('POST', '/computer-use/availability', {
      scope: 'computer',
      computerId: 'cmp_beta',
      available: false,
      reason: 'Operator using beta',
    });
    expect(paused.status).toBe(200);
    const beta = (paused.body.counts as { available: number; paused: number });
    expect(beta.available).toBe(1);
    expect(beta.paused).toBe(1);

    const refused = await callTool(http.rpc, agentKey, serverId, 'computer_status', { computer_id: 'cmp_beta' });
    expect(refused.error.code).toBe(-32001);
    expect(refused.error.data.reason).toBe('COMPUTER_PAUSED');
    expect(refused.error.data.details.computer_id).toBe('cmp_beta');

    const alpha = await callTool(http.rpc, agentKey, serverId, 'computer_status', { computer_id: 'cmp_alpha' });
    expect(alpha.result.isError).toBe(false);

    const fleet = await http.admin('GET', '/computer-use/computers');
    const betaComputer = (fleet.body.computers as any[]).find((entry) => entry.id === 'cmp_beta');
    expect(betaComputer.availability).toMatchObject({ available: false, reason: 'Operator using beta' });

    await http.admin('POST', '/computer-use/availability', {
      scope: 'computer',
      computerId: 'cmp_beta',
      available: true,
    });
    const resumed = await callTool(http.rpc, agentKey, serverId, 'computer_status', { computer_id: 'cmp_beta' });
    expect(resumed.result.isError).toBe(false);
  });

  it('serves frame previews and start/stop through the console API', async () => {
    const frame = await fetch(`${baseUrl}/mcp/v1/admin/computer-use/computers/cmp_alpha/frame?maxWidth=320`, {
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });
    expect(frame.status).toBe(200);
    expect(frame.headers.get('content-type')).toBe('image/jpeg');
    expect(frame.headers.get('cache-control')).toContain('no-store');
    expect(Buffer.from(await frame.arrayBuffer()).equals(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBe(true);

    const stopped = await http.admin('POST', '/computer-use/computers/cmp_alpha/stop');
    expect(stopped.status).toBe(200);
    expect(stopped.body.computer.state).toBe('stopped');

    const started = await http.admin('POST', '/computer-use/computers/cmp_alpha/start');
    expect(started.status).toBe(200);
    expect(started.body.computer.state).toBe('ready');
  });

  it('updates connection settings and re-syncs the managed server', async () => {
    const updated = await http.admin('POST', '/computer-use/settings', {
      publicBrokerUrl: 'https://desk.example.test:7443',
      enabled: true,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.settings.publicBrokerUrl).toBe('https://desk.example.test:7443');

    const fleet = await http.admin('GET', '/computer-use/computers');
    expect(fleet.body.computers[0].liveUrl).toBe('https://desk.example.test:7443/#/d/cmp_alpha');

    const synced = await http.admin('POST', '/computer-use/sync');
    expect(synced.status).toBe(200);
    expect(synced.body.server.status).toBe('running');
  });

  it('rejects availability timestamps in the past and unknown admin routes', async () => {
    const past = await http.admin('POST', '/computer-use/availability', {
      scope: 'global',
      available: false,
      until: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(past.status).toBe(400);

    const missing = await http.admin('GET', '/computer-use/nope');
    expect(missing.status).toBe(404);
  });
});

describe('v0.9 computer use (configured from the console)', () => {
  let container: GatewayContainer | null = null;
  let baseUrl = '';
  let broker: FakeBroker;
  let http: ReturnType<typeof makeHttp>;

  afterAll(async () => {
    await container?.stop();
    container = null;
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('is absent until a broker URL and vault token are configured', async () => {
    broker = new FakeBroker(null);
    const config = buildConfig({
      dataDir: join(rootDir, 'console-data'),
      dbPath: join(rootDir, 'console-data', 'gateway.db'),
      computerUse: {
        enabled: true,
        brokerUrl: null,
        brokerToken: null,
        publicBrokerUrl: null,
        caFile: null,
      },
    });
    mkdirSync(config.dataDir, { recursive: true });
    container = createContainer({
      config,
      logger: createLogger('test', 'silent'),
      computerUseBrokerFactory: ({ token }) => {
        broker.token = token;
        return broker;
      },
    });
    const address = await container.start();
    baseUrl = address.url;
    http = makeHttp(baseUrl, MASTER_KEY);

    const overview = await http.admin('GET', '/computer-use');
    expect(overview.status).toBe(200);
    expect(overview.body.settings.brokerUrl).toBeNull();
    expect(overview.body.settings.tokenConfigured).toBe(false);
    expect(overview.body.server.id).toBeNull();
    expect(container.services.repository.getServerByName('computer-use')).toBeNull();

    const computers = await http.admin('GET', '/computer-use/computers');
    expect(computers.body.computers).toEqual([]);
  });

  it('enables computer use by storing the token in the encrypted vault', async () => {
    const updated = await http.admin('POST', '/computer-use/settings', {
      brokerUrl: BROKER_URL,
      token: 'brk_vault_token',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.settings).toMatchObject({
      brokerUrl: BROKER_URL,
      tokenConfigured: true,
      tokenSource: 'vault',
    });
    expect(updated.body.server).toMatchObject({ status: 'running' });
    expect(updated.body.tools.length).toBe(TOOL_DEFINITIONS.length);

    // The token is in the vault, not on the managed server row.
    const managed = container?.services.repository.getServerByName('computer-use');
    expect(JSON.stringify(managed)).not.toContain('brk_vault_token');
    expect(container?.services.vault.getSecret('computer_broker_token')).toBe('brk_vault_token');
  });

  it('can disable the feature and remove the managed server', async () => {
    const disabled = await http.admin('POST', '/computer-use/settings', { enabled: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.server.id).toBeNull();
    expect(container?.services.repository.getServerByName('computer-use')).toBeNull();
  });
});
