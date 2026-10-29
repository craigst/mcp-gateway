import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HARNESS_ADAPTERS,
  normalizeClaudeEntry,
  scanAllHarnesses,
  scanAllHarnessesSync,
} from '../../src/discovery/adapters.js';
import { FIXTURE_SECRETS, HARNESS_FIXTURES, fixtureHarnessEnv } from './helpers.js';

describe('harness discovery adapters', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-harness-adapters-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const scanFixtures = () => scanAllHarnesses({ env: fixtureHarnessEnv(), homeDir: tempDir });

  const entry = async (id: string) => {
    const result = await scanFixtures();
    return result.entries.find((candidate) => candidate.id === id);
  };

  it('exposes the four built-in adapters with stable metadata', () => {
    expect(HARNESS_ADAPTERS.map((adapter) => adapter.id)).toEqual(['claude', 'opencode', 'openmausbot', 'generic']);
    const claude = HARNESS_ADAPTERS.find((adapter) => adapter.id === 'claude');
    expect(claude?.label).toBe('Claude Code');
    expect(claude?.defaultPath).toBe('~/.claude.json');
    expect(claude?.pathEnvVar).toBe('MCP_DISCOVERY_CLAUDE_CONFIG');
    expect(HARNESS_ADAPTERS.find((adapter) => adapter.id === 'opencode')?.defaultPath).toBe(
      '~/.config/opencode/opencode.json',
    );
    expect(HARNESS_ADAPTERS.find((adapter) => adapter.id === 'openmausbot')?.defaultPath).toBe(
      '~/.openmausbot/config.json',
    );
    expect(HARNESS_ADAPTERS.find((adapter) => adapter.id === 'generic')?.pathEnvVar).toBe('MCP_DISCOVERY_CONFIG');
  });

  it('parses the claude config into stdio and remote entries', async () => {
    const result = await scanFixtures();
    expect(result.errors).toEqual([]);

    const claudeSource = result.sources.find((source) => source.id === 'claude');
    expect(claudeSource).toMatchObject({
      id: 'claude',
      label: 'Claude Code',
      configPath: join(HARNESS_FIXTURES, 'claude.json'),
      exists: true,
      serverCount: 2,
    });

    const brain = await entry('claude:brain');
    expect(brain).toMatchObject({
      harness: 'claude',
      name: 'brain',
      transport: 'stdio',
      command: 'node',
      args: ['/opt/example/brain-mcp/index.js'],
      url: null,
      envKeys: ['BRAIN_API_KEY', 'BRAIN_URL'],
      envFile: null,
      headerKeys: [],
      enabled: true,
    });

    const remote = await entry('claude:docs-remote');
    expect(remote).toMatchObject({
      transport: 'http',
      command: null,
      args: [],
      url: 'https://mcp.example.com/docs',
      envKeys: [],
      headerKeys: ['Authorization', 'X-Example-Tenant'],
      enabled: true,
    });
  });

  it('parses the opencode config, command arrays and the sibling mcp.env', async () => {
    const result = await scanFixtures();
    const source = result.sources.find((candidate) => candidate.id === 'opencode');
    expect(source).toMatchObject({
      configPath: join(HARNESS_FIXTURES, 'opencode', 'opencode.json'),
      exists: true,
      serverCount: 2,
    });

    const local = await entry('opencode:local-tools');
    expect(local).toMatchObject({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/local-mcp-server'],
      url: null,
      envKeys: ['LOCAL_API_KEY'],
      envFile: join(HARNESS_FIXTURES, 'opencode', 'mcp.env'),
      enabled: true,
    });

    const remote = await entry('opencode:remote-tools');
    expect(remote).toMatchObject({
      transport: 'http',
      command: null,
      url: 'https://mcp.example.com/opencode',
      envKeys: [],
      envFile: join(HARNESS_FIXTURES, 'opencode', 'mcp.env'),
      headerKeys: ['Authorization'],
      enabled: false,
    });
  });

  it('parses the openmausbot http/sse entries', async () => {
    const result = await scanFixtures();
    const source = result.sources.find((candidate) => candidate.id === 'openmausbot');
    expect(source).toMatchObject({ exists: true, serverCount: 2 });

    const httpEntry = await entry('openmausbot:omb-http');
    expect(httpEntry).toMatchObject({
      transport: 'http',
      command: null,
      url: 'https://mcp.example.com/omb',
      envKeys: ['OMB_TOKEN'],
      headerKeys: ['Authorization'],
      enabled: true,
    });

    const sseEntry = await entry('openmausbot:omb-sse');
    expect(sseEntry).toMatchObject({
      transport: 'sse',
      url: 'https://mcp.example.com/omb/sse',
      envKeys: [],
      headerKeys: [],
      enabled: true,
    });
  });

  it('parses the generic MCP_DISCOVERY_CONFIG file', async () => {
    const result = await scanFixtures();
    const source = result.sources.find((candidate) => candidate.id === 'generic');
    expect(source).toMatchObject({
      configPath: join(HARNESS_FIXTURES, 'generic.json'),
      exists: true,
      serverCount: 1,
    });

    const generic = await entry('generic:generic-stdio');
    expect(generic).toMatchObject({
      transport: 'stdio',
      command: '/opt/example/bin/generic-mcp',
      args: ['--transport', 'stdio'],
      url: null,
      envKeys: ['GENERIC_TOKEN'],
      headerKeys: [],
      enabled: true,
    });
  });

  it('never exposes env or header VALUES anywhere in the serialized scan', async () => {
    const serialized = JSON.stringify(await scanFixtures());
    for (const secret of FIXTURE_SECRETS) {
      expect(serialized).not.toContain(secret);
    }
    // Names are still reported so the UI can show what the server needs.
    expect(serialized).toContain('BRAIN_API_KEY');
    expect(serialized).toContain('Authorization');
  });

  it('reports missing configs as errors instead of throwing', async () => {
    const missing = join(tempDir, 'does-not-exist');
    const result = await scanAllHarnesses({
      homeDir: tempDir,
      env: fixtureHarnessEnv({
        MCP_DISCOVERY_CLAUDE_CONFIG: join(missing, 'claude.json'),
        MCP_DISCOVERY_OPENCODE_CONFIG: join(missing, 'opencode.json'),
        MCP_DISCOVERY_OPENMAUSBOT_CONFIG: join(missing, 'omb.json'),
        MCP_DISCOVERY_CONFIG: join(missing, 'generic.json'),
      }),
    });

    expect(result.entries).toEqual([]);
    expect(result.errors.map((error) => error.harness).sort()).toEqual(
      ['claude', 'generic', 'openmausbot', 'opencode'].sort(),
    );
    for (const error of result.errors) expect(error.error).toContain('Config file not found');
    for (const source of result.sources) {
      expect(source.exists).toBe(false);
      expect(source.serverCount).toBe(0);
    }
  });

  it('reports a corrupt config file without leaking its contents', async () => {
    const corruptPath = join(tempDir, 'corrupt-claude.json');
    writeFileSync(corruptPath, '{ "mcpServers": { "broken": ', 'utf8');

    const result = await scanAllHarnesses({
      homeDir: tempDir,
      env: { MCP_DISCOVERY_CLAUDE_CONFIG: corruptPath },
      harnessIds: ['claude'],
    });

    expect(result.entries).toEqual([]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.exists).toBe(true);
    expect(result.sources[0]?.serverCount).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.harness).toBe('claude');
    expect(result.errors[0]?.error).toContain('not valid JSON');
    // The parser message must not be echoed: it can quote secret-bearing content.
    expect(result.errors[0]?.error).not.toContain('broken');
  });

  it('reports a generic adapter with no MCP_DISCOVERY_CONFIG', async () => {
    const result = await scanAllHarnesses({ homeDir: tempDir, env: {}, harnessIds: ['generic'] });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.exists).toBe(false);
    expect(result.sources[0]?.configPath).toBe('');
    expect(result.errors[0]).toMatchObject({ harness: 'generic' });
    expect(result.errors[0]?.error).toContain('MCP_DISCOVERY_CONFIG');
  });

  it('resolves default paths against the injected homeDir', async () => {
    const home = join(tempDir, 'home');
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    mkdirSync(join(home, '.openmausbot'), { recursive: true });
    copyFileSync(join(HARNESS_FIXTURES, 'claude.json'), join(home, '.claude.json'));
    copyFileSync(join(HARNESS_FIXTURES, 'opencode', 'opencode.json'), join(home, '.config', 'opencode', 'opencode.json'));
    copyFileSync(join(HARNESS_FIXTURES, 'opencode', 'mcp.env'), join(home, '.config', 'opencode', 'mcp.env'));
    copyFileSync(join(HARNESS_FIXTURES, 'openmausbot', 'config.json'), join(home, '.openmausbot', 'config.json'));

    const result = await scanAllHarnesses({
      homeDir: home,
      env: {},
      harnessIds: ['claude', 'opencode', 'openmausbot'],
    });

    expect(result.errors).toEqual([]);
    expect(result.sources.map((source) => [source.id, source.exists, source.serverCount])).toEqual([
      ['claude', true, 2],
      ['opencode', true, 2],
      ['openmausbot', true, 2],
    ]);
    expect(result.sources[0]?.configPath).toBe(join(home, '.claude.json'));
    const local = result.entries.find((candidate) => candidate.id === 'opencode:local-tools');
    expect(local?.envFile).toBe(join(home, '.config', 'opencode', 'mcp.env'));
  });

  it('prefers MCP_DISCOVERY_<ID>_CONFIG over the default path', async () => {
    const home = join(tempDir, 'home-override');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { 'home-only': { command: 'node', args: ['home.js'] } } }),
      'utf8',
    );

    const result = await scanAllHarnesses({
      homeDir: home,
      env: fixtureHarnessEnv(),
      harnessIds: ['claude'],
    });

    expect(result.sources[0]?.configPath).toBe(join(HARNESS_FIXTURES, 'claude.json'));
    expect(result.entries.map((candidate) => candidate.name)).toEqual(['brain', 'docs-remote']);
  });

  it('honours MCP_DISCOVERY_OPENCODE_ENV_FILE when it exists', async () => {
    const customEnvFile = join(tempDir, 'custom-mcp.env');
    writeFileSync(customEnvFile, 'LOCAL_API_KEY=fixture-value-not-a-real-secret\n', 'utf8');

    const withOverride = await scanAllHarnesses({
      homeDir: tempDir,
      env: fixtureHarnessEnv({ MCP_DISCOVERY_OPENCODE_ENV_FILE: customEnvFile }),
      harnessIds: ['opencode'],
    });
    expect(withOverride.entries.length).toBeGreaterThan(0);
    for (const candidate of withOverride.entries) expect(candidate.envFile).toBe(customEnvFile);

    const withMissingOverride = await scanAllHarnesses({
      homeDir: tempDir,
      env: fixtureHarnessEnv({ MCP_DISCOVERY_OPENCODE_ENV_FILE: join(tempDir, 'nope.env') }),
      harnessIds: ['opencode'],
    });
    for (const candidate of withMissingOverride.entries) expect(candidate.envFile).toBeNull();
  });

  it('restricts the scan to harnessIds and reports unknown ids', async () => {
    const result = await scanAllHarnesses({
      homeDir: tempDir,
      env: fixtureHarnessEnv(),
      harnessIds: ['claude', 'generic', 'does-not-exist'],
    });

    expect(result.sources.map((source) => source.id)).toEqual(['claude', 'generic']);
    expect(result.entries.every((candidate) => candidate.harness === 'claude' || candidate.harness === 'generic')).toBe(
      true,
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.harness).toBe('does-not-exist');
    expect(result.errors[0]?.error).toContain('Unknown harness adapter');
  });

  it('provides a synchronous scan with the same shape as the async one', () => {
    const syncResult = scanAllHarnessesSync({ env: fixtureHarnessEnv(), homeDir: tempDir });
    expect(syncResult.sources).toHaveLength(4);
    expect(syncResult.entries.map((candidate) => candidate.id)).toContain('claude:brain');
  });

  it('normalizes single entries purely and rejects malformed ones', () => {
    expect(normalizeClaudeEntry('bad', 'not-an-object')).toBeNull();
    expect(normalizeClaudeEntry('bad', null)).toBeNull();

    const sse = normalizeClaudeEntry('legacy', {
      type: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: 'Bearer sse-fixture-secret' },
    });
    expect(sse).toMatchObject({ id: 'claude:legacy', transport: 'sse', command: null, headerKeys: ['Authorization'] });
    expect(JSON.stringify(sse)).not.toContain('sse-fixture-secret');
  });
});
