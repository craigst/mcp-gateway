import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/core/db.js';
import { ErrorCodes } from '../../src/core/errors.js';
import type { AuthenticatedKey } from '../../src/core/types.js';
import { BackupApi, type BackupApiDeps } from '../../src/admin/backup-api.js';
import { DefaultBackupService } from '../../src/backup/service.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';
import {
  OPERATOR_PASSWORD,
  OPERATOR_USERNAME,
  makeBackupConfig,
  makeRoot,
  removeRoot,
  seedState,
  type BackupHarness,
} from './support.js';

const harnesses: BackupHarness[] = [];
const roots: string[] = [];

beforeEach(() => {
  roots.push(makeRoot('backup-api-'));
});

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()?.dispose();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) removeRoot(root);
  }
});

interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function makeRequest(method: string, headers: Record<string, string> = {}, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const req = Readable.from(chunks) as unknown as IncomingMessage;
  const mutable = req as unknown as { method: string; url: string; headers: Record<string, string> };
  mutable.method = method;
  mutable.url = '/mcp/v1/admin/backups';
  mutable.headers = {
    ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(JSON.stringify(body))) }),
    ...headers,
  };
  return req;
}

function makeResponse(): { res: ServerResponse; done: Promise<ApiResponse> } {
  let status = 0;
  let headers: Record<string, string> = {};
  let resolveDone: (value: ApiResponse) => void = () => {};
  const done = new Promise<ApiResponse>((resolve) => {
    resolveDone = resolve;
  });
  const res = {
    writeHead: (code: number, responseHeaders?: Record<string, string>) => {
      status = code;
      headers = responseHeaders ?? {};
    },
    end: (chunk?: string) => {
      resolveDone({ status, headers, body: chunk ? (JSON.parse(chunk) as Record<string, unknown>) : {} });
    },
  } as unknown as ServerResponse;
  return { res, done };
}

async function call(
  api: BackupApi,
  method: string,
  path: string,
  options: { key?: string; body?: unknown } = {},
): Promise<{ handled: boolean; response: ApiResponse }> {
  const headers: Record<string, string> = {};
  if (options.key !== undefined) headers.authorization = `Bearer ${options.key}`;
  const req = makeRequest(method, headers, options.body);
  const { res, done } = makeResponse();
  const handled = await api.handle(req, res, new URL(`http://localhost${path}`));
  if (!handled) return { handled, response: { status: 0, headers: {}, body: {} } };
  return { handled, response: await done };
}

interface ApiSetup {
  harness: BackupHarness;
  api: BackupApi;
  service: DefaultBackupService;
  masterKey: string;
  agentKey: string;
}

function setup(): ApiSetup {
  const root = roots[roots.length - 1] as string;
  const config = makeBackupConfig(root);
  const db = openDatabase(':memory:');
  const harness = seedState(db, config);
  harnesses.push(harness);
  const keys = new SqliteKeyService(db, { pepper: null });
  const masterKey = keys.issue({ name: 'master-key', keyType: 'master' }).plaintext;
  const agentKey = keys.issue({ name: 'agent-key', keyType: 'agent' }).plaintext;
  const service = new DefaultBackupService({ db, config, vault: harness.vault });
  const api = new BackupApi({ config, keys, auth: harness.auth, backup: service });
  return { harness, api, service, masterKey, agentKey };
}

