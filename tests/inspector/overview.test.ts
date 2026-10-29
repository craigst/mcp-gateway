import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import type { ServerSourceInfo } from '../../src/core/types.js';
import {
  profileEnvSecretName,
  profileHeaderSecretName,
} from '../../src/config_profiles/index.js';
import {
  createInspectorHarness,
  issueKey,
  seedAuditMatrix,
  seedProfile,
  seedServer,
  seedTools,
  type InspectorHarness,
} from './support.js';

const harnesses: InspectorHarness[] = [];

beforeEach(() => {
  harnesses.length = 0;
});

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.dispose();
});

function setup(): InspectorHarness {
  const harness = createInspectorHarness();
  harnesses.push(harness);
  return harness;
}

function sampleSource(serverId: string): ServerSourceInfo {
  return {
    serverId,
    sourceKind: 'catalog',
    catalogSourceId: 'cat_example',
    catalogEntryId: 'brain-mcp',
    repoUrl: 'https://github.com/example/brain-mcp',
    requestedRef: 'v1.0.0',
    installedCommit: 'a'.repeat(40),
    installedVersion: '1.0.0',
    latestCommit: 'b'.repeat(40),
    latestVersion: 'v2.0.0',
    latestRef: 'v2.0.0',
    updateAvailable: true,
    checkedAt: new Date().toISOString(),
    checkError: null,
    changelogUrl: 'https://github.com/example/brain-mcp/compare/aaaaaaaaaaaa...bbbbbbbbbbbb',
  };
}

