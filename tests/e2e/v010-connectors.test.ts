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
import {
  normalizeComputer,
  normalizeComputerStats,
  normalizeVmHost,
  serializeVmHostConfig,
} from '../../src/computer_use/broker-client.js';
import { loadConfig, type GatewayConfig } from '../../src/core/config.js';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import { createLogger } from '../../src/core/logger.js';
import type {
  BrokerComputerSnapshot,
  BrokerConnectorRemoved,
  BrokerConnectorUpdate,
  BrokerDeviceSnapshot,
  BrokerEnrollmentCreated,
  BrokerEnrollmentSnapshot,
  BrokerHostComputerCreated,
  BrokerVmHostCreateResult,
  BrokerVmHostDeleteResult,
  BrokerVmHostSnapshot,
  BrokerVmHostTestResult,
  ComputerUseBrokerHealth,
  ComputerUseBrokerPort,
  ComputerUseFrameResult,
} from '../../src/core/ports.js';
import type {
  ComputerUseStats,
  ComputerUseVmHostConfig,
  ComputerUseVmHostConfigInput,
  ComputerUseVmHostDefaults,
} from '../../src/core/types.js';

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
      installBaseUrl: 'https://10.10.1.4:7443',
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
  readonly hostComputerRequests: string[] = [];
  readonly statsRequests: string[] = [];
  readonly connectorUpdates: string[] = [];
  readonly connectorRemovals: Array<{
    computerId: string;
    input: { uninstall: boolean; removeComputer: boolean };
  }> = [];
  readonly vmHostsList: BrokerVmHostSnapshot[] = [
    {
      id: 'vmh_zues',
      name: 'zues',
      kind: 'libvirt',
      config: {
        sshHost: 'root@zues.lan',
        sshUser: 'root',
        host: 'zues.lan',
        user: 'root',
        baseImage: '/var/lib/libvirt/images/ubuntu-base.qcow2',
        storageDir: '/var/lib/libvirt/images',
        vmDir: null,
        network: 'default',
        template: 'ubuntu-xfce',
        cloudImageUrl: null,
        installBrowser: null,
        defaults: null,
      },
      defaults: { vcpus: 2, memoryMb: 2_048, diskGb: 30 },
      template: 'ubuntu-xfce',
      baseReady: true,
      state: 'ready',
      lastError: null,
      createdAt: '2026-10-31T09:00:00Z',
    },
  ];
  readonly vmHostCreateRequests: Array<{
    name: string;
    kind: 'libvirt' | 'qemu';
    config: ComputerUseVmHostConfigInput;
  }> = [];
  readonly vmHostTestRequests: string[] = [];
  readonly vmHostDeleteRequests: string[] = [];
  readonly vmComputerCreateRequests: Array<{
    vmHostId: string;
    name?: string | null;
    vcpus?: number;
    memoryMb?: number;
    diskGb?: number;
  }> = [];
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

  // -- v0.12 host computers, stats and connector lifecycle -------------------

  async createHostComputer(name: string): Promise<BrokerHostComputerCreated> {
    this.hostComputerRequests.push(name);
    return {
      computer: {
        id: 'cmp_host_1',
        name,
        template: 'host',
        provider: 'host',
        state: 'ready',
        viewer: 'wayland',
        error: null,
        createdAt: '2026-10-30T12:00:00Z',
        ttlAt: null,
        desktop: { viewer: 'wayland', width: 1920, height: 1080 },
        connector: { state: 'online', version: '0.12.0', lastSeen: '2026-10-30T12:00:00Z' },
        control: { held: false, holder: null, heldSince: null, expiresAt: null },
        resources: null,
      },
      token: 'tok_host_abc123',
      expiresAt: '2026-10-30T12:15:00Z',
    };
  }

  async computerStats(computerId: string): Promise<ComputerUseStats> {
    this.statsRequests.push(computerId);
    return {
      hostname: 'gpc',
      os: 'Ubuntu 24.04 LTS',
      uptimeSeconds: 93_784,
      load: [0.42, 0.51, 0.48],
      cpu: { cores: 16, percent: 12.5 },
      memory: {
        totalBytes: 34_359_738_368,
        usedBytes: 9_833_050_112,
        availableBytes: 24_526_688_256,
        percent: 28.6,
      },
      swap: { totalBytes: 8_589_934_592, usedBytes: 0, percent: 0 },
      disk: { path: '/', totalBytes: 1_000_204_886_016, usedBytes: 247_390_928_896, percent: 24.7 },
      addresses: [{ iface: 'enp5s0', address: '10.10.1.4' }],
      collectedAt: '2026-10-30T12:05:00Z',
    };
  }

  async updateConnector(computerId: string): Promise<BrokerConnectorUpdate> {
    this.connectorUpdates.push(computerId);
    return {
      ok: true,
      version: '0.12.0',
      connectorVersion: '0.12.1',
      result: { updated: true, steps: ['download', 'restart'] },
    };
  }

  async removeConnector(
    computerId: string,
    input: { uninstall: boolean; removeComputer: boolean },
  ): Promise<BrokerConnectorRemoved> {
    this.connectorRemovals.push({ computerId, input });
    return { ok: true, connectorRemoved: true, computerRemoved: input.removeComputer };
  }

  // -- v0.13.1 VM providers and VM deployment -------------------------------

  async listVmHosts(): Promise<BrokerVmHostSnapshot[]> {
    return this.vmHostsList;
  }

  async createVmHost(input: {
    name: string;
    kind: 'libvirt' | 'qemu';
    config: ComputerUseVmHostConfigInput;
  }): Promise<BrokerVmHostCreateResult> {
    this.vmHostCreateRequests.push(input);
    const defaults: ComputerUseVmHostDefaults = {
      vcpus: input.config.defaults?.vcpus ?? 2,
      memoryMb: input.config.defaults?.memoryMb ?? 2_048,
      diskGb: input.config.defaults?.diskGb ?? 30,
    };
    const config: ComputerUseVmHostConfig = {
      sshHost: input.config.sshHost ?? null,
      sshUser: input.config.sshUser ?? null,
      host: null,
      user: null,
      baseImage: input.config.baseImage,
      storageDir: input.config.storageDir,
      vmDir: null,
      network: input.config.network ?? (input.kind === 'libvirt' ? 'default' : null),
      template: 'ubuntu-xfce',
      cloudImageUrl: input.config.cloudImageUrl ?? null,
      installBrowser: input.config.installBrowser ?? null,
      defaults,
    };
    return {
      vmHost: {
        id: 'vmh_new',
        name: input.name,
        kind: input.kind,
        config,
        defaults,
        template: 'ubuntu-xfce',
        baseReady: true,
        state: 'ready',
        lastError: null,
        createdAt: '2026-10-31T10:00:00Z',
      },
      test: { ok: true, reachable: true, base_size_bytes: 123_456 },
    };
  }

  async testVmHost(vmHostId: string): Promise<BrokerVmHostTestResult> {
    this.vmHostTestRequests.push(vmHostId);
    const host = this.vmHostsList.find((entry) => entry.id === vmHostId) ?? this.vmHostsList[0];
    if (host === undefined) throw new Error('no vm host fixture');
    if (vmHostId === 'vmh_broken') {
      return {
        ok: false,
        vmHost: { ...host, id: vmHostId, state: 'error', baseReady: false, lastError: 'libvirt unreachable' },
        details: { ok: false, problems: ['libvirt unreachable'] },
      };
    }
    return {
      ok: true,
      vmHost: { ...host, id: vmHostId, state: 'ready', baseReady: true, lastError: null },
      details: { ok: true, reachable: true },
    };
  }

  async deleteVmHost(vmHostId: string): Promise<BrokerVmHostDeleteResult> {
    this.vmHostDeleteRequests.push(vmHostId);
    if (vmHostId === 'vmh_busy') {
      throw new GatewayError(
        ErrorCodes.UPSTREAM_ERROR,
        'Computer Broker DELETE /api/vm-hosts/vmh_busy: vm host in use',
        {
          data: { status: 'BROKER_ERROR', reason: 'vm_host_in_use', details: { computers: ['cmp_x'] } },
          httpStatus: 409,
        },
      );
    }
    return { ok: true, deleted: vmHostId };
  }

  async createVmComputer(input: {
    vmHostId: string;
    name?: string | null;
    vcpus?: number;
    memoryMb?: number;
    diskGb?: number;
  }): Promise<BrokerComputerSnapshot> {
    this.vmComputerCreateRequests.push(input);
    return {
      id: 'cmp_vm_1',
      name: input.name ?? 'vm-abc123',
      template: 'ubuntu-xfce',
      provider: 'vm',
      state: 'starting',
      viewer: 'frames',
      error: null,
      createdAt: '2026-10-31T10:05:00Z',
      ttlAt: null,
      desktop: { viewer: 'frames', width: 1280, height: 800 },
      connector: null,
      control: { held: false, holder: null, heldSince: null, expiresAt: null },
      resources: {
        vmHostId: input.vmHostId,
        vcpus: input.vcpus ?? 2,
        memoryMb: input.memoryMb ?? 2_048,
        diskGb: input.diskGb ?? 30,
      },
    };
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

  it('creates a physical host computer with a one-line Wayland installer', async () => {
    const created = await http.admin('POST', '/computer-use/connectors/computers', { name: 'gpc' });
    expect(created.status).toBe(200);
    expect(broker.hostComputerRequests).toEqual(['gpc']);
    expect(created.body.computer).toMatchObject({
      id: 'cmp_host_1',
      name: 'gpc',
      provider: 'host',
      viewer: 'wayland',
      state: 'ready',
      liveUrl: `${BROKER_URL}/#/d/cmp_host_1`,
    });
    expect(created.body.install).toMatchObject({
      brokerUrl: 'https://10.10.1.4:7443',
      connectorUrl: 'wss://10.10.1.4:7443/connector',
      caUrl: 'https://10.10.1.4:7443/install/broker-ca.pem',
      expiresAt: '2026-10-30T12:15:00Z',
    });

    const command = created.body.install.command as string;
    expect(command.startsWith('curl -fsSLk ')).toBe(true);
    expect(command).toContain("'https://10.10.1.4:7443/install/install-connector.sh'");
    expect(command).toContain('| bash -s --');
    expect(command).toContain("--broker 'wss://10.10.1.4:7443/connector'");
    expect(command).toContain("--enroll 'tok_host_abc123'");
    expect(command).toContain('--kind computer');
    expect(command).toContain('--backend wayland');
    expect(command).toContain("--name 'gpc'");
  });

  it('defaults the host name and validates host/remove request bodies', async () => {
    const created = await http.admin('POST', '/computer-use/connectors/computers', {});
    expect(created.status).toBe(200);
    expect(broker.hostComputerRequests.at(-1)).toBe('linux-pc');

    const badName = await http.admin('POST', '/computer-use/connectors/computers', { name: 42 });
    expect(badName.status).toBe(400);

    const badRemove = await http.admin('DELETE', '/computer-use/computers/cmp_host_1/connector', {
      removeComputer: 'yes',
    });
    expect(badRemove.status).toBe(400);
  });

  it('serves live host stats', async () => {
    const stats = await http.admin('GET', '/computer-use/computers/cmp_host_1/stats');
    expect(stats.status).toBe(200);
    expect(broker.statsRequests).toEqual(['cmp_host_1']);
    expect(stats.body).toEqual({
      hostname: 'gpc',
      os: 'Ubuntu 24.04 LTS',
      uptimeSeconds: 93_784,
      load: [0.42, 0.51, 0.48],
      cpu: { cores: 16, percent: 12.5 },
      memory: {
        totalBytes: 34_359_738_368,
        usedBytes: 9_833_050_112,
        availableBytes: 24_526_688_256,
        percent: 28.6,
      },
      swap: { totalBytes: 8_589_934_592, usedBytes: 0, percent: 0 },
      disk: { path: '/', totalBytes: 1_000_204_886_016, usedBytes: 247_390_928_896, percent: 24.7 },
      addresses: [{ iface: 'enp5s0', address: '10.10.1.4' }],
      collectedAt: '2026-10-30T12:05:00Z',
    });
  });

  it('updates the host connector in place and removes it remotely', async () => {
    const updated = await http.admin('POST', '/computer-use/computers/cmp_host_1/connector/update');
    expect(updated.status).toBe(200);
    expect(broker.connectorUpdates).toEqual(['cmp_host_1']);
    expect(updated.body).toEqual({
      ok: true,
      version: '0.12.0',
      connectorVersion: '0.12.1',
      result: { updated: true, steps: ['download', 'restart'] },
    });

    const removed = await http.admin('DELETE', '/computer-use/computers/cmp_host_1/connector', {
      removeComputer: true,
    });
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ ok: true, connectorRemoved: true, computerRemoved: true });
    expect(broker.connectorRemovals.at(-1)).toEqual({
      computerId: 'cmp_host_1',
      input: { uninstall: true, removeComputer: true },
    });

    const kept = await http.admin('DELETE', '/computer-use/computers/cmp_host_1/connector', {});
    expect(kept.status).toBe(200);
    expect(kept.body).toEqual({ ok: true, connectorRemoved: true, computerRemoved: false });
    expect(broker.connectorRemovals.at(-1)?.input).toEqual({ uninstall: true, removeComputer: false });

    // An absent body is treated as `{}`, i.e. keep the computer record.
    const noBody = await http.admin('DELETE', '/computer-use/computers/cmp_host_1/connector');
    expect(noBody.status).toBe(200);
    expect(noBody.body).toMatchObject({ connectorRemoved: true, computerRemoved: false });
  });

  // -------------------------------------------------------------------------
  // v0.13.1 — VM providers and VM deployment
  // -------------------------------------------------------------------------

  it('lists the registered VM providers', async () => {
    const listed = await http.admin('GET', '/computer-use/vm-hosts');
    expect(listed.status).toBe(200);
    expect(listed.body.vmHosts).toHaveLength(1);
    expect(listed.body.vmHosts[0]).toEqual({
      id: 'vmh_zues',
      name: 'zues',
      kind: 'libvirt',
      config: {
        sshHost: 'root@zues.lan',
        sshUser: 'root',
        host: 'zues.lan',
        user: 'root',
        baseImage: '/var/lib/libvirt/images/ubuntu-base.qcow2',
        storageDir: '/var/lib/libvirt/images',
        vmDir: null,
        network: 'default',
        template: 'ubuntu-xfce',
        cloudImageUrl: null,
        installBrowser: null,
        defaults: null,
      },
      defaults: { vcpus: 2, memoryMb: 2_048, diskGb: 30 },
      template: 'ubuntu-xfce',
      baseReady: true,
      state: 'ready',
      lastError: null,
      createdAt: '2026-10-31T09:00:00Z',
    });
  });

  it('registers a VM provider, forwarding config and clamping defaults', async () => {
    const created = await http.admin('POST', '/computer-use/vm-hosts', {
      name: 'gpc',
      kind: 'libvirt',
      config: {
        sshHost: 'root@gpc.lan',
        sshUser: 'root',
        baseImage: '/srv/images/base.qcow2',
        storageDir: '/srv/images',
        network: 'lab',
        defaults: { vcpus: 99, memoryMb: 100, diskGb: 1_000 },
        installBrowser: true,
      },
    });
    expect(created.status).toBe(201);
    expect(broker.vmHostCreateRequests.at(-1)).toEqual({
      name: 'gpc',
      kind: 'libvirt',
      config: {
        sshHost: 'root@gpc.lan',
        sshUser: 'root',
        baseImage: '/srv/images/base.qcow2',
        storageDir: '/srv/images',
        network: 'lab',
        installBrowser: true,
        defaults: { vcpus: 16, memoryMb: 512, diskGb: 500 },
      },
    });
    expect(created.body.vmHost).toMatchObject({
      id: 'vmh_new',
      name: 'gpc',
      kind: 'libvirt',
      state: 'ready',
      baseReady: true,
    });
    expect(created.body.test).toEqual({ ok: true, reachable: true, base_size_bytes: 123_456 });

    // Broker snake_case config keys are accepted too.
    const fromSnake = await http.admin('POST', '/computer-use/vm-hosts', {
      name: 'gpc2',
      kind: 'qemu',
      config: { base_image: '/srv/images/base.qcow2', storage_dir: '/srv/images' },
    });
    expect(fromSnake.status).toBe(201);
    expect(broker.vmHostCreateRequests.at(-1)?.config).toMatchObject({
      baseImage: '/srv/images/base.qcow2',
      storageDir: '/srv/images',
    });
  });

  it('validates VM provider registration before the broker is called', async () => {
    const missingName = await http.admin('POST', '/computer-use/vm-hosts', { kind: 'libvirt', config: {} });
    expect(missingName.status).toBe(400);

    const badKind = await http.admin('POST', '/computer-use/vm-hosts', {
      name: 'x',
      kind: 'vmware',
      config: { baseImage: '/b', storageDir: '/s' },
    });
    expect(badKind.status).toBe(400);
    expect(badKind.body.error.message).toContain("'kind' must be 'libvirt' or 'qemu'");

    const missingConfig = await http.admin('POST', '/computer-use/vm-hosts', { name: 'x', kind: 'qemu' });
    expect(missingConfig.status).toBe(400);

    const missingBase = await http.admin('POST', '/computer-use/vm-hosts', {
      name: 'x',
      kind: 'qemu',
      config: { storageDir: '/s' },
    });
    expect(missingBase.status).toBe(400);

    const libvirtNoSsh = await http.admin('POST', '/computer-use/vm-hosts', {
      name: 'x',
      kind: 'libvirt',
      config: { baseImage: '/b', storageDir: '/s' },
    });
    expect(libvirtNoSsh.status).toBe(400);
    expect(libvirtNoSsh.body.error.message).toContain('sshHost');

    const qemuWithSsh = await http.admin('POST', '/computer-use/vm-hosts', {
      name: 'x',
      kind: 'qemu',
      config: { sshHost: 'root@h', baseImage: '/b', storageDir: '/s' },
    });
    expect(qemuWithSsh.status).toBe(400);
  });

  it('tests a VM provider and forwards a failed test result', async () => {
    const ok = await http.admin('POST', '/computer-use/vm-hosts/vmh_zues/test');
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.vmHost).toMatchObject({ id: 'vmh_zues', state: 'ready', baseReady: true });
    expect(ok.body.details).toEqual({ ok: true, reachable: true });
    expect(broker.vmHostTestRequests).toEqual(['vmh_zues']);

    const broken = await http.admin('POST', '/computer-use/vm-hosts/vmh_broken/test');
    expect(broken.status).toBe(200);
    expect(broken.body.ok).toBe(false);
    expect(broken.body.vmHost).toMatchObject({
      id: 'vmh_broken',
      state: 'error',
      lastError: 'libvirt unreachable',
    });
    expect(broken.body.details).toEqual({ ok: false, problems: ['libvirt unreachable'] });
  });

  it('removes a VM provider and forwards the broker in-use refusal', async () => {
    const removed = await http.admin('DELETE', '/computer-use/vm-hosts/vmh_new');
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ ok: true, deleted: 'vmh_new' });
    expect(broker.vmHostDeleteRequests).toEqual(['vmh_new']);

    const inUse = await http.admin('DELETE', '/computer-use/vm-hosts/vmh_busy');
    expect(inUse.status).toBe(409);
    expect(inUse.body.error).toMatchObject({
      code: ErrorCodes.UPSTREAM_ERROR,
      data: { status: 'BROKER_ERROR', reason: 'vm_host_in_use' },
    });
    expect(inUse.body.error.data.details).toEqual({ computers: ['cmp_x'] });
    expect(broker.vmHostDeleteRequests).toEqual(['vmh_new', 'vmh_busy']);
  });

  it('deploys a VM computer with clamped resource overrides', async () => {
    const created = await http.admin('POST', '/computer-use/computers/vm', {
      vmHostId: 'vmh_zues',
      name: 'dev-vm',
      vcpus: 99,
      memoryMb: 100,
      diskGb: 1_000,
    });
    expect(created.status).toBe(201);
    expect(broker.vmComputerCreateRequests.at(-1)).toEqual({
      vmHostId: 'vmh_zues',
      name: 'dev-vm',
      vcpus: 16,
      memoryMb: 512,
      diskGb: 500,
    });
    expect(created.body.computer).toMatchObject({
      id: 'cmp_vm_1',
      name: 'dev-vm',
      provider: 'vm',
      state: 'starting',
      liveUrl: `${BROKER_URL}/#/d/cmp_vm_1`,
      resources: { vmHostId: 'vmh_zues', vcpus: 16, memoryMb: 512, diskGb: 500 },
    });

    const missingHost = await http.admin('POST', '/computer-use/computers/vm', { name: 'x' });
    expect(missingHost.status).toBe(400);
    expect(missingHost.body.error.message).toContain("'vmHostId' is required");

    const noName = await http.admin('POST', '/computer-use/computers/vm', { vmHostId: 'vmh_zues' });
    expect(noName.status).toBe(201);
    expect(noName.body.computer.name).toBe('vm-abc123');
    expect(broker.vmComputerCreateRequests.at(-1)).toMatchObject({ vmHostId: 'vmh_zues', name: null });
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

    const deniedStats = await http.admin(
      'GET',
      '/computer-use/computers/cmp_host_1/stats',
      undefined,
      agentKey,
    );
    expect(deniedStats.status).toBe(403);

    const deniedVmHosts = await http.admin('GET', '/computer-use/vm-hosts', undefined, agentKey);
    expect(deniedVmHosts.status).toBe(403);

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
        installBaseUrl: null,
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

    const host = await http.admin('POST', '/computer-use/connectors/computers', { name: 'gpc' });
    expect(host.status).toBe(400);
    expect(host.body.error.message).toContain('install base URL');
  });
});

