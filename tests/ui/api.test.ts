// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_KEY_STORAGE_KEY,
  ApiClient,
  ApiError,
  parseApiError,
} from '../../src/ui/lib/api.js';

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

  it('stores the operator key in localStorage and sends a bearer header', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ keys: [] }));
    const client = new ApiClient('http://gateway.test');

    expect(client.getApiKey()).toBeNull();
    client.setApiKey('  mcp_master_abc  ');
    expect(localStorage.getItem(API_KEY_STORAGE_KEY)).toBe('mcp_master_abc');
    expect(client.getApiKey()).toBe('mcp_master_abc');

    await client.listKeys();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('http://gateway.test/mcp/v1/admin/keys');
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer mcp_master_abc');
  });

  it('omits the authorization header when no key is configured and clears stored keys', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ status: 'ok', version: '0.1.0', uptimeMs: 10 }));
    const client = new ApiClient('');
    client.setApiKey('mcp_ag_temporary');
    client.setApiKey(null);
    expect(client.getApiKey()).toBeNull();

    await client.getHealth();

    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('/mcp/v1/health');
    expect((call[1].headers as Record<string, string>).Authorization).toBeUndefined();
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
    client.setApiKey('mcp_sup_test');

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
    client.setApiKey('mcp_master_v2');

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
    const headers = lastCall()[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer mcp_master_v2');

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
