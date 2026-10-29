import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createContainer, type GatewayContainer } from '../../src/container.js';
import type { GatewayConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';

function makeConfig(dataDir: string): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    dbPath: join(dataDir, 'gateway.db'),
    uiDistDir: join(dataDir, 'ui'),
    vaultSecret: 'route-vault-secret-0123456789abcdef',
    bootstrapMasterKey: `mcp_master_${'r'.repeat(48)}`,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: [],
    reposDir: join(dataDir, 'repos'),
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 10_000,
    keyPepper: null,
    publicBaseUrl: 'http://127.0.0.1',
  };
}

describe('POST /admin/keys/master/regenerate', () => {
  let container: GatewayContainer;
  let baseUrl: string;
  let bootstrapKey: string;
  let activeMaster: string;

  beforeAll(async () => {
    const dataDir = join(process.cwd(), '.test-data', `master-route-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(dataDir, { recursive: true });
    const config = makeConfig(dataDir);
    container = createContainer({ config, logger: createLogger('test', 'silent') });
    baseUrl = (await container.start()).url;
    bootstrapKey = config.bootstrapMasterKey as string;
  });

  afterAll(async () => {
    if (container) {
      const dataDir = container.config.dataDir;
      await container.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  const metrics = async (key: string): Promise<number> => {
    const response = await fetch(`${baseUrl}/mcp/v1/metrics`, { headers: { authorization: `Bearer ${key}` } });
    return response.status;
  };

  it('rotates the master key, revokes the previous one and never leaks the hash', async () => {
    expect(await metrics(bootstrapKey)).toBe(200);

    const response = await fetch(`${baseUrl}/mcp/v1/admin/keys/master/regenerate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bootstrapKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ revokePrevious: true, name: 'rotated-master' }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { key: Record<string, unknown>; plaintext: string; revokedCount: number };

    expect(body.plaintext).toMatch(/^mcp_master_/);
    expect(body.key).not.toHaveProperty('keyHash');
    expect(body.key).not.toHaveProperty('key_hash');
    expect(body.key).toMatchObject({ name: 'rotated-master', keyType: 'master' });
    expect(body.revokedCount).toBeGreaterThanOrEqual(1);

    // Old master rejected, new master accepted.
    expect(await metrics(bootstrapKey)).toBe(401);
    expect(await metrics(body.plaintext)).toBe(200);
    activeMaster = body.plaintext;
  });

  it('can keep previous master keys when asked', async () => {
    const current = await fetch(`${baseUrl}/mcp/v1/admin/keys`, {
      headers: { authorization: `Bearer ${activeMaster}` },
    });
    expect(current.status).toBe(200);

    const response = await fetch(`${baseUrl}/mcp/v1/admin/keys/master/regenerate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${activeMaster}`, 'content-type': 'application/json' },
      body: JSON.stringify({ revokePrevious: false, name: 'kept-master' }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { plaintext: string; revokedCount: number };
    expect(body.revokedCount).toBe(0);
    expect(await metrics(body.plaintext)).toBe(200);
    // Both master keys remain usable when revokePrevious is false.
    expect(await metrics(activeMaster)).toBe(200);
    activeMaster = body.plaintext;
  });
});
