import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/core/db.js';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import type { HarnessImportInput, ServerRecord } from '../../src/core/types.js';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';
import { DefaultHarnessDiscoveryService, deriveRuntime, sanitizeServerName } from '../../src/discovery/service.js';
import { FIXTURE_SECRETS, fixtureHarnessEnv, silentLogger } from './helpers.js';

describe('DefaultHarnessDiscoveryService', () => {
  let db: DatabaseSync;
  let repository: SqliteCatalogRepository;
  let tempDir: string;
  let service: DefaultHarnessDiscoveryService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repository = new SqliteCatalogRepository(db);
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-harness-service-'));
    service = new DefaultHarnessDiscoveryService({
      repository,
      logger: silentLogger,
      env: fixtureHarnessEnv(),
      homeDir: tempDir,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeServer(overrides: Partial<ServerRecord> = {}): ServerRecord {
    return {
      id: 'srv_existing',
      name: 'existing',
      runtime: 'node',
      transport: 'stdio',
      status: 'stopped',
      command: 'node',
      args: [],
      url: null,
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
      ...overrides,
    };
  }

  function importInput(overrides: Partial<HarnessImportInput> = {}): HarnessImportInput {
    return {
      harness: 'claude',
      name: 'brain',
      transport: 'stdio',
      command: 'node',
      args: ['/opt/example/brain-mcp/index.js'],
      ...overrides,
    };
  }

  async function expectGatewayError(promise: Promise<unknown>, pattern: RegExp): Promise<GatewayError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      const gatewayError = error as GatewayError;
      expect(gatewayError.code).toBe(ErrorCodes.INVALID_PARAMS);
      expect(gatewayError.message).toMatch(pattern);
      return gatewayError;
    }
    throw new Error('Expected the promise to reject');
  }

  it('lists sources synchronously from the built-in adapters', () => {
    const sources = service.listSources();
    expect(sources.map((source) => source.id)).toEqual(['claude', 'opencode', 'openmausbot', 'generic']);
    expect(sources.every((source) => source.exists)).toBe(true);
    expect(sources.map((source) => source.serverCount)).toEqual([2, 2, 2, 1]);
  });

  it('scans harnesses through the service port', async () => {
    const result = await service.scan();
    expect(result.sources).toHaveLength(4);
    expect(result.entries).toHaveLength(7);
    expect(result.errors).toEqual([]);

    const restricted = await service.scan(['claude']);
    expect(restricted.sources.map((source) => source.id)).toEqual(['claude']);
    expect(restricted.entries.every((entry) => entry.harness === 'claude')).toBe(true);
  });

  it('imports a discovered-style stdio entry as a stopped server', async () => {
    const record = await service.importEntry(importInput());

    expect(record.id).toMatch(/^srv_/);
    expect(record.name).toBe('brain');
    expect(record.runtime).toBe('node');
    expect(record.transport).toBe('stdio');
    expect(record.status).toBe('stopped');
    expect(record.command).toBe('node');
    expect(record.args).toEqual(['/opt/example/brain-mcp/index.js']);
    expect(record.url).toBeNull();
    expect(record.env).toEqual({});
    expect(record.envFile).toBeNull();
    expect(record.manifest).toBeNull();
    expect(record.pid).toBeNull();
    expect(record.highPrivilegeTools).toEqual([]);
    expect(record.approvalRequiredTools).toEqual([]);
    expect(record.sourceUrl).toBeNull();
    expect(record.workDir).toBeNull();

    const persisted = repository.getServer(record.id);
    expect(persisted).toMatchObject({ name: 'brain', runtime: 'node', transport: 'stdio', status: 'stopped' });
  });

  it('derives unique names by suffixing collisions', async () => {
    const first = await service.importEntry(importInput());
    const second = await service.importEntry(importInput());
    const third = await service.importEntry(importInput());

    expect([first.name, second.name, third.name]).toEqual(['brain', 'brain-2', 'brain-3']);
    expect(repository.listServers()).toHaveLength(3);
  });

  it('avoids names already used by catalog servers', async () => {
    repository.upsertServer(makeServer({ name: 'brain' }));
    const record = await service.importEntry(importInput());
    expect(record.name).toBe('brain-2');
  });

  it('sanitizes names and caps them at 64 characters', async () => {
    const record = await service.importEntry(importInput({ name: '  Brain MCP!  ' }));
    expect(record.name).toBe('brain-mcp');

    const longName = await service.importEntry(importInput({ name: 'a'.repeat(100) }));
    expect(longName.name).toHaveLength(64);
    expect(longName.name).toMatch(/^a+$/);

    await service.importEntry(importInput({ name: 'a'.repeat(100) }));
    const suffixed = repository.getServerByName('a'.repeat(62) + '-2');
    expect(suffixed).not.toBeNull();
    expect(suffixed?.name).toHaveLength(64);
  });

  it('persists user-supplied env values, policy lists and an expanded envFile', async () => {
    const record = await service.importEntry(
      importInput({
        env: { BRAIN_API_KEY: 'user-supplied-value' },
        envFile: '~/secrets/brain-mcp.env',
        highPrivilegeTools: ['brain_delete'],
        approvalRequiredTools: ['brain_delete', 'brain_rotate'],
      }),
    );

    expect(record.env).toEqual({ BRAIN_API_KEY: 'user-supplied-value' });
    expect(record.highPrivilegeTools).toEqual(['brain_delete']);
    expect(record.approvalRequiredTools).toEqual(['brain_delete', 'brain_rotate']);
    expect(record.envFile).toBe(join(tempDir, 'secrets', 'brain-mcp.env'));

    const persisted = repository.getServer(record.id);
    expect(persisted?.env).toEqual({ BRAIN_API_KEY: 'user-supplied-value' });
    expect(persisted?.approvalRequiredTools).toEqual(['brain_delete', 'brain_rotate']);
    expect(persisted?.envFile).toBe(join(tempDir, 'secrets', 'brain-mcp.env'));
  });

  it('never copies harness secret values during import', async () => {
    const scan = await service.scan(['claude']);
    const discovered = scan.entries[0];
    expect(discovered).toBeDefined();

    const record = await service.importEntry({
      harness: discovered?.harness ?? 'claude',
      name: discovered?.name ?? 'brain',
      transport: discovered?.transport,
      command: discovered?.command ?? null,
      args: discovered?.args,
      url: discovered?.url ?? null,
    });

    expect(record.env).toEqual({});
    const serialized = JSON.stringify(record);
    for (const secret of FIXTURE_SECRETS) expect(serialized).not.toContain(secret);
  });

  it('maps runtimes from the imported command and transport', async () => {
    const cases: Array<{ input: Partial<HarnessImportInput>; runtime: string }> = [
      { input: { command: 'node', transport: 'stdio' }, runtime: 'node' },
      { input: { command: 'npx', args: ['-y', '@example/mcp'], transport: 'stdio' }, runtime: 'node' },
      { input: { command: 'bun', transport: 'stdio' }, runtime: 'node' },
      { input: { command: 'python3', args: ['server.py'], transport: 'stdio' }, runtime: 'python' },
      { input: { command: 'uv', args: ['run', 'server.py'], transport: 'stdio' }, runtime: 'python' },
      { input: { command: '/usr/bin/python3.12', transport: 'stdio' }, runtime: 'python' },
      { input: { command: '/usr/local/bin/mcp-server', transport: 'stdio' }, runtime: 'binary' },
      { input: { transport: 'http', url: 'https://mcp.example.com/remote' }, runtime: 'remote-agent' },
    ];

    for (const testCase of cases) {
      const record = await service.importEntry(importInput(testCase.input));
      expect(record.runtime).toBe(testCase.runtime);
    }
  });

  it('imports remote entries without a command and keeps the url', async () => {
    const record = await service.importEntry(
      importInput({ transport: 'http', command: null, args: undefined, url: 'https://mcp.example.com/remote' }),
    );

    expect(record.runtime).toBe('remote-agent');
    expect(record.transport).toBe('http');
    expect(record.command).toBeNull();
    expect(record.args).toEqual([]);
    expect(record.url).toBe('https://mcp.example.com/remote');
  });

  it('rejects imports that do not satisfy the server-create rules', async () => {
    await expectGatewayError(service.importEntry(importInput({ command: null })), /command is required for stdio/);
    await expectGatewayError(
      service.importEntry(importInput({ transport: 'http', command: null, url: null })),
      /url is required for remote transports/,
    );
    await expectGatewayError(service.importEntry(importInput({ harness: 'nope' })), /Unknown harness 'nope'/);
    await expectGatewayError(service.importEntry(importInput({ name: '   ' })), /name is required/);
    await expectGatewayError(service.importEntry(importInput({ name: '???' })), /usable characters/);
    await expectGatewayError(
      service.importEntry(importInput({ transport: 'carrier-pigeon' as HarnessImportInput['transport'] })),
      /transport must be one of/,
    );

    expect(repository.listServers()).toEqual([]);
  });

  it('exposes deriveRuntime and sanitizeServerName as pure helpers', () => {
    expect(deriveRuntime({ transport: 'stdio', command: 'node' })).toBe('node');
    expect(deriveRuntime({ transport: 'sse', command: '' })).toBe('remote-agent');
    expect(sanitizeServerName('My Server #1')).toBe('my-server-1');
    expect(sanitizeServerName('---weird___name---')).toBe('weird___name');
    expect(sanitizeServerName('???')).toBe('');
  });
});
