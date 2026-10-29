// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, parseApiError } from '../../src/ui/lib/api.js';

/** Minimal fetch Response stub (the client only needs ok/status/text). */
function fakeResponse(body: unknown, status = 200): Response {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(text) : body),
  } as unknown as Response;
}

describe('ApiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the HttpOnly session cookie on every request and never a bearer header', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ keys: [] }));
    const client = new ApiClient('http://gateway.test');

    await client.listKeys();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('http://gateway.test/mcp/v1/admin/keys');
    expect(call[1].credentials).toBe('include');
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    // The client persists no session material in browser storage.
    expect(localStorage.length).toBe(0);
  });

  it('authenticates through the session endpoints (login / me / logout / password)', async () => {
    const client = new ApiClient('http://gateway.test');

    fetchMock.mockResolvedValueOnce(
      fakeResponse({ user: { username: 'operator' }, expiresAt: '2026-10-30T00:00:00.000Z' }),
    );
    const login = await client.login('operator', 'correct horse');
    expect(login.user.username).toBe('operator');
    let call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('http://gateway.test/mcp/v1/auth/login');
    expect(call[1].method).toBe('POST');
    expect(call[1].credentials).toBe('include');
    expect(JSON.parse(String(call[1].body))).toEqual({ username: 'operator', password: 'correct horse' });

    fetchMock.mockResolvedValueOnce(fakeResponse({ authenticated: true, user: { username: 'operator' } }));
    expect(await client.getSession()).toMatchObject({ authenticated: true, user: { username: 'operator' } });
    call = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(call[0]).toBe('http://gateway.test/mcp/v1/auth/me');
    expect(call[1].credentials).toBe('include');

    fetchMock.mockResolvedValueOnce(fakeResponse({ ok: true }));
    expect(await client.logout()).toEqual({ ok: true });
    expect((fetchMock.mock.calls[2] as [string])[0]).toBe('http://gateway.test/mcp/v1/auth/logout');
    expect((fetchMock.mock.calls[2] as [string, RequestInit])[1].method).toBe('POST');

    fetchMock.mockResolvedValueOnce(fakeResponse({ ok: true }));
    await client.changePassword('current-secret', 'new-secret');
    call = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(call[0]).toBe('http://gateway.test/mcp/v1/auth/password');
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(String(call[1].body))).toEqual({
      currentPassword: 'current-secret',
      newPassword: 'new-secret',
    });
  });

  it('reports 401 responses through onUnauthorized so the shell can return to login', async () => {
    const client = new ApiClient('http://gateway.test');
    const handler = vi.fn();
    const unsubscribe = client.onUnauthorized(handler);

    fetchMock.mockResolvedValueOnce(fakeResponse({ error: { code: 401, message: 'Session expired' } }, 401));
    const caught = await client.getSession().then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({ status: 401, message: 'Session expired' });
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    fetchMock.mockResolvedValueOnce(fakeResponse({ error: { code: 401, message: 'Session expired' } }, 401));
    await client.getSession().catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('maps JSON-RPC errors returned with HTTP 200 onto ApiError', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        jsonrpc: '2.0',
        id: 'ui-1',
        error: { code: -32002, message: 'Tool Not Found', data: { tool: 'secret' } },
      }),
    );
    const client = new ApiClient('http://gateway.test');

    const caught = await client.rpc('tools/call', { name: 'secret' }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.status).toBe(200);
    expect(apiError.code).toBe(-32002);
    expect(apiError.message).toBe('Tool Not Found');
    expect(apiError.data).toEqual({ tool: 'secret' });
  });

  it('returns the JSON-RPC result and posts a well-formed envelope', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        jsonrpc: '2.0',
        id: 'ui-1',
        result: { tools: [{ name: 'echo', server_id: 'srv-1' }], total: 1 },
      }),
    );
    const client = new ApiClient('http://gateway.test');

    const result = await client.rpc<{ tools: Array<{ name: string }> }>('tools/list', { serverId: 'srv-1' });

    expect(result.tools[0]?.name).toBe('echo');
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('http://gateway.test/mcp/v1');
    const body = JSON.parse(String(call[1].body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/list',
      params: { serverId: 'srv-1' },
    });
    expect(typeof body.id).toBe('string');
  });

  it('maps HTTP errors onto ApiError with status and code', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ error: { code: 401, message: 'Unauthorized', data: { reason: 'KEY_REVOKED' } } }, 401),
    );
    const client = new ApiClient('http://gateway.test');

    const caught = await client.getMetrics().then(
      () => null,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({ status: 401, code: 401, message: 'Unauthorized' });
  });

  it('parseApiError unwraps the gateway error envelope and falls back for opaque bodies', () => {
    const wrapped = parseApiError(500, { error: { code: -32000, message: 'boom', data: { retry: false } } });
    expect(wrapped).toBeInstanceOf(ApiError);
    expect(wrapped).toMatchObject({ status: 500, code: -32000, message: 'boom', data: { retry: false } });

    const fallback = parseApiError(502, 'bad gateway');
    expect(fallback.status).toBe(502);
    expect(fallback.code).toBe(502);
    expect(fallback.message).toBe('HTTP 502');
  });

  it('uses the documented admin paths for key and server mutations', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ key: { id: 'key_1' } }));
    const client = new ApiClient('http://gateway.test');

    await client.revokeKey('key_1');
    await client.startServer('srv-1');
    await client.deleteServer('srv-1');

    const paths = fetchMock.mock.calls.map((call) => (call as [string])[0]);
    expect(paths).toEqual([
      'http://gateway.test/mcp/v1/admin/keys/key_1/revoke',
      'http://gateway.test/mcp/v1/admin/servers/srv-1/start',
      'http://gateway.test/mcp/v1/admin/servers/srv-1',
    ]);
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].method).toBe('POST');
    expect((fetchMock.mock.calls[2] as [string, RequestInit])[1].method).toBe('DELETE');
  });
});