describe('BackupApi (admin REST)', () => {
  it('requires a master key', async () => {
    const { api, agentKey } = setup();

    const anonymous = await call(api, 'GET', '/backups');
    expect(anonymous.response.status).toBe(401);
    expect(anonymous.response.body.error).toMatchObject({ code: ErrorCodes.KEY_INVALID });

    const agent = await call(api, 'GET', '/backups', { key: agentKey });
    expect(agent.response.status).toBe(403);
    expect(agent.response.body.error).toMatchObject({ code: ErrorCodes.ACCESS_DENIED });
  });

  it('creates a backup after verifying the operator password (Bearer + username)', async () => {
    const { api, masterKey } = setup();

    const missingUsername = await call(api, 'POST', '/backups', {
      key: masterKey,
      body: { password: OPERATOR_PASSWORD },
    });
    expect(missingUsername.response.status).toBe(400);

    const wrongPassword = await call(api, 'POST', '/backups', {
      key: masterKey,
      body: { password: 'wrong-password', username: OPERATOR_USERNAME },
    });
    expect(wrongPassword.response.status).toBe(401);
    expect(wrongPassword.response.body.error).toMatchObject({ code: ErrorCodes.KEY_INVALID });

    const created = await call(api, 'POST', '/backups', {
      key: masterKey,
      body: { password: OPERATOR_PASSWORD, username: OPERATOR_USERNAME, includeAudit: false },
    });
    expect(created.response.status).toBe(201);
    expect(created.response.body).toMatchObject({
      includeAudit: false,
      counts: { users: 1, servers: 3, secrets: 2, auditEntries: 0 },
    });
    expect(JSON.stringify(created.response.body)).not.toContain(OPERATOR_PASSWORD);
  });

  it('accepts a session principal without a username field', async () => {
    const { harness, service, masterKey } = setup();
    const config = harness.config;
    const authenticator = (): AuthenticatedKey => ({
      id: `ui:${OPERATOR_USERNAME}`,
      name: 'ui-admin',
      keyType: 'master',
      keyPrefix: 'ui',
      serverGrants: [],
      delegationAllowed: true,
      escalationAllowed: true,
      expiresAt: null,
      revokedAt: null,
      pausedAt: null,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      metadata: {},
    });
    const api = new BackupApi({
      config,
      keys: { authenticate: () => { throw new Error('unused'); } } as unknown as BackupApiDeps['keys'],
      auth: harness.auth,
      backup: service,
      authenticate: authenticator,
    });

    const created = await call(api, 'POST', '/backups', {
      key: masterKey,
      body: { password: OPERATOR_PASSWORD },
    });
    expect(created.response.status).toBe(201);

    const wrong = await call(api, 'POST', '/backups', {
      key: masterKey,
      body: { password: 'nope' },
    });
    expect(wrong.response.status).toBe(401);
  });

  it('lists, downloads and deletes backups', async () => {
    const { api, masterKey } = setup();
    const created = await call(api, 'POST', '/backups', {
      key: masterKey,
      body: { password: OPERATOR_PASSWORD, username: OPERATOR_USERNAME },
    });
    const metadata = created.response.body as { id: string; fileName: string };
    expect(metadata.id).toMatch(/^backup_/);

    const listed = await call(api, 'GET', '/backups', { key: masterKey });
    expect(listed.response.status).toBe(200);
    expect((listed.response.body.backups as unknown[]).length).toBe(1);

    const download = await call(api, 'GET', `/backups/${metadata.id}/download`, { key: masterKey });
    expect(download.response.status).toBe(200);
    expect(download.response.headers['content-type']).toContain('application/json');
    expect(download.response.headers['content-disposition']).toBe(
      `attachment; filename="${metadata.fileName}"`,
    );
    expect(download.response.body).toMatchObject({ format: 'mcp-gateway-backup', version: 1 });

    const missing = await call(api, 'GET', '/backups/backup_doesnotexist0000/download', {
      key: masterKey,
    });
    expect(missing.response.status).toBe(404);

    const deleted = await call(api, 'DELETE', `/backups/${metadata.id}`, { key: masterKey });
    expect(deleted.response.status).toBe(200);
    expect(deleted.response.body).toEqual({ deleted: true });
    expect((await call(api, 'DELETE', `/backups/${metadata.id}`, { key: masterKey })).response.status).toBe(404);
  });

  it('restores from an envelope object or base64 string', async () => {
    const { api, masterKey, service } = setup();
    const created = await call(api, 'POST', '/backups', {
      key: masterKey,
      body: { password: OPERATOR_PASSWORD, username: OPERATOR_USERNAME },
    });
    const metadata = created.response.body as { id: string };
    const { envelope } = service.read(metadata.id);

    const restored = await call(api, 'POST', '/backups/restore', {
      key: masterKey,
      body: {
        backup: envelope,
        password: OPERATOR_PASSWORD,
        confirm: 'RESTORE',
        username: OPERATOR_USERNAME,
      },
    });
    expect(restored.response.status).toBe(200);
    expect(restored.response.body.result).toMatchObject({ usersRestored: 1, serversRestored: 3, secretsRestored: 2 });

    const encoded = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
    const restoredBase64 = await call(api, 'POST', '/backups/restore', {
      key: masterKey,
      body: {
        backup: encoded,
        password: OPERATOR_PASSWORD,
        confirm: 'RESTORE',
        username: OPERATOR_USERNAME,
      },
    });
    expect(restoredBase64.response.status).toBe(200);

    const badConfirm = await call(api, 'POST', '/backups/restore', {
      key: masterKey,
      body: { backup: envelope, password: OPERATOR_PASSWORD, username: OPERATOR_USERNAME },
    });
    expect(badConfirm.response.status).toBe(400);

    const badBackup = await call(api, 'POST', '/backups/restore', {
      key: masterKey,
      body: { backup: 42, password: OPERATOR_PASSWORD, confirm: 'RESTORE', username: OPERATOR_USERNAME },
    });
    expect(badBackup.response.status).toBe(400);

    const wrongPassword = await call(api, 'POST', '/backups/restore', {
      key: masterKey,
      body: { backup: envelope, password: 'wrong', confirm: 'RESTORE', username: OPERATOR_USERNAME },
    });
    expect(wrongPassword.response.status).toBe(401);
  });

  it('returns false for non-backup routes and wrong methods', async () => {
    const { api, masterKey } = setup();
    expect((await call(api, 'GET', '/servers', { key: masterKey })).handled).toBe(false);
    expect((await call(api, 'GET', '/backups/nope', { key: masterKey })).handled).toBe(false);
    expect((await call(api, 'POST', '/backups/restore/extra', { key: masterKey })).handled).toBe(false);
  });
});