describe('ServerInspectorService.overview', () => {
  it('composes server metadata, tools/prompts/resources, config and source', async () => {
    const harness = setup();
    const server = seedServer(harness, {
      name: 'brain',
      env: {
        PUBLIC_URL: 'https://example.internal',
        API_TOKEN: 'server-token-value',
        EMPTY_VALUE: '',
      },
      headers: { 'x-api-key': 'header-secret-value', 'x-trace': 'trace-1' },
      capabilities: { tools: { listChanged: true }, logging: {}, experimental: { x: 1 } },
      instructions: 'Use the brain tools carefully.',
      prompts: [{ name: 'summarise', description: 'Summarise text', arguments: [{ name: 'text', required: true }] }],
      resources: [
        {
          uri: 'brain://notes',
          name: 'notes',
          description: 'Brain notes',
          mimeType: 'text/plain',
        },
      ],
    });
    seedTools(harness, server.id, [
      { name: 'echo', description: 'Echo text' },
      { name: 'add', description: 'Add numbers' },
    ]);
    const master = issueKey(harness, 'master-key', 'master');
    const agent = issueKey(harness, 'agent-key', 'agent');
    const { profileId } = await seedProfile(harness, server.id);
    seedAuditMatrix(harness, server.id, master.id, agent.id);

    const overview = harness.inspector.overview(server.id);

    expect(overview.server.id).toBe(server.id);
    expect(overview.server.name).toBe('brain');
    expect(overview.server.capabilities).toEqual({
      tools: { listChanged: true },
      logging: {},
      experimental: { x: 1 },
    });
    expect(overview.server.instructions).toBe('Use the brain tools carefully.');
    expect(overview.tools.map((tool) => tool.name)).toEqual(['add', 'echo']);
    expect(overview.prompts).toHaveLength(1);
    expect(overview.prompts[0]?.name).toBe('summarise');
    expect(overview.resources).toHaveLength(1);
    expect(overview.resources[0]?.uri).toBe('brain://notes');

    // Env/header view: secret-looking names are masked (value null), safe values visible.
    const envByKey = new Map(overview.config.env.map((entry) => [entry.key, entry]));
    expect(envByKey.get('API_TOKEN')).toEqual({
      key: 'API_TOKEN',
      masked: true,
      value: null,
      source: 'server',
    });
    expect(envByKey.get('PUBLIC_URL')).toEqual({
      key: 'PUBLIC_URL',
      masked: false,
      value: 'https://example.internal',
      source: 'server',
    });
    expect(envByKey.get('EMPTY_VALUE')?.masked).toBe(false);
    expect(overview.config.env.map((entry) => entry.key)).toEqual(['API_TOKEN', 'EMPTY_VALUE', 'PUBLIC_URL']);

    const headerByKey = new Map(overview.config.headers.map((entry) => [entry.key, entry]));
    expect(headerByKey.get('x-api-key')).toMatchObject({ masked: true, value: null, source: 'header' });
    expect(headerByKey.get('x-trace')).toMatchObject({ masked: false, value: 'trace-1' });

    // Attached profile: metadata only (no values), plus vault secret NAMES.
    expect(overview.config.profiles).toHaveLength(1);
    const profile = overview.config.profiles[0];
    expect(profile).toMatchObject({ id: profileId, name: 'Example credentials', description: 'Fixture profile' });
    expect(profile?.entries).toEqual([
      { key: 'API_TOKEN', source: 'encrypted', ref: null },
      { key: 'BASE_URL', source: 'encrypted', ref: null },
      { key: 'EXISTING_KEY', source: 'vault-ref', ref: 'EXISTING_SECRET' },
    ]);
    expect(profile?.headers).toEqual([{ key: 'AUTHORIZATION', source: 'encrypted', ref: null }]);

    const expectedVaultRefs = [
      'EXISTING_SECRET',
      profileEnvSecretName(profileId, 'API_TOKEN'),
      profileEnvSecretName(profileId, 'BASE_URL'),
      profileHeaderSecretName(profileId, 'AUTHORIZATION'),
    ];
    expect(new Set(overview.config.vaultRefs)).toEqual(new Set(expectedVaultRefs));
    // Secret-looking server env/header values appear only through the masked
    // config view (never unmasked), and profile/vault values are never included.
    const serialized = JSON.stringify(overview);
    expect(serialized).not.toContain('profile-encrypted-token');
    expect(serialized).not.toContain('profile-header-token');
    expect(serialized).not.toContain('vault-ref-secret-value');
    for (const entry of overview.config.env) {
      if (entry.masked) expect(entry.value).toBeNull();
    }
    for (const entry of overview.config.headers) {
      if (entry.masked) expect(entry.value).toBeNull();
    }
  });

  it('computes usage stats, keys used and recent activity from the audit log', async () => {
    const harness = setup();
    const server = seedServer(harness, { name: 'brain' });
    seedTools(harness, server.id, [{ name: 'echo' }, { name: 'add' }, { name: 'danger_delete' }]);
    const master = issueKey(harness, 'master-key', 'master');
    const agent = issueKey(harness, 'agent-key', 'agent');
    seedAuditMatrix(harness, server.id, master.id, agent.id);

    const overview = harness.inspector.overview(server.id);

    // 10 tools/call rows: 7 ok, 2 error, 1 denied (denied counts toward errorRate).
    expect(overview.stats).toMatchObject({
      total: 10,
      ok: 7,
      error: 2,
      denied: 1,
      errorRate: 0.3,
      distinctKeys: 2,
      avgLatencyMs: 55,
      p50LatencyMs: 50,
      p95LatencyMs: 100,
    });
    expect(overview.stats.lastUsedAt).toEqual(expect.any(String));

    expect(overview.stats.toolUsage).toEqual([
      { toolId: `${server.id}:echo`, name: 'echo', count: 5, lastUsedAt: expect.any(String), avgLatencyMs: 42 },
      { toolId: `${server.id}:add`, name: 'add', count: 4, lastUsedAt: expect.any(String), avgLatencyMs: 65 },
      {
        toolId: `${server.id}:danger_delete`,
        name: 'danger_delete',
        count: 1,
        lastUsedAt: expect.any(String),
        avgLatencyMs: 80,
      },
    ]);

    expect(overview.keysUsed).toHaveLength(2);
    expect(overview.keysUsed[0]).toMatchObject({
      keyId: agent.id,
      keyName: 'agent-key',
      keyPrefix: agent.plaintext.slice(0, 12),
      keyType: 'agent',
      count: 6,
    });
    expect(overview.keysUsed[1]).toMatchObject({
      keyId: master.id,
      keyName: 'master-key',
      keyType: 'master',
      count: 4,
    });

    // Recent activity includes non-tools/call rows (e.g. tools/list) and is newest-first.
    expect(overview.activity).toHaveLength(11);
    expect(overview.activity[0]?.method).toBe('tools/list');
    const statisticsCalls = overview.activity.filter((entry) => entry.method === 'tools/call');
    expect(statisticsCalls).toHaveLength(10);
  });

  it('returns null source when the server is not update-tracked', () => {
    const harness = setup();
    const server = seedServer(harness, { name: 'local-harness' });
    expect(harness.inspector.overview(server.id).source).toBeNull();
  });

  it('exposes the update source when tracked', () => {
    const sourceFor = (serverId: string): ServerSourceInfo => sampleSource(serverId);
    const harness = createInspectorHarness({ source: sourceFor('srv_placeholder0000') });
    harnesses.push(harness);
    const server = seedServer(harness, { name: 'tracked', id: 'srv_placeholder0000' });

    expect(harness.inspector.overview(server.id).source).toMatchObject({
      serverId: server.id,
      sourceKind: 'catalog',
      updateAvailable: true,
      latestRef: 'v2.0.0',
    });
  });

  it('throws TOOL_NOT_FOUND for an unknown server', () => {
    const harness = setup();
    try {
      harness.inspector.overview('srv_missing');
      throw new Error('expected overview to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe(ErrorCodes.TOOL_NOT_FOUND);
      expect((error as GatewayError).httpStatus).toBe(404);
    }
  });
});
