import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase } from '../../src/core/db.js';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';
import { DefaultSupervisor } from '../../src/gateway/supervisor.js';
import { createLogger } from '../../src/core/logger.js';
import { newId, nowIso } from '../../src/core/ids.js';
import type { GatewayConfig } from '../../src/core/config.js';
import type { ServerRecord } from '../../src/core/types.js';

const ECHO_FIXTURE = resolve('tests/fixtures/mcp-echo-server.mjs');

function buildConfig(): GatewayConfig {
  const dataDir = join(process.cwd(), '.test-data', `supervisor-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dataDir, { recursive: true });
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    dbPath: join(dataDir, 'gateway.db'),
    uiDistDir: join(dataDir, 'ui'),
    vaultSecret: null,
    bootstrapMasterKey: null,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: [],
    reposDir: join(dataDir, 'repos'),
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 5_000,
    keyPepper: null,
    publicBaseUrl: 'http://127.0.0.1',
  };
}

function serverRecord(overrides: Partial<ServerRecord> = {}): ServerRecord {
  const now = nowIso();
  return {
    id: newId('srv'),
    name: `echo-${Math.random().toString(36).slice(2, 8)}`,
    runtime: 'node',
    transport: 'stdio',
    status: 'stopped',
    command: process.execPath,
    args: [ECHO_FIXTURE],
    url: null,
    env: {},
    manifest: null,
    highPrivilegeTools: ['danger_delete'],
    delegationSupported: false,
    sourceUrl: null,
    workDir: null,
    lastError: null,
    pid: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('DefaultSupervisor', () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: SqliteCatalogRepository;
  let supervisor: DefaultSupervisor;
  let config: GatewayConfig;

  beforeEach(() => {
    config = buildConfig();
    db = openDatabase(config.dbPath);
    repository = new SqliteCatalogRepository(db);
    supervisor = new DefaultSupervisor({
      repository,
      config,
      logger: createLogger('supervisor-test', 'silent'),
    });
  });

  afterEach(async () => {
    await supervisor.shutdown();
    db.close();
    rmSync(config.dataDir, { recursive: true, force: true });
  });

  it('rejects unknown servers', async () => {
    await expect(supervisor.start('srv_missing')).rejects.toMatchObject({ code: -32602 });
  });

  it('starts a stdio sub-server, performs discovery and persists tools', async () => {
    const record = serverRecord();
    repository.upsertServer(record);

    const started = await supervisor.start(record.id);
    expect(started.status).toBe('running');
    expect(started.pid).toBeGreaterThan(0);
    expect(supervisor.status(record.id)).toBe('running');

    const tools = repository.listToolsByServer(record.id);
    expect(tools.map((tool) => tool.name).sort()).toEqual(['add', 'danger_delete', 'echo', 'fail', 'slow']);
    const highPrivilege = tools.find((tool) => tool.name === 'danger_delete');
    expect(highPrivilege?.highPrivilege).toBe(true);
  });

  it('executes a tool through the managed MCP client', async () => {
    const record = serverRecord();
    repository.upsertServer(record);
    await supervisor.start(record.id);

    const client = supervisor.client(record.id);
    expect(client).not.toBeNull();
    const result = await client!.callTool('echo', { text: 'via supervisor' });
    expect(result.content[0]).toEqual({ type: 'text', text: 'via supervisor' });
  });

  it('captures and streams sub-server logs', async () => {
    const record = serverRecord({ env: { ECHO_SERVER_STDERR: '1' } });
    repository.upsertServer(record);

    const received: string[] = [];
    const unsubscribe = supervisor.subscribeLogs(record.id, (line) => received.push(line.line));

    await supervisor.start(record.id);
    await supervisor.client(record.id)!.callTool('echo', { text: 'log me' });

    const logs = supervisor.logs(record.id, 200);
    expect(logs.some((line) => line.stream === 'system' && line.line.includes('initialized'))).toBe(true);
    expect(logs.some((line) => line.stream === 'stderr' && line.line.includes('stderr channel active'))).toBe(true);
    expect(received.length).toBeGreaterThan(0);

    unsubscribe();
    const before = received.length;
    await supervisor.client(record.id)!.callTool('echo', { text: 'after unsubscribe' });
    expect(received.length).toBe(before);
  });

  it('stops and restarts cleanly', async () => {
    const record = serverRecord();
    repository.upsertServer(record);

    await supervisor.start(record.id);
    await supervisor.stop(record.id);
    expect(supervisor.status(record.id)).toBe('stopped');
    expect(supervisor.client(record.id)).toBeNull();
    expect(repository.getServer(record.id)?.pid).toBeNull();

    const restarted = await supervisor.restart(record.id);
    expect(restarted.status).toBe('running');
    expect(supervisor.client(record.id)).not.toBeNull();
  });

  it('marks the server failed when the process cannot start', async () => {
    const record = serverRecord({ command: '/nonexistent/mcp-server-binary' });
    repository.upsertServer(record);

    await expect(supervisor.start(record.id)).rejects.toBeTruthy();
    expect(supervisor.status(record.id)).toBe('failed');
    const stored = repository.getServer(record.id);
    expect(stored?.lastError).toBeTruthy();
    expect(supervisor.client(record.id)).toBeNull();
  });

  it('surfaces timeouts from slow upstream tools', async () => {
    const record = serverRecord();
    repository.upsertServer(record);
    await supervisor.start(record.id);

    const client = supervisor.client(record.id)!;
    await expect(client.callTool('slow', { ms: 500 }, { timeoutMs: 50 })).rejects.toMatchObject({ code: -32007 });
  });
});