describe('v0.12 host installer base URL fallback', () => {
  let container: GatewayContainer | null = null;

  afterAll(async () => {
    await container?.stop();
    container = null;
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('falls back to the public broker URL when MCP_COMPUTER_INSTALL_BASE_URL is unset', async () => {
    const broker = new FakeBroker('brk_admin_token');
    const config = buildConfig({
      dataDir: join(rootDir, 'fallback', 'data'),
      dbPath: join(rootDir, 'fallback', 'data', 'gateway.db'),
      computerUse: {
        enabled: true,
        brokerUrl: BROKER_URL,
        brokerToken: 'brk_admin_token',
        publicBrokerUrl: BROKER_URL,
        caFile: null,
        installBaseUrl: null,
      },
    });
    container = startContainer(config, broker);
    const http = makeHttp((await container.start()).url);

    const created = await http.admin('POST', '/computer-use/connectors/computers', { name: 'gpc' });
    expect(created.status).toBe(200);
    expect(created.body.install.brokerUrl).toBe(BROKER_URL);
    expect(created.body.install.connectorUrl).toBe('wss://broker.test:7443/connector');
    expect(created.body.install.command).toContain(`${BROKER_URL}/install/install-connector.sh`);
  });
});

describe('MCP_COMPUTER_INSTALL_BASE_URL', () => {
  it('is read, validated and normalised by loadConfig', () => {
    const config = loadConfig({ MCP_COMPUTER_INSTALL_BASE_URL: 'https://10.10.1.4:7443/' });
    expect(config.computerUse?.installBaseUrl).toBe('https://10.10.1.4:7443');

    expect(() => loadConfig({ MCP_COMPUTER_INSTALL_BASE_URL: 'ftp://10.10.1.4' })).toThrow(/http/);
    expect(() => loadConfig({ MCP_COMPUTER_INSTALL_BASE_URL: 'not-a-url' })).toThrow(/absolute/);
  });
});

describe('broker host stats normalisation', () => {
  it('maps the broker snake_case stats payload to ComputerUseStats', () => {
    const stats = normalizeComputerStats({
      hostname: 'gpc',
      os: 'Ubuntu 24.04 LTS',
      uptime_seconds: 93_784,
      load: [0.42, 0.51, 0.48],
      cpu: { cores: 16, percent: 12.5 },
      memory: { total_bytes: 34_359_738_368, used_bytes: 9_833_050_112, available_bytes: 24_526_688_256, percent: 28.6 },
      swap: { total_bytes: 8_589_934_592, used_bytes: 0, percent: 0 },
      disk: { path: '/', total_bytes: 1_000_204_886_016, used_bytes: 247_390_928_896, percent: 24.7 },
      addresses: [{ iface: 'enp5s0', address: '10.10.1.4' }],
      collected_at: '2026-10-30T12:05:00Z',
    });
    expect(stats).toEqual({
      hostname: 'gpc',
      os: 'Ubuntu 24.04 LTS',
      uptimeSeconds: 93_784,
      load: [0.42, 0.51, 0.48],
      cpu: { cores: 16, percent: 12.5 },
      memory: {
        totalBytes: 34_359_738_368,
        usedBytes: 9_833_050_112,
        availableBytes: 24_526_688_256,
        percent: 28.6,
      },
      swap: { totalBytes: 8_589_934_592, usedBytes: 0, percent: 0 },
      disk: { path: '/', totalBytes: 1_000_204_886_016, usedBytes: 247_390_928_896, percent: 24.7 },
      addresses: [{ iface: 'enp5s0', address: '10.10.1.4' }],
      collectedAt: '2026-10-30T12:05:00Z',
    });
  });

  it('tolerates a partial probe payload', () => {
    const stats = normalizeComputerStats({ hostname: 'bare' });
    expect(stats).toMatchObject({
      hostname: 'bare',
      os: 'unknown',
      uptimeSeconds: null,
      load: [],
      cpu: { cores: 0, percent: 0 },
      memory: { totalBytes: 0, usedBytes: 0, availableBytes: 0, percent: 0 },
      disk: { path: '/' },
      addresses: [],
      collectedAt: null,
    });
  });
});

describe('broker VM computer resources normalisation', () => {
  it('maps vm_host_id and sizing onto ComputerUseComputerResources', () => {
    const computer = normalizeComputer({
      id: 'cmp_vm',
      resources: {
        vm_host_id: 'vmh_1',
        vcpus: 4,
        memory_mb: 4_096,
        disk_gb: 60,
        base_image: '/srv/images/base.qcow2',
      },
    });
    expect(computer.resources).toEqual({
      vmHostId: 'vmh_1',
      vcpus: 4,
      memoryMb: 4_096,
      diskGb: 60,
    });
  });

  it('accepts camelCase resources and collapses empty blocks to null', () => {
    expect(
      normalizeComputer({
        id: 'cmp_vm2',
        resources: { vmHostId: 'vmh_2', vcpus: 2, memoryMb: 2_048, diskGb: 30 },
      }).resources,
    ).toEqual({ vmHostId: 'vmh_2', vcpus: 2, memoryMb: 2_048, diskGb: 30 });
    expect(normalizeComputer({ id: 'cmp_container' }).resources).toBeNull();
    expect(normalizeComputer({ id: 'cmp_container', resources: { cpus: '2', memory: '2g' } }).resources).toBeNull();
  });
});

describe('broker VM host normalisation', () => {
  it('maps the broker snake_case provider JSON to the console shape', () => {
    const host = normalizeVmHost({
      id: 'vmh_1',
      name: 'zues',
      kind: 'libvirt',
      config: {
        ssh_host: 'root@zues.lan',
        ssh_user: 'root',
        host: 'zues.lan',
        user: 'root',
        base_image: '/var/lib/libvirt/images/base.qcow2',
        storage_dir: '/var/lib/libvirt/images',
        network: 'default',
        cloud_image_url: 'https://images.example/base.qcow2',
        install_browser: true,
        defaults: { vcpus: 4, memory_mb: 4_096, disk_gb: 60 },
      },
      defaults: { vcpus: 4, memory_mb: 4_096, disk_gb: 60 },
      template: 'ubuntu-xfce',
      base_ready: true,
      state: 'ready',
      last_error: null,
      created_at: '2026-10-31T09:00:00Z',
    });
    expect(host).toEqual({
      id: 'vmh_1',
      name: 'zues',
      kind: 'libvirt',
      config: {
        sshHost: 'root@zues.lan',
        sshUser: 'root',
        host: 'zues.lan',
        user: 'root',
        baseImage: '/var/lib/libvirt/images/base.qcow2',
        storageDir: '/var/lib/libvirt/images',
        vmDir: null,
        network: 'default',
        template: null,
        cloudImageUrl: 'https://images.example/base.qcow2',
        installBrowser: true,
        defaults: { vcpus: 4, memoryMb: 4_096, diskGb: 60 },
      },
      defaults: { vcpus: 4, memoryMb: 4_096, diskGb: 60 },
      template: 'ubuntu-xfce',
      baseReady: true,
      state: 'ready',
      lastError: null,
      createdAt: '2026-10-31T09:00:00Z',
    });
  });

  it('serialises the create input to the broker snake_case config', () => {
    expect(
      serializeVmHostConfig({
        sshHost: 'root@gpc.lan',
        sshUser: 'root',
        baseImage: '/srv/images/base.qcow2',
        storageDir: '/srv/images',
        network: 'lab',
        cloudImageUrl: 'https://images.example/base.qcow2',
        installBrowser: true,
        defaults: { vcpus: 4, memoryMb: 4_096, diskGb: 60 },
      }),
    ).toEqual({
      base_image: '/srv/images/base.qcow2',
      storage_dir: '/srv/images',
      ssh_host: 'root@gpc.lan',
      ssh_user: 'root',
      network: 'lab',
      cloud_image_url: 'https://images.example/base.qcow2',
      install_browser: true,
      defaults: { vcpus: 4, memory_mb: 4_096, disk_gb: 60 },
    });
  });

  it('tolerates a partial provider payload', () => {
    const host = normalizeVmHost({ id: 'vmh_bare' });
    expect(host).toMatchObject({
      id: 'vmh_bare',
      name: 'unnamed',
      kind: 'libvirt',
      template: 'ubuntu-xfce',
      baseReady: false,
      state: 'new',
      lastError: null,
      createdAt: null,
      defaults: { vcpus: 2, memoryMb: 2_048, diskGb: 30 },
    });
    expect(host.config.baseImage).toBeNull();
    expect(host.config.defaults).toBeNull();
  });
});