describe('ApiClient v0.2 catalog, discovery, policy & Vault Warden', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const catalogSource = {
    id: 'cat_ab12',
    label: 'Internal MCP catalog',
    kind: 'dsh-umbrella',
    repoUrl: 'https://github.com/example/private-mcp-catalog',
    ref: 'main',
    subpath: null,
    tokenSecretName: 'CATALOG_cat_ab12_TOKEN',
    createdAt: '2026-10-29T17:00:00.000Z',
    updatedAt: '2026-10-29T17:00:00.000Z',
  };

  const server = {
    id: 'srv_brain',
    name: 'brain',
    runtime: 'node',
    transport: 'stdio',
    status: 'running',
    command: 'node',
    args: ['brain-mcp.js'],
    url: null,
    env: {},
    manifest: null,
    highPrivilegeTools: [],
    delegationSupported: false,
    sourceUrl: null,
    workDir: null,
    lastError: null,
    pid: 12,
    createdAt: '2026-10-29T17:00:00.000Z',
    updatedAt: '2026-10-29T17:05:00.000Z',
  };

  const testResult = {
    ok: true,
    toolCount: 2,
    tools: ['brain_whoami', 'brain_search'],
    latencyMs: 42.1,
    error: null,
  };

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function lastCall(): [string, RequestInit] {
    return fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
  }

  it('calls the documented catalog source and install endpoints with auth and bodies', async () => {
    const client = new ApiClient('http://gateway.test');

    fetchMock.mockResolvedValueOnce(fakeResponse({ sources: [catalogSource] }));
    expect(await client.listCatalogSources()).toHaveLength(1);
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/catalog/sources');

    fetchMock.mockResolvedValueOnce(fakeResponse({ source: catalogSource }, 201));
    await client.addCatalogSource({
      label: 'Internal MCP catalog',
      kind: 'dsh-umbrella',
      repoUrl: 'https://github.com/example/private-mcp-catalog',
      ref: 'main',
      subpath: null,
      token: 'ghp_secret',
    });
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/catalog/sources');
    expect(lastCall()[1].method).toBe('POST');
    expect(JSON.parse(String(lastCall()[1].body))).toMatchObject({
      label: 'Internal MCP catalog',
      kind: 'dsh-umbrella',
      token: 'ghp_secret',
    });
    expect(lastCall()[1].credentials).toBe('include');

    fetchMock.mockResolvedValueOnce(fakeResponse({ deleted: true }));
    expect(await client.deleteCatalogSource('cat_ab12')).toBe(true);
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/catalog/sources/cat_ab12');
    expect(lastCall()[1].method).toBe('DELETE');

    fetchMock.mockResolvedValueOnce(fakeResponse({ source: catalogSource, entries: [] }));
    await client.listCatalogEntries('cat_ab12', true);
    expect(lastCall()[0]).toBe(
      'http://gateway.test/mcp/v1/admin/catalog/sources/cat_ab12/entries?refresh=1',
    );

    fetchMock.mockResolvedValueOnce(
      fakeResponse({ server, test: testResult, buildLogTail: ['build ok'] }, 201),
    );
    const installed = await client.installCatalogEntry({
      sourceId: 'cat_ab12',
      entryId: 'brain-mcp',
      name: 'brain',
      env: { BRAIN_URL: 'http://brain.internal' },
      start: true,
      test: true,
    });
    expect(installed.test?.toolCount).toBe(2);
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/catalog/install');
    expect(lastCall()[1].method).toBe('POST');
    expect(JSON.parse(String(lastCall()[1].body))).toMatchObject({
      sourceId: 'cat_ab12',
      entryId: 'brain-mcp',
      env: { BRAIN_URL: 'http://brain.internal' },
      start: true,
      test: true,
    });

    fetchMock.mockResolvedValueOnce(fakeResponse({ server, test: null, buildLogTail: [] }, 201));
    await client.importCatalogUrl({ url: 'https://github.com/example/mcp-server', start: false });
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/catalog/import-url');
    expect(JSON.parse(String(lastCall()[1].body))).toMatchObject({
      url: 'https://github.com/example/mcp-server',
      start: false,
    });
  });

  it('scans local harnesses and imports discovered servers', async () => {
    const client = new ApiClient('http://gateway.test');
    const sourceInfo = {
      id: 'claude',
      label: 'Claude Code',
      configPath: '/home/example/.claude.json',
      exists: true,
      serverCount: 2,
    };

    fetchMock.mockResolvedValueOnce(fakeResponse({ sources: [sourceInfo] }));
    expect(await client.listDiscoverySources()).toEqual([sourceInfo]);
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/discovery/sources');

    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        sources: [sourceInfo],
        entries: [
          {
            id: 'claude:brain',
            harness: 'claude',
            name: 'brain',
            transport: 'stdio',
            command: 'node',
            args: ['/opt/brain-mcp.js'],
            url: null,
            envKeys: ['BRAIN_API_KEY'],
            envFile: null,
            headerKeys: [],
            enabled: true,
          },
        ],
        errors: [{ harness: 'opencode', error: 'config not found' }],
      }),
    );
    const scan = await client.scanDiscovery(['claude']);
    expect(scan.entries[0]?.name).toBe('brain');
    expect(scan.errors[0]?.harness).toBe('opencode');
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/discovery/scan');
    expect(lastCall()[1].method).toBe('POST');
    expect(JSON.parse(String(lastCall()[1].body))).toEqual({ harnessIds: ['claude'] });

    fetchMock.mockResolvedValueOnce(fakeResponse({ server }, 201));
    const imported = await client.importDiscoveryEntry({
      harness: 'claude',
      name: 'brain',
      transport: 'stdio',
      command: 'node',
      args: ['/opt/brain-mcp.js'],
      env: { BRAIN_API_KEY: 'example-value' },
    });
    expect(imported.id).toBe('srv_brain');
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/discovery/import');
    expect(JSON.parse(String(lastCall()[1].body))).toMatchObject({
      harness: 'claude',
      name: 'brain',
      env: { BRAIN_API_KEY: 'example-value' },
    });
  });

  it('probes, patches policy and fetches the server tool list', async () => {
    const client = new ApiClient('http://gateway.test');

    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        serverId: 'srv_vw',
        approvalRequiredTools: ['vault_deliver_credential'],
        highPrivilegeTools: ['vault_deliver_credential'],
        tools: [
          {
            id: 'srv_vw:vault_deliver_credential',
            name: 'vault_deliver_credential',
            description: 'Deliver a credential as a file path',
            highPrivilege: true,
            approvalRequired: true,
          },
        ],
        total: 1,
      }),
    );
    const tools = await client.serverTools('srv_vw');
    expect(tools.approvalRequiredTools).toEqual(['vault_deliver_credential']);
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/servers/srv_vw/tools');

    fetchMock.mockResolvedValueOnce(fakeResponse(testResult));
    expect(await client.testServer('srv_vw')).toEqual(testResult);
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/servers/srv_vw/test');
    expect(lastCall()[1].method).toBe('POST');

    fetchMock.mockResolvedValueOnce(fakeResponse({ server }));
    await client.updateServerPolicy('srv_vw', {
      highPrivilegeTools: ['vault_deliver_credential'],
      approvalRequiredTools: ['vault_deliver_credential'],
      envFile: '~/.config/vaultwarden/mcp.env',
    });
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/servers/srv_vw/policy');
    expect(lastCall()[1].method).toBe('PATCH');
    expect(JSON.parse(String(lastCall()[1].body))).toEqual({
      highPrivilegeTools: ['vault_deliver_credential'],
      approvalRequiredTools: ['vault_deliver_credential'],
      envFile: '~/.config/vaultwarden/mcp.env',
    });
  });

  it('loads the Vault Warden overview, applies protection and resolves a ticket with its result', async () => {
    const client = new ApiClient('http://gateway.test');
    const ticket = {
      id: 'esc-1',
      ticketId: 'esc-20261029-ab12',
      keyId: 'key_agent',
      toolId: 'srv_vw:vault_deliver_credential',
      serverId: 'srv_vw',
      reason: 'APPROVAL_REQUIRED',
      requestPayload: null,
      status: 'pending',
      ticketType: 'tool_approval',
      toolArguments: { item: 'deploy-key' },
      createdAt: '2026-10-29T17:00:00.000Z',
      resolvedAt: null,
      resolvedBy: null,
      note: null,
    };

    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        installed: true,
        serverId: 'srv_vw',
        serverName: 'vaultwarden',
        status: 'running',
        tools: [
          {
            name: 'vault_deliver_credential',
            description: 'Deliver a credential',
            highPrivilege: true,
            approvalRequired: true,
          },
        ],
        defaults: {
          approvalTools: ['vault_deliver_credential'],
          highPrivilegeTools: ['vault_deliver_credential'],
        },
        pendingApprovals: [ticket],
        accessLog: [],
      }),
    );
    const overview = await client.getVaultWarden();
    expect(overview.installed).toBe(true);
    expect(overview.pendingApprovals).toHaveLength(1);
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/vaultwarden');

    fetchMock.mockResolvedValueOnce(fakeResponse({ server }));
    await client.protectVaultWarden('srv_vw');
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/vaultwarden/protect');
    expect(lastCall()[1].method).toBe('POST');
    expect(JSON.parse(String(lastCall()[1].body))).toEqual({ serverId: 'srv_vw' });

    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        escalation: { ...ticket, status: 'approved' },
        result: { content: [{ type: 'text', text: '/run/gateway/secrets/delivery-abc123' }], isError: false },
      }),
    );
    const resolved = await client.resolveEscalation('esc-20261029-ab12', 'approved');
    expect(resolved.escalation.status).toBe('approved');
    expect(resolved.result).toEqual({
      content: [{ type: 'text', text: '/run/gateway/secrets/delivery-abc123' }],
      isError: false,
    });
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/escalations/esc-20261029-ab12/resolve');
    expect(JSON.parse(String(lastCall()[1].body))).toEqual({ status: 'approved' });
  });

  it('normalises a sparse Vault Warden overview (not installed)', async () => {
    const client = new ApiClient('http://gateway.test');
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ installed: false, defaults: { approvalTools: ['vault_deliver_credential'] } }),
    );

    const overview = await client.getVaultWarden();
    expect(overview).toMatchObject({
      installed: false,
      defaults: { approvalTools: ['vault_deliver_credential'], highPrivilegeTools: [] },
      pendingApprovals: [],
      accessLog: [],
      tools: [],
    });
  });
});

