/**
 * v0.10 end-to-end: connector onboarding, pairing and terminal control.
 *
 *   - the connectors console lists broker devices (terminal capability derived
 *     from the advertised term.* ops) and live pairing tokens
 *   - a pairing token is minted once and rendered into a shell-safe one-line
 *     installer command for the new Linux PC
 *   - tokens can be revoked
 *   - terminal open/send/read/close are proxied to the broker, with clamping
 *     and a clear error for a connector without the terminal policy
 *   - the whole surface is master-only (agent keys are refused)
 *   - without a public broker URL the page still renders and pairing explains
 *     what to configure instead of failing obscurely
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

const MASTER_KEY = `mcp_master_${'f'.repeat(48)}`;
const VAULT_SECRET = 'v010-vault-secret-0123456789abcdefgh';
const BROKER_URL = 'https://broker.test:7443';
const rootDir = join(process.cwd(), '.test-data', `v010-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);

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
    computerUse: {
      enabled: true,
      brokerUrl: BROKER_URL,
      brokerToken: 'brk_admin_token',
      publicBrokerUrl: BROKER_URL,
      caFile: null,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A fake Computer Broker (no network)
// ---------------------------------------------------------------------------

const TERMINAL_CAPS = ['exec.argv', 'term.open', 'term.send', 'term.read', 'term.close'];

class FakeBroker implements ComputerUseBrokerPort {
  readonly baseUrl = BROKER_URL;
  readonly devicesList: BrokerDeviceSnapshot[] = [
    {
      id: 'dev_builder',
      name: 'builder',
      state: 'online',
      location: 'office',
      tags: ['linux', 'ubuntu'],
      capabilities: TERMINAL_CAPS,
      meta: { hostname: 'builder', platform: 'linux', version: '0.10.0' },
      lastSeen: '2026-10-29T23:58:00Z',
    },
    {
      id: 'dev_files',
      name: 'files',
      state: 'offline',
      location: null,
      tags: [],
      capabilities: ['file.list', 'file.read'],
      meta: null,
      lastSeen: null,
    },
  ];
  readonly enrollmentsList: BrokerEnrollmentSnapshot[] = [
    {
      id: 'enr_pending',
      kind: 'device',
      expiresAt: '2026-10-30T00:30:00Z',
      createdAt: '2026-10-29T23:30:00Z',
    },
  ];
  readonly enrollmentRequests: Array<{ kind: 'device' | 'computer'; ttlSeconds: number }> = [];
  readonly revoked: string[] = [];
  readonly deviceCalls: Array<{ deviceId: string; op: string; args: Record<string, unknown> }> = [];
  token: string | null;

  constructor(token: string | null) {
    this.token = token;
  }

  async health(): Promise<ComputerUseBrokerHealth> {
    return {
      ok: true,
      version: '0.10.0',
      computers: 0,
      devices: this.devicesList.length,
      connectorsOnline: 1,
      tls: true,
    };
  }

  async listComputers(): Promise<BrokerComputerSnapshot[]> {
    return [];
  }

  async getComputer(_computerId: string): Promise<BrokerComputerSnapshot> {
    throw new Error('not used in v0.10 connector tests');
  }

  async startComputer(_computerId: string): Promise<BrokerComputerSnapshot> {
    throw new Error('not used in v0.10 connector tests');
  }

  async stopComputer(_computerId: string): Promise<BrokerComputerSnapshot> {
    throw new Error('not used in v0.10 connector tests');
  }

  async frame(_computerId: string, _maxWidth: number): Promise<ComputerUseFrameResult> {
    return { data: Buffer.from([]), contentType: 'image/jpeg', frameTime: null };
  }

  async rpc(_method: string, _params?: unknown): Promise<unknown> {
    return {};
  }

  async devices(): Promise<BrokerDeviceSnapshot[]> {
    return this.devicesList;
  }

  async enrollments(): Promise<BrokerEnrollmentSnapshot[]> {
    return this.enrollmentsList;
  }

  async createEnrollment(input: {
    kind: 'device' | 'computer';
    ttlSeconds: number;
  }): Promise<BrokerEnrollmentCreated> {
    this.enrollmentRequests.push({ kind: input.kind, ttlSeconds: input.ttlSeconds });
    return {
      id: 'enr_new_1',
      kind: input.kind,
      token: 'tok_pair_abc123',
      expiresAt: '2026-10-30T01:00:00Z',
      createdAt: '2026-10-30T00:00:00Z',
    };
  }

  async revokeEnrollment(enrollmentId: string): Promise<void> {
    this.revoked.push(enrollmentId);
  }

  async createHandoff(_input: { to: string; ttlSeconds: number }): Promise<{ token: string; expiresAt: string; path: string }> {
    return {
      token: 'handoff-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      path: '/login/handoff?token=handoff-token',
    };
  }

  async deviceCall(
    deviceId: string,
    op: string,
    args?: Record<string, unknown>,
  ): Promise<unknown> {
    this.deviceCalls.push({ deviceId, op, args: args ?? {} });
    if (op === 'term.open') return { session: 'sess_1' };
    if (op === 'term.read') return { lines: ['$ echo hi', 'hi'], changed: true };
    if (op === 'term.send' || op === 'term.close') return { ok: true };
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

function makeHttp(baseUrl: string) {
  const admin = async (
    method: string,
    path: string,
    body?: unknown,
    key: string = MASTER_KEY,
  ): Promise<JsonResponse> => {
    const response = await fetch(`${baseUrl}/mcp/v1/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { admin };
}

function startContainer(config: GatewayConfig, broker?: FakeBroker): GatewayContainer {
  mkdirSync(config.dataDir, { recursive: true });
  return createContainer({
    config,
    logger: createLogger('test', 'silent'),
    ...(broker === undefined
      ? {}
      : {
          computerUseBrokerFactory: ({ token }) => {
            broker.token = token;
            return broker;
          },
        }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v0.10 connectors, pairing and terminal', () => {
  let container: GatewayContainer | null = null;
  let baseUrl = '';
  let broker: FakeBroker;
  let http: ReturnType<typeof makeHttp>;

  afterAll(async () => {
    await container?.stop();
    container = null;
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('lists broker devices, pairing tokens and counts', async () => {
    broker = new FakeBroker('brk_admin_token');
    container = startContainer(buildConfig(), broker);
    baseUrl = (await container.start()).url;
    http = makeHttp(baseUrl);

    const connectors = await http.admin('GET', '/computer-use/connectors');
    expect(connectors.status).toBe(200);
    expect(connectors.body.publicBrokerUrl).toBe(BROKER_URL);
    expect(connectors.body.broker).toMatchObject({
      configured: true,
      reachable: true,
      url: BROKER_URL,
      devices: 2,
    });
    expect(connectors.body.devices).toHaveLength(2);
    expect(connectors.body.devices[0]).toMatchObject({
      id: 'dev_builder',
      name: 'builder',
      state: 'online',
      location: 'office',
      tags: ['linux', 'ubuntu'],
      terminalCapable: true,
      meta: { hostname: 'builder', platform: 'linux', version: '0.10.0' },
      lastSeen: '2026-10-29T23:58:00Z',
    });
    expect(connectors.body.devices[1]).toMatchObject({
      id: 'dev_files',
      state: 'offline',
      location: null,
      capabilities: ['file.list', 'file.read'],
      terminalCapable: false,
      meta: null,
    });
    expect(connectors.body.enrollments).toEqual([
      {
        id: 'enr_pending',
        kind: 'device',
        expiresAt: '2026-10-30T00:30:00Z',
        createdAt: '2026-10-29T23:30:00Z',
      },
    ]);
    expect(connectors.body.counts).toEqual({ devices: 2, online: 1, pendingEnrollments: 1 });
  });

  it('hands the live desktop off to a broker-signed console session', async () => {
    const response = await fetch(`${baseUrl}/mcp/v1/admin/computer-use/computers/cmp_test/live-desktop`, {
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      redirect: 'manual',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${BROKER_URL}/login/handoff?token=handoff-token`);
  });

  it('mints a pairing token and a shell-safe installer command', async () => {
    const created = await http.admin('POST', '/computer-use/connectors/enrollments', {
      kind: 'device',
      name: '  builder\u0001 01 ',
      allowTerminal: true,
      ttlSeconds: 5,
    });
    expect(created.status).toBe(200);
    expect(created.body.enrollment).toMatchObject({
      id: 'enr_new_1',
      kind: 'device',
      token: 'tok_pair_abc123',
      expiresAt: '2026-10-30T01:00:00Z',
      createdAt: '2026-10-30T00:00:00Z',
    });
    expect(created.body.install).toMatchObject({
      brokerUrl: BROKER_URL,
      connectorUrl: 'wss://broker.test:7443/connector',
      caUrl: `${BROKER_URL}/install/broker-ca.pem`,
      allowTerminal: true,
      expiresAt: '2026-10-30T01:00:00Z',
    });

    const command = created.body.install.command as string;
    expect(command).toContain(`${BROKER_URL}/install/install-connector.sh`);
    expect(command).toContain("--broker 'wss://broker.test:7443/connector'");
    expect(command).toContain("--enroll 'tok_pair_abc123'");
    expect(command).toContain("--name 'builder 01'");
    expect(command).toContain('--terminal');
    expect(command.startsWith('curl -fsSLk ')).toBe(true);
    expect(command).toContain('| bash -s --');
    // The token is clamped to the broker's minimum TTL of 60s.
    expect(broker.enrollmentRequests.at(-1)).toEqual({ kind: 'device', ttlSeconds: 60 });
  });

  it('applies name/terminal defaults, clamps the TTL and escapes quotes in the name', async () => {
    const created = await http.admin('POST', '/computer-use/connectors/enrollments', {
      ttlSeconds: 999_999,
    });
    expect(created.status).toBe(200);
    expect(created.body.install.allowTerminal).toBe(false);
    expect(created.body.install.command).toContain("--name 'linux-pc'");
    expect(created.body.install.command).not.toContain('--terminal');
    expect(broker.enrollmentRequests.at(-1)).toEqual({ kind: 'device', ttlSeconds: 86_400 });

    const quoted = await http.admin('POST', '/computer-use/connectors/enrollments', {
      name: "pc's box",
    });
    expect(quoted.status).toBe(200);
    expect(quoted.body.install.command).toContain("--name 'pc'\\''s box'");

    const rejected = await http.admin('POST', '/computer-use/connectors/enrollments', {
      kind: 'toaster',
    });
    expect(rejected.status).toBe(400);
  });

  it('revokes a pairing token', async () => {
    const revoked = await http.admin('DELETE', '/computer-use/connectors/enrollments/enr_pending');
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ deleted: true });
    expect(broker.revoked).toEqual(['enr_pending']);
  });

  it('opens, sends to, reads from and closes a terminal', async () => {
    const opened = await http.admin('POST', '/computer-use/connectors/devices/dev_builder/terminal/open', {
      rows: 40,
      cols: 120,
      cwd: '/tmp',
    });
    expect(opened.status).toBe(200);
    expect(opened.body).toEqual({ deviceId: 'dev_builder', session: 'sess_1' });
    expect(broker.deviceCalls.at(-1)).toEqual({
      deviceId: 'dev_builder',
      op: 'term.open',
      args: { rows: 40, cols: 120, cwd: '/tmp' },
    });

    const sent = await http.admin('POST', '/computer-use/connectors/devices/dev_builder/terminal/send', {
      session: 'sess_1',
      input: 'echo hi',
    });
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ ok: true });
    expect(broker.deviceCalls.at(-1)).toEqual({
      deviceId: 'dev_builder',
      op: 'term.send',
      args: { session: 'sess_1', input: 'echo hi', enter: true },
    });

    const sentWithoutEnter = await http.admin(
      'POST',
      '/computer-use/connectors/devices/dev_builder/terminal/send',
      { session: 'sess_1', input: 'partial', enter: false },
    );
    expect(sentWithoutEnter.body).toEqual({ ok: true });
    expect(broker.deviceCalls.at(-1)?.args).toEqual({ session: 'sess_1', input: 'partial', enter: false });

    const read = await http.admin(
      'GET',
      '/computer-use/connectors/devices/dev_builder/terminal/read?session=sess_1&lines=5&waitSeconds=2',
    );
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ session: 'sess_1', lines: ['$ echo hi', 'hi'], changed: true });
    expect(broker.deviceCalls.at(-1)).toEqual({
      deviceId: 'dev_builder',
      op: 'term.read',
      args: { session: 'sess_1', lines: 5, wait_s: 2 },
    });

    const clamped = await http.admin(
      'GET',
      '/computer-use/connectors/devices/dev_builder/terminal/read?session=sess_1&lines=99999&waitSeconds=99',
    );
    expect(clamped.status).toBe(200);
    expect(broker.deviceCalls.at(-1)?.args).toEqual({ session: 'sess_1', lines: 2_000, wait_s: 30 });

    const closed = await http.admin('POST', '/computer-use/connectors/devices/dev_builder/terminal/close', {
      session: 'sess_1',
    });
    expect(closed.status).toBe(200);
    expect(closed.body).toEqual({ ok: true });
    expect(broker.deviceCalls.at(-1)).toEqual({
      deviceId: 'dev_builder',
      op: 'term.close',
      args: { session: 'sess_1' },
    });
  });

  it('refuses terminal control on a connector without the terminal policy', async () => {
    const refused = await http.admin('POST', '/computer-use/connectors/devices/dev_files/terminal/open', {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe(-32602);
    expect(refused.body.error.message).toBe(
      'This connector does not support terminal control (its policy/capabilities do not advertise term.*)',
    );
    // The broker must not have been asked to run anything on that device.
    expect(broker.deviceCalls.some((call) => call.deviceId === 'dev_files')).toBe(false);
  });

  it('validates terminal requests before touching the broker', async () => {
    const missingSession = await http.admin(
      'GET',
      '/computer-use/connectors/devices/dev_builder/terminal/read',
    );
    expect(missingSession.status).toBe(400);

    const badBody = await http.admin(
      'POST',
      '/computer-use/connectors/devices/dev_builder/terminal/send',
      { session: 'sess_1' },
    );
    expect(badBody.status).toBe(400);
  });

  it('is master-only: agent keys are refused', async () => {
    const created = await http.admin('POST', '/keys/create', {
      name: 'connector-agent',
      keyType: 'agent',
    });
    expect(created.status).toBe(201);
    const agentKey = created.body.plaintext as string;

    const denied = await http.admin('GET', '/computer-use/connectors', undefined, agentKey);
    expect(denied.status).toBe(403);

    const master = await http.admin('GET', '/computer-use/connectors');
    expect(master.status).toBe(200);
  });
});

describe('v0.10 connectors without a public broker URL', () => {
  let container: GatewayContainer | null = null;
  let http: ReturnType<typeof makeHttp>;

  afterAll(async () => {
    await container?.stop();
    container = null;
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('renders an empty connector state and refuses pairing with a clear message', async () => {
    const config = buildConfig({
      dataDir: join(rootDir, 'unconfigured', 'data'),
      dbPath: join(rootDir, 'unconfigured', 'data', 'gateway.db'),
      computerUse: {
        enabled: true,
        brokerUrl: null,
        brokerToken: null,
        publicBrokerUrl: null,
        caFile: null,
      },
    });
    container = startContainer(config);
    http = makeHttp((await container.start()).url);

    const connectors = await http.admin('GET', '/computer-use/connectors');
    expect(connectors.status).toBe(200);
    expect(connectors.body.devices).toEqual([]);
    expect(connectors.body.enrollments).toEqual([]);
    expect(connectors.body.publicBrokerUrl).toBeNull();
    expect(connectors.body.counts).toEqual({ devices: 0, online: 0, pendingEnrollments: 0 });

    const created = await http.admin('POST', '/computer-use/connectors/enrollments', { kind: 'device' });
    expect(created.status).toBe(400);
    expect(created.body.error.message).toContain('public broker URL');
  });
});
