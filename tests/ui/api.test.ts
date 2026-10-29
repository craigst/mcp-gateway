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