describe('ApiClient master key regeneration', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const newMasterKey = {
    id: 'key_master_new',
    name: 'master (regenerated)',
    keyType: 'master',
    keyPrefix: 'mcp_master_ab12',
    serverGrants: [],
    delegationAllowed: true,
    escalationAllowed: true,
    expiresAt: null,
    revokedAt: null,
    createdAt: '2026-10-29T19:00:00.000Z',
    lastUsedAt: null,
  };

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to the master regenerate route using the session cookie', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ key: newMasterKey, plaintext: 'mcp_master_newplaintext', revokedCount: 1 }, 201),
    );
    const client = new ApiClient('http://gateway.test');

    const result = await client.regenerateMasterKey({ revokePrevious: false, name: 'rotated' });

    expect(result).toEqual({
      key: newMasterKey,
      plaintext: 'mcp_master_newplaintext',
      revokedCount: 1,
    });
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('http://gateway.test/mcp/v1/admin/keys/master/regenerate');
    expect(call[1].method).toBe('POST');
    expect(call[1].credentials).toBe('include');
    expect(JSON.parse(String(call[1].body))).toEqual({ revokePrevious: false, name: 'rotated' });
  });

  it('sends an empty object by default and maps API errors onto ApiError', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ key: newMasterKey, plaintext: 'mcp_master_default', revokedCount: 0 }, 201),
    );
    const client = new ApiClient('http://gateway.test');
    expect((await client.regenerateMasterKey()).plaintext).toBe('mcp_master_default');
    const firstCall = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(firstCall[1].body))).toEqual({});

    fetchMock.mockResolvedValueOnce(
      fakeResponse(
        { error: { code: 403, message: 'Access Denied: master key required', data: { reason: 'SCOPE_RESTRICTION' } } },
        403,
      ),
    );
    const caught = await client.regenerateMasterKey().then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({
      status: 403,
      code: 403,
      message: 'Access Denied: master key required',
      data: { reason: 'SCOPE_RESTRICTION' },
    });
  });
});

