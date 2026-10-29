import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCodes } from '../../src/core/errors.js';
import type { AuthenticatedKey } from '../../src/core/types.js';
import { InspectorApi, type InspectorApiDeps } from '../../src/admin/inspector-api.js';
import {
  createInspectorHarness,
  issueKey,
  seedAudit,
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

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

function makeRequest(
  method: string,
  headers: Record<string, string> = {},
  body?: unknown,
): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const req = Readable.from(chunks) as unknown as IncomingMessage;
  const mutable = req as unknown as { method: string; url: string; headers: Record<string, string> };
  mutable.method = method;
  mutable.url = '/mcp/v1/admin/servers';
  mutable.headers = {
    ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(JSON.stringify(body))) }),
    ...headers,
  };
  return req;
}

function makeResponse(): { res: ServerResponse; done: Promise<ApiResponse> } {
  let status = 0;
  let resolveDone: (value: ApiResponse) => void = () => {};
  const done = new Promise<ApiResponse>((resolve) => {
    resolveDone = resolve;
  });
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (chunk?: string) => {
      resolveDone({ status, body: chunk ? (JSON.parse(chunk) as Record<string, unknown>) : {} });
    },
  } as unknown as ServerResponse;
  return { res, done };
}

async function call(
  api: InspectorApi,
  method: string,
  path: string,
  options: { key?: string; body?: unknown } = {},
): Promise<{ handled: boolean; response: ApiResponse }> {
  const headers: Record<string, string> = {};
  if (options.key !== undefined) headers.authorization = `Bearer ${options.key}`;
  const req = makeRequest(method, headers, options.body);
  const { res, done } = makeResponse();
  const handled = await api.handle(req, res, new URL(`http://localhost${path}`));
  if (!handled) return { handled, response: { status: 0, body: {} } };
  return { handled, response: await done };
}

interface ApiSetup {
  harness: InspectorHarness;
  api: InspectorApi;
  masterKey: string;
  agentKey: string;
  serverId: string;
}

function setup(): ApiSetup {
  const harness = createInspectorHarness();
  harnesses.push(harness);
  const server = seedServer(harness, {
    name: 'brain',
    env: { API_TOKEN: 'server-token-value' },
    headers: { 'x-api-key': 'header-secret-value' },
  });
  seedTools(harness, server.id, [{ name: 'echo' }, { name: 'add' }]);
  const master = issueKey(harness, 'master-key', 'master');
  const agent = issueKey(harness, 'agent-key', 'agent');
  seedAudit(harness, server.id, { keyId: agent.id, status: 'ok', latencyMs: 12, toolName: 'echo' });
  seedAudit(harness, server.id, { keyId: master.id, status: 'denied', latencyMs: 8, toolName: 'add' });
  const api = new InspectorApi({
    config: harness.config,
    keys: harness.keys,
    inspector: harness.inspector,
  });
  return {
    harness,
    api,
    masterKey: master.plaintext,
    agentKey: agent.plaintext,
    serverId: server.id,
  };
}

