import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { SettingsApi } from '../../src/admin/settings-api.js';
import type { GatewayConfig } from '../../src/core/config.js';
import { ErrorCodes } from '../../src/core/errors.js';
import type { AuthenticatedKey } from '../../src/core/types.js';
import { sessionPrincipal } from '../../src/auth/request-auth.js';
import { SqliteUiAuthService } from '../../src/auth/service.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';
import {
  jsonResponse,
  makeConfig,
  makeDb,
  mockRequest,
  mockResponse,
  silentLogger,
  TEST_PASSWORD,
  TEST_USERNAME,
  type MockResponse,
} from '../auth/support.js';

const SETTINGS_PATH = '/mcp/v1/admin/settings';
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const dispose = cleanups.pop();
    if (dispose) dispose();
  }
});

interface Harness {
  db: DatabaseSync;
  config: GatewayConfig;
  auth: SqliteUiAuthService;
  keys: SqliteKeyService;
  master: string;
  agent: string;
  api: SettingsApi;
}

interface HarnessOptions {
  config?: Partial<GatewayConfig>;
  /** Default true: run ensureBootstrapUser() with the configured password. */
  bootstrap?: boolean;
  authenticate?: (req: import('node:http').IncomingMessage) => AuthenticatedKey;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const db = makeDb();
  const config = makeConfig({
    vaultSecret: 'settings-test-vault-secret-0123456789',
    gitImportAllowedPrefixes: ['https://github.com/'],
    autostart: 'alpha,beta',
    ...options.config,
  });
  const auth = new SqliteUiAuthService(db, config, { logger: silentLogger() });
  if (options.bootstrap !== false) auth.ensureBootstrapUser();
  const keys = new SqliteKeyService(db, { logger: silentLogger() });
  const master = keys.issue({ name: 'master', keyType: 'master' }).plaintext;
  const agent = keys.issue({ name: 'agent', keyType: 'agent' }).plaintext;
  const api = new SettingsApi({
    config,
    keys,
    db,
    auth,
    logger: silentLogger(),
    ...(options.authenticate ? { authenticate: options.authenticate } : {}),
  });
  cleanups.push(() => db.close());
  return { db, config, auth, keys, master, agent, api };
}

interface CallOptions {
  key?: string | null;
  headers?: Record<string, string>;
}

interface CallResult {
  handled: boolean;
  res: MockResponse;
  json: () => any;
}

async function call(
  harness: Harness,
  method: string,
  path: string = SETTINGS_PATH,
  options: CallOptions = {},
): Promise<CallResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const key = options.key === undefined ? harness.master : options.key;
  if (key !== null) headers.authorization = `Bearer ${key}`;
  const request = mockRequest({ method, headers });
  const response = mockResponse();
  const handled = await harness.api.handle(
    request,
    response.asServerResponse(),
    new URL(`http://localhost:8080${path}`),
  );
  return { handled, res: response, json: () => jsonResponse(response) };
}

function packageVersion(): string {
  const parsed = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  return String(parsed.version);
}