describe('ApiClient v0.4 update manager & encrypted config profiles', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const sourceInfo = {
    serverId: 'srv_brain',
    sourceKind: 'catalog',
    catalogSourceId: 'cat_1',
    catalogEntryId: 'brain-mcp',
    repoUrl: 'https://github.com/example/brain-mcp',
    requestedRef: 'v1.0.0',
    installedVersion: '1.0.0',
    installedCommit: 'a1b2c3d',
    latestVersion: '1.2.0',
    latestCommit: 'd4e5f6a',
    latestRef: 'v1.2.0',
    updateAvailable: true,
    checkedAt: '2026-10-29T19:00:00.000Z',
    checkError: null,
    changelogUrl: null,
  };

  const checkResult = {
    serverId: 'srv_brain',
    serverName: 'brain',
    status: 'update-available',
    updateAvailable: true,
    fromVersion: '1.0.0',
    toVersion: '1.2.0',
    fromCommit: 'a1b2c3d',
    toCommit: 'd4e5f6a',
    latestRef: 'v1.2.0',
    checkedAt: '2026-10-29T19:00:00.000Z',
    error: null,
  };

  const profile = {
    id: 'cfg_1',
    name: 'Internal services',
    description: null,
    entries: [
      { key: 'N8N_BASE_URL', source: 'encrypted', ref: null },
      { key: 'N8N_API_KEY', source: 'vault-ref', ref: 'N8N_API_KEY' },
    ],
    headers: [],
    createdAt: '2026-10-29T18:00:00.000Z',
    updatedAt: '2026-10-29T18:00:00.000Z',
    attachedServerIds: ['srv_n8n'],
  };

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function lastCall(): [string, RequestInit] {
    return fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
  }

  it('calls the update manager endpoints (list, check all, check one, update)', async () => {
    const client = new ApiClient('http://gateway.test');

    fetchMock.mockResolvedValueOnce(fakeResponse({ sources: [sourceInfo] }));
    expect(await client.listServerUpdates()).toEqual([sourceInfo]);
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/updates');

    fetchMock.mockResolvedValueOnce(fakeResponse({ results: [checkResult] }));
    expect(await client.checkUpdates(['srv_brain'])).toEqual([checkResult]);
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/updates/check');
    expect(lastCall()[1].method).toBe('POST');
    expect(JSON.parse(String(lastCall()[1].body))).toEqual({ serverIds: ['srv_brain'] });

    fetchMock.mockResolvedValueOnce(fakeResponse({ results: [] }));
    await client.checkUpdates();
    expect(JSON.parse(String(lastCall()[1].body))).toEqual({});

    fetchMock.mockResolvedValueOnce(fakeResponse({ update: checkResult }));
    expect(await client.checkServerUpdate('srv_brain')).toEqual(checkResult);
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/updates/servers/srv_brain/check');
    expect(lastCall()[1].method).toBe('POST');

    const updateResult = {
      server: { id: 'srv_brain', name: 'brain' },
      before: { version: '1.0.0', commit: 'a1b2c3d' },
      after: { version: '1.2.0', commit: 'd4e5f6a' },
      test: { ok: true, toolCount: 2, tools: ['brain_search'], latencyMs: 3.1, error: null },
      changed: true,
    };
    fetchMock.mockResolvedValueOnce(fakeResponse({ result: updateResult }));
    const updated = await client.updateServer('srv_brain', { restart: false, test: true });
    expect(updated.changed).toBe(true);
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/updates/servers/srv_brain/update');
    expect(lastCall()[1].method).toBe('POST');
    expect(JSON.parse(String(lastCall()[1].body))).toEqual({ restart: false, test: true });

    const headers = lastCall()[1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(lastCall()[1].credentials).toBe('include');
  });

  it('calls the encrypted config-profile endpoints', async () => {
    const client = new ApiClient('http://gateway.test');

    fetchMock.mockResolvedValueOnce(fakeResponse({ profiles: [profile] }));
    expect(await client.listConfigProfiles()).toEqual([profile]);
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/config-profiles');

    const input = {
      name: 'Internal services',
      entries: [
        { key: 'N8N_BASE_URL', value: 'http://10.0.0.5:5678' },
        { key: 'N8N_API_KEY', secretRef: 'N8N_API_KEY' },
      ],
      headers: [],
    };
    fetchMock.mockResolvedValueOnce(fakeResponse({ profile }, 201));
    await client.createConfigProfile(input);
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/config-profiles');
    expect(lastCall()[1].method).toBe('POST');
    expect(JSON.parse(String(lastCall()[1].body))).toEqual(input);

    fetchMock.mockResolvedValueOnce(fakeResponse({ profile }));
    await client.getConfigProfile('cfg_1');
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/config-profiles/cfg_1');

    fetchMock.mockResolvedValueOnce(fakeResponse({ profile: { ...profile, name: 'Renamed' } }));
    await client.updateConfigProfile('cfg_1', { ...input, name: 'Renamed' });
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/config-profiles/cfg_1');
    expect(lastCall()[1].method).toBe('PUT');
    expect(JSON.parse(String(lastCall()[1].body))).toMatchObject({ name: 'Renamed' });

    fetchMock.mockResolvedValueOnce(fakeResponse({ deleted: true }));
    expect(await client.deleteConfigProfile('cfg_1')).toBe(true);
    expect(lastCall()[1].method).toBe('DELETE');

    const applyResults = [
      {
        serverId: 'srv_n8n',
        serverName: 'n8n',
        applied: true,
        restarted: true,
        test: { ok: true, toolCount: 5, tools: ['n8n_list'], latencyMs: 2.4, error: null },
        error: null,
      },
    ];
    fetchMock.mockResolvedValueOnce(fakeResponse({ results: applyResults }));
    expect(
      await client.applyConfigProfile('cfg_1', { serverIds: ['srv_n8n'], restart: true, test: true }),
    ).toEqual(applyResults);
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/config-profiles/cfg_1/apply');
    expect(lastCall()[1].method).toBe('POST');
    expect(JSON.parse(String(lastCall()[1].body))).toEqual({
      serverIds: ['srv_n8n'],
      restart: true,
      test: true,
    });

    fetchMock.mockResolvedValueOnce(fakeResponse({ detached: true }));
    expect(await client.detachConfigProfile('cfg_1', 'srv_n8n')).toBe(true);
    expect(lastCall()[0]).toBe(
      'http://gateway.test/mcp/v1/admin/config-profiles/cfg_1/servers/srv_n8n',
    );
    expect(lastCall()[1].method).toBe('DELETE');

    fetchMock.mockResolvedValueOnce(fakeResponse({ profile: { ...profile, id: 'cfg_migrated' } }, 201));
    const migrated = await client.migrateEnvFile('srv_n8n');
    expect(migrated.id).toBe('cfg_migrated');
    expect(lastCall()[0]).toBe('http://gateway.test/mcp/v1/admin/config-profiles/migrate-env-file');
    expect(lastCall()[1].method).toBe('POST');
    expect(JSON.parse(String(lastCall()[1].body))).toEqual({ serverId: 'srv_n8n' });
  });
});
