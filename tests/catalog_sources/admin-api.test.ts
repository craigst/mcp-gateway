import { cpSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCodes } from '../../src/core/errors.js';
import { CatalogApi } from '../../src/admin/catalog-api.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';
import {
  createCatalogHarness,
  gitInitRepo,
  makeTempDir,
  toFileUrl,
  type CatalogHarness,
} from './support.js';

const NODE_FIXTURE = fileURLToPath(new URL('../fixtures/catalog/node-repo', import.meta.url));

const harnesses: CatalogHarness[] = [];
const tempDirs: string[] = [];

beforeEach(() => {
  tempDirs.push(makeTempDir('mcp-catalog-api-'));
});

afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()?.dispose();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

interface CallOptions {
  key?: string | null;
  body?: unknown;
}

function makeRequest(method: string, options: CallOptions = {}): IncomingMessage {
  const chunks =
    options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body), 'utf8')];
  const req = Readable.from(chunks) as unknown as IncomingMessage;
  const mutable = req as unknown as {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  mutable.method = method;
  mutable.url = '/mcp/v1/admin/catalog';
  mutable.headers =
    options.key === null || options.key === undefined ? {} : { authorization: `Bearer ${options.key}` };
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
  api: CatalogApi,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<{ handled: boolean; response: ApiResponse }> {
  const req = makeRequest(method, options);
  const { res, done } = makeResponse();
  const handled = await api.handle(req, res, new URL(`http://localhost${path}`));
  if (!handled) return { handled, response: { status: 0, body: {} } };
  return { handled, response: await done };
}

describe('CatalogApi (admin REST, API-V2 §1)', () => {
  const setup = (): {
    harness: CatalogHarness;
    root: string;
    api: CatalogApi;
    masterKey: string;
    agentKey: string;
  } => {
    const root = tempDirs[tempDirs.length - 1] as string;
    const harness = createCatalogHarness(root);
    harnesses.push(harness);
    const keys = new SqliteKeyService(harness.db, { pepper: null });
    const masterKey = keys.issue({ name: 'master', keyType: 'master' }).plaintext;
    const agentKey = keys.issue({ name: 'agent', keyType: 'agent' }).plaintext;
    const api = new CatalogApi({ config: harness.config, keys, catalog: harness.service });
    return { harness, root, api, masterKey, agentKey };
  };

  it('requires a master key and returns the standard error envelope', async () => {
    const { api, agentKey } = setup();

    const anonymous = await call(api, 'GET', '/mcp/v1/admin/catalog/sources');
    expect(anonymous.response.status).toBe(401);
    expect(anonymous.response.body.error).toMatchObject({ code: ErrorCodes.KEY_INVALID });

    const agent = await call(api, 'GET', '/mcp/v1/admin/catalog/sources', { key: agentKey });
    expect(agent.response.status).toBe(403);
    expect(agent.response.body.error).toMatchObject({ code: ErrorCodes.ACCESS_DENIED });
  });

  it('creates, lists and deletes a source without echoing its token', async () => {
    const { harness, root, api, masterKey } = setup();
    const repoDir = join(root, 'node-repo');
    cpSync(NODE_FIXTURE, repoDir, { recursive: true });
    gitInitRepo(repoDir);
    const token = 'ghp_admin_api_token_0123456789';

    const created = await call(api, 'POST', '/mcp/v1/admin/catalog/sources', {
      key: masterKey,
      body: {
        label: 'Example source',
        kind: 'github-repo',
        repoUrl: toFileUrl(repoDir),
        ref: 'main',
        token,
      },
    });
    expect(created.response.status).toBe(201);
    const source = created.response.body.source as Record<string, unknown>;
    expect(source.tokenSecretName).toBe(`CATALOG_${String(source.id)}_TOKEN`);
    expect(JSON.stringify(created.response.body)).not.toContain(token);

    const list = await call(api, 'GET', '/mcp/v1/admin/catalog/sources', { key: masterKey });
    expect(list.response.status).toBe(200);
    expect(JSON.stringify(list.response.body)).not.toContain(token);

    const entries = await call(
      api,
      'GET',
      `/mcp/v1/admin/catalog/sources/${String(source.id)}/entries`,
      { key: masterKey },
    );
    expect(entries.response.status).toBe(200);
    expect((entries.response.body.entries as unknown[]).length).toBe(1);

    const removed = await call(
      api,
      'DELETE',
      `/mcp/v1/admin/catalog/sources/${String(source.id)}`,
      { key: masterKey },
    );
    expect(removed.response.status).toBe(200);
    expect(removed.response.body).toEqual({ deleted: true });
    expect(await harness.service.listSources()).toEqual([]);
  });

  it('installs an entry and imports a raw URL with start + test', async () => {
    const { root, api, masterKey } = setup();
    const repoDir = join(root, 'node-repo');
    cpSync(NODE_FIXTURE, repoDir, { recursive: true });
    gitInitRepo(repoDir);
    const repoUrl = toFileUrl(repoDir);

    const created = await call(api, 'POST', '/mcp/v1/admin/catalog/sources', {
      key: masterKey,
      body: { label: 'Node source', kind: 'github-repo', repoUrl },
    });
    const sourceId = (created.response.body.source as { id: string }).id;

    const installed = await call(api, 'POST', '/mcp/v1/admin/catalog/install', {
      key: masterKey,
      body: { sourceId, entryId: 'node-repo', name: 'installed-node', start: true, test: true },
    });
    expect(installed.response.status).toBe(201);
    expect(installed.response.body.server).toMatchObject({
      name: 'installed-node',
      status: 'running',
    });
    expect(installed.response.body.test).toMatchObject({ ok: true, toolCount: 5 });

    const imported = await call(api, 'POST', '/mcp/v1/admin/catalog/import-url', {
      key: masterKey,
      body: { url: repoUrl, name: 'imported-node', start: true, test: true },
    });
    expect(imported.response.status).toBe(201);
    expect(imported.response.body.server).toMatchObject({ name: 'imported-node' });
    expect(imported.response.body.test).toMatchObject({ ok: true, toolCount: 5 });
  });

  it('supports ?refresh=1 on the entries route', async () => {
    const { root, api, masterKey } = setup();
    const repoDir = join(root, 'node-repo');
    cpSync(NODE_FIXTURE, repoDir, { recursive: true });
    gitInitRepo(repoDir);

    const created = await call(api, 'POST', '/mcp/v1/admin/catalog/sources', {
      key: masterKey,
      body: { label: 'Node source', kind: 'github-repo', repoUrl: toFileUrl(repoDir) },
    });
    const sourceId = (created.response.body.source as { id: string }).id;

    const refreshed = await call(
      api,
      'GET',
      `/mcp/v1/admin/catalog/sources/${sourceId}/entries?refresh=1`,
      { key: masterKey },
    );
    expect(refreshed.response.status).toBe(200);
    expect((refreshed.response.body.entries as unknown[]).length).toBe(1);
  });

  it('validates request bodies and unknown routes', async () => {
    const { api, masterKey } = setup();

    const invalid = await call(api, 'POST', '/mcp/v1/admin/catalog/sources', {
      key: masterKey,
      body: { kind: 'github-repo', repoUrl: 'https://github.com/example/repo' },
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.response.body.error).toMatchObject({ code: ErrorCodes.INVALID_PARAMS });

    const invalidKind = await call(api, 'POST', '/mcp/v1/admin/catalog/sources', {
      key: masterKey,
      body: { label: 'x', kind: 'not-a-kind', repoUrl: 'https://github.com/example/repo' },
    });
    expect(invalidKind.response.status).toBe(400);

    // Non-catalog admin paths are not handled by this sub-router.
    const notCatalog = await call(api, 'GET', '/mcp/v1/admin/servers', { key: masterKey });
    expect(notCatalog.handled).toBe(false);

    // Unknown catalog sub-routes are not handled either (ingress returns 404).
    const unknown = await call(api, 'GET', '/mcp/v1/admin/catalog/nope', { key: masterKey });
    expect(unknown.handled).toBe(false);
  });
});