describe('InspectorApi (admin REST)', () => {
  it('requires a master key for every route', async () => {
    const { api, agentKey, serverId } = setup();

    const anonymous = await call(api, 'GET', `/servers/${serverId}/inspector`);
    expect(anonymous.response.status).toBe(401);
    expect(anonymous.response.body.error).toMatchObject({ code: ErrorCodes.KEY_INVALID });

    const agent = await call(api, 'GET', `/servers/${serverId}/inspector`, { key: agentKey });
    expect(agent.response.status).toBe(403);
    expect(agent.response.body.error).toMatchObject({ code: ErrorCodes.ACCESS_DENIED });

    const agentReveal = await call(api, 'POST', `/servers/${serverId}/reveal`, {
      key: agentKey,
      body: { kind: 'env', key: 'API_TOKEN' },
    });
    expect(agentReveal.response.status).toBe(403);
  });

  it('serves the inspector overview directly', async () => {
    const { api, masterKey, serverId } = setup();
    const { handled, response } = await call(api, 'GET', `/servers/${serverId}/inspector`, {
      key: masterKey,
    });
    expect(handled).toBe(true);
    expect(response.status).toBe(200);
    expect(response.body.server).toMatchObject({ id: serverId, name: 'brain' });
    expect((response.body.tools as unknown[]).length).toBe(2);
    expect(response.body.stats).toMatchObject({ total: 2, ok: 1, denied: 1 });
    expect(response.body.config).toMatchObject({ profiles: [] });
  });

  it('serves paginated, filtered activity', async () => {
    const { api, masterKey, serverId } = setup();

    const { response } = await call(
      api,
      'GET',
      `/servers/${serverId}/activity?status=denied&limit=1&offset=0`,
      { key: masterKey },
    );
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect((response.body.entries as unknown[]).length).toBe(1);
    expect(response.body.summary).toMatchObject({ total: 2, denied: 1 });

    const bad = await call(api, 'GET', `/servers/${serverId}/activity?status=bogus`, {
      key: masterKey,
    });
    expect(bad.response.status).toBe(400);
    expect(bad.response.body.error).toMatchObject({ code: ErrorCodes.INVALID_PARAMS });

    const badLimit = await call(api, 'GET', `/servers/${serverId}/activity?limit=nope`, {
      key: masterKey,
    });
    expect(badLimit.response.status).toBe(400);
  });

  it('reveals env/header/profile values and audits the principal', async () => {
    const { harness, api, masterKey, serverId } = setup();
    const server = harness.repository.getServer(serverId);
    expect(server).not.toBeNull();
    const { profileId } = await seedProfile(harness, serverId);

    const envReveal = await call(api, 'POST', `/servers/${serverId}/reveal`, {
      key: masterKey,
      body: { kind: 'env', key: 'API_TOKEN' },
    });
    expect(envReveal.response.status).toBe(200);
    expect(envReveal.response.body).toEqual({ key: 'API_TOKEN', value: 'server-token-value' });

    const headerReveal = await call(api, 'POST', `/servers/${serverId}/reveal`, {
      key: masterKey,
      body: { kind: 'header', key: 'x-api-key' },
    });
    expect(headerReveal.response.body).toEqual({ key: 'x-api-key', value: 'header-secret-value' });

    const profileReveal = await call(api, 'POST', `/servers/${serverId}/reveal`, {
      key: masterKey,
      body: { kind: 'profile', profileId, key: 'API_TOKEN' },
    });
    expect(profileReveal.response.status).toBe(200);
    expect(profileReveal.response.body).toEqual({ key: 'API_TOKEN', value: 'profile-encrypted-token' });

    // The reveal is recorded with the master principal that performed it.
    const masterRecord = harness.keys.authenticate(masterKey);
    const reveals = harness.audit.query({ method: 'admin.reveal', serverId });
    expect(reveals.total).toBe(3);
    expect(reveals.entries.every((entry) => entry.keyId === masterRecord.id)).toBe(true);
    expect(reveals.entries.some((entry) => entry.payload !== null)).toBe(true);
    expect(JSON.stringify(reveals.entries)).not.toContain('server-token-value');
    expect(JSON.stringify(reveals.entries)).not.toContain('profile-encrypted-token');
  });

  it('validates reveal bodies and unknown keys', async () => {
    const { api, masterKey, serverId } = setup();

    const badKind = await call(api, 'POST', `/servers/${serverId}/reveal`, {
      key: masterKey,
      body: { kind: 'nope', key: 'API_TOKEN' },
    });
    expect(badKind.response.status).toBe(400);

    const missingProfile = await call(api, 'POST', `/servers/${serverId}/reveal`, {
      key: masterKey,
      body: { kind: 'profile', key: 'X' },
    });
    expect(missingProfile.response.status).toBe(400);

    const unknownKey = await call(api, 'POST', `/servers/${serverId}/reveal`, {
      key: masterKey,
      body: { kind: 'env', key: 'NOPE' },
    });
    expect(unknownKey.response.status).toBe(404);

    const unknownServer = await call(api, 'GET', '/servers/srv_missing/inspector', { key: masterKey });
    expect(unknownServer.response.status).toBe(404);
  });

  it('supports an injected authenticator (session cookie principals)', async () => {
    const { harness, serverId, masterKey } = setup();
    const authenticate = (req: IncomingMessage): AuthenticatedKey => {
      const isMaster = req.headers.authorization === 'Bearer session-master';
      return {
        id: isMaster ? 'ui:admin' : 'ui:guest',
        name: isMaster ? 'ui-admin' : 'ui-guest',
        keyType: isMaster ? 'master' : 'agent',
        keyPrefix: 'ui',
        serverGrants: [],
        delegationAllowed: false,
        escalationAllowed: false,
        expiresAt: null,
        revokedAt: null,
        pausedAt: null,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        metadata: {},
      };
    };
    const config = harness.config;
    const api = new InspectorApi({
      config,
      keys: { authenticate: () => { throw new Error('unused'); } } as unknown as InspectorApiDeps['keys'],
      inspector: harness.inspector,
      authenticate,
    });

    const denied = await call(api, 'GET', `/servers/${serverId}/inspector`, { key: 'session-guest' });
    expect(denied.response.status).toBe(403);

    const overview = await call(api, 'GET', `/servers/${serverId}/inspector`, { key: 'session-master' });
    expect(overview.response.status).toBe(200);

    const reveal = await call(api, 'POST', `/servers/${serverId}/reveal`, {
      key: 'session-master',
      body: { kind: 'env', key: 'API_TOKEN' },
    });
    expect(reveal.response.status).toBe(200);
    const reveals = harness.audit.query({ method: 'admin.reveal', serverId });
    expect(reveals.entries[0]?.keyId).toBe('ui:admin');
    expect(masterKey.startsWith('mcp_master_')).toBe(true);
  });

  it('returns false for non-inspector routes and wrong methods', async () => {
    const { api, masterKey, serverId } = setup();

    const logs = await call(api, 'GET', `/servers/${serverId}/logs`, { key: masterKey });
    expect(logs.handled).toBe(false);

    const wrongMethod = await call(api, 'POST', `/servers/${serverId}/inspector`, { key: masterKey });
    expect(wrongMethod.handled).toBe(false);

    const keys = await call(api, 'GET', '/keys', { key: masterKey });
    expect(keys.handled).toBe(false);

    const wrongArea = await call(api, 'GET', `/inspector/${serverId}`, { key: masterKey });
    expect(wrongArea.handled).toBe(false);
  });
});