describe('SettingsApi GET /admin/settings', () => {
  it('returns the settings snapshot and account for a master key', async () => {
    const harness = makeHarness();
    const result = await call(harness, 'GET');

    expect(result.handled).toBe(true);
    expect(result.res.statusCode).toBe(200);
    const body = result.json();

    expect(body.settings).toMatchObject({
      version: packageVersion(),
      host: harness.config.host,
      port: harness.config.port,
      dataDir: harness.config.dataDir,
      dbPath: harness.config.dbPath,
      reposDir: harness.config.reposDir,
      uiDistDir: harness.config.uiDistDir,
      vaultEnabled: true,
      gitImportEnabled: true,
      gitImportAllowedPrefixes: ['https://github.com/'],
      delegationMaxDepth: 3,
      autostart: 'alpha,beta',
      logLevel: 'silent',
      uiUsername: TEST_USERNAME,
      userCount: 1,
      sessionCount: 0,
      setupRequired: false,
    });
    expect(body.account).toEqual({ username: 'api-key', sessionCount: 0 });
    // No secret material may leak through the settings surface.
    expect(result.res.payload).not.toContain('settings-test-vault-secret');
    expect(result.res.payload).not.toContain(TEST_PASSWORD);
  });

  it('reflects vault and git-import configuration flags', async () => {
    const harness = makeHarness({
      config: { vaultSecret: null, gitImportAllowedPrefixes: [] },
    });
    const result = await call(harness, 'GET');
    expect(result.res.statusCode).toBe(200);
    expect(result.json().settings).toMatchObject({
      vaultEnabled: false,
      gitImportEnabled: false,
      gitImportAllowedPrefixes: [],
    });
  });

  it('reports first-run setup state when no user exists', async () => {
    const harness = makeHarness({ bootstrap: false, config: { uiPassword: null } });
    const result = await call(harness, 'GET');
    expect(result.res.statusCode).toBe(200);
    expect(result.json().settings).toMatchObject({
      uiUsername: TEST_USERNAME, // falls back to the configured username
      userCount: 0,
      sessionCount: 0,
      setupRequired: true,
    });
  });

  it('reports the session principal and live session counts', async () => {
    const harness = makeHarness();
    const first = harness.auth.login(TEST_USERNAME, TEST_PASSWORD);
    harness.auth.login(TEST_USERNAME, TEST_PASSWORD);
    harness.auth.logout(first.token);
    expect(harness.auth.activeSessions(TEST_USERNAME)).toBe(1);

    const alice = sessionPrincipal('alice');
    const sessionApi = new SettingsApi({
      config: harness.config,
      keys: harness.keys,
      db: harness.db,
      auth: harness.auth,
      logger: silentLogger(),
      authenticate: () => alice,
    });
    const read = async (): Promise<CallResult> => {
      const request = mockRequest({ method: 'GET', headers: {} });
      const response = mockResponse();
      const handled = await sessionApi.handle(
        request,
        response.asServerResponse(),
        new URL(`http://localhost:8080${SETTINGS_PATH}`),
      );
      return { handled, res: response, json: () => jsonResponse(response) };
    };

    const result = await read();
    expect(result.res.statusCode).toBe(200);
    expect(result.json().settings.sessionCount).toBe(1);
    expect(result.json().account).toEqual({ username: 'alice', sessionCount: 1 });

    // Expired sessions must not be counted.
    harness.db.prepare('UPDATE ui_sessions SET expires_at = ? WHERE revoked_at IS NULL').run(
      new Date(Date.now() - 1_000).toISOString(),
    );
    const afterExpiry = await read();
    expect(afterExpiry.json().settings.sessionCount).toBe(0);
    expect(afterExpiry.json().account.sessionCount).toBe(0);
  });

  it('requires a master or session principal', async () => {
    const harness = makeHarness();

    const anonymous = await call(harness, 'GET', SETTINGS_PATH, { key: null });
    expect(anonymous.res.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe(ErrorCodes.KEY_INVALID);

    const withAgent = await call(harness, 'GET', SETTINGS_PATH, { key: harness.agent });
    expect(withAgent.res.statusCode).toBe(403);
    expect(withAgent.json().error.data.reason).toBe('SCOPE_RESTRICTION');
  });

  it('only matches its own routes and methods', async () => {
    const harness = makeHarness();

    const other = await call(harness, 'GET', '/mcp/v1/admin/servers');
    expect(other.handled).toBe(false);
    expect(other.res.payload).toBe('');

    const wrongMethod = await call(harness, 'POST');
    expect(wrongMethod.res.statusCode).toBe(405);
    expect(wrongMethod.json().error.code).toBe(ErrorCodes.METHOD_NOT_FOUND);

    const extraSegment = await call(harness, 'GET', `${SETTINGS_PATH}/extra`);
    expect(extraSegment.res.statusCode).toBe(404);
  });
});
