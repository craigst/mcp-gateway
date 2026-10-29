import { afterEach, describe, expect, it } from 'vitest';

import { ErrorCodes } from '../../src/core/errors.js';
import { createLogger } from '../../src/core/logger.js';
import { HttpObserverProxy } from '../../src/delegation/proxy.js';

import {
  catchGatewayError,
  makeTarget,
  recordingLogger,
  startHarness,
  type ObserverHarness,
  type ObserverHarnessOptions,
} from './support.js';

const envelope = {
  mode: 'delegate',
  payload: { task: 'summarise', text: 'hello world' },
  depth: 2,
  traceId: 'tr_test_trace',
  parentRequestId: 'req_parent_1',
};

let harnesses: ObserverHarness[] = [];

async function harness(options: ObserverHarnessOptions = {}): Promise<ObserverHarness> {
  const started = await startHarness(options);
  harnesses.push(started);
  return started;
}

function proxy(options: { logger?: ReturnType<typeof recordingLogger> } = {}): HttpObserverProxy {
  return new HttpObserverProxy({ logger: createLogger('delegation.proxy', 'silent'), ...options });
}

afterEach(async () => {
  await Promise.all(harnesses.map((h) => h.close()));
  harnesses = [];
});

describe('HttpObserverProxy', () => {
  it('maps an approved observer verdict, token and output', async () => {
    const h = await harness({ behavior: 'approve', approvalToken: 'apr_custom_123' });

    const result = await proxy().call(makeTarget(h.url), envelope);

    expect(result).toEqual({
      status: 'approved',
      verdict: 'payload safe',
      approvalToken: 'apr_custom_123',
      output: { ok: true },
    });
  });

  it('maps a denied observer verdict', async () => {
    const h = await harness({ behavior: 'deny' });

    const result = await proxy().call(makeTarget(h.url), envelope);

    expect(result.status).toBe('denied');
    expect(result.verdict).toBe('payload rejected by observer');
    expect(result.approvalToken).toBeNull();
    expect(result.output).toBeNull();
  });

  it('maps an observer-reported error status without throwing', async () => {
    const h = await harness({ behavior: 'error' });

    const result = await proxy().call(makeTarget(h.url), envelope);

    expect(result.status).toBe('error');
    expect(result.verdict).toBe('observer failure');
    expect(result.approvalToken).toBeNull();
  });

  it('throws UPSTREAM_ERROR on a 5xx response, including the status code', async () => {
    const h = await harness({ behavior: 'error', httpStatus: 500 });

    const error = await catchGatewayError(proxy().call(makeTarget(h.url), envelope));

    expect(error.code).toBe(ErrorCodes.UPSTREAM_ERROR);
    expect(error.message).toContain('HTTP 500');
    expect(error.data?.details).toEqual({ statusCode: 500 });
    // Anti-probing: target URLs never leak into error messages.
    expect(error.message).not.toContain(h.url);
  });

  it('throws UPSTREAM_ERROR on a 401 from an auth-required observer', async () => {
    const h = await harness({ requiresAuth: true });

    const error = await catchGatewayError(proxy().call(makeTarget(h.url), envelope));

    expect(error.code).toBe(ErrorCodes.UPSTREAM_ERROR);
    expect(error.message).toContain('HTTP 401');
  });

  it('times out slow targets and reports a timeout error', async () => {
    const h = await harness({ behavior: 'slow', delayMs: 1_000 });

    const error = await catchGatewayError(
      proxy().call(makeTarget(h.url, { timeoutMs: 100 }), envelope),
    );

    expect(error.code).toBe(ErrorCodes.UPSTREAM_ERROR);
    expect(error.message).toMatch(/timed out after 100ms/i);
    expect(error.data?.details).toEqual({ reason: 'TIMEOUT' });
  });

  it('throws UPSTREAM_ERROR when the observer returns invalid JSON', async () => {
    const h = await harness({ behavior: 'badjson' });

    const error = await catchGatewayError(proxy().call(makeTarget(h.url), envelope));

    expect(error.code).toBe(ErrorCodes.UPSTREAM_ERROR);
    expect(error.message).toMatch(/invalid JSON/i);
  });

  it('throws UPSTREAM_ERROR when the response has no status', async () => {
    const h = await harness({ responseBody: { verdict: 'no status here' } });

    const error = await catchGatewayError(proxy().call(makeTarget(h.url), envelope));

    expect(error.code).toBe(ErrorCodes.UPSTREAM_ERROR);
    expect(error.message).toMatch(/valid status/i);
  });

  it('throws UPSTREAM_ERROR when the response status is not an observer status', async () => {
    const h = await harness({ responseBody: { status: 'maybe', verdict: 'hmm' } });

    const error = await catchGatewayError(proxy().call(makeTarget(h.url), envelope));

    expect(error.code).toBe(ErrorCodes.UPSTREAM_ERROR);
    expect(error.message).toMatch(/valid status/i);
  });

  it('throws UPSTREAM_ERROR when the observer is unreachable', async () => {
    const target = makeTarget('http://127.0.0.1:1', { timeoutMs: 500 });

    const error = await catchGatewayError(proxy().call(target, envelope));

    expect(error.code).toBe(ErrorCodes.UPSTREAM_ERROR);
    expect(error.data?.details).toEqual({ reason: 'NETWORK_ERROR' });
  });

  it('propagates depth, trace id, content type and the isolated envelope', async () => {
    const h = await harness({ behavior: 'capture' });

    await proxy().call(makeTarget(h.url), envelope);

    const request = h.requests[0]!;
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['x-mcp-delegation-depth']).toBe('2');
    expect(request.headers['x-mcp-trace-id']).toBe('tr_test_trace');
    expect(request.headers.authorization).toBeUndefined();
    expect(request.body).toEqual(envelope);
    // Payload isolation: no key material or conversation context crosses the boundary.
    expect(request.body).not.toHaveProperty('key');
    expect(JSON.stringify(request.body)).not.toContain('key_test_agent');
  });

  it('forwards a vault-resolved bearer token in the Authorization header', async () => {
    const h = await harness({ requiresAuth: true });

    const result = await proxy().call(makeTarget(h.url), envelope, 'secret-token');

    expect(result.status).toBe('approved');
    expect(h.requests[0]!.headers.authorization).toBe('Bearer secret-token');
  });

  it('never leaks the bearer token in thrown errors or logs', async () => {
    const h = await harness({ behavior: 'error', httpStatus: 500 });
    const logger = recordingLogger();
    const token = 'super-secret-bearer-token-value';

    const error = await catchGatewayError(proxy({ logger }).call(makeTarget(h.url), envelope, token));

    expect(error.code).toBe(ErrorCodes.UPSTREAM_ERROR);
    expect(error.message).not.toContain(token);
    expect(JSON.stringify(error.data ?? {})).not.toContain(token);
    expect(JSON.stringify(logger.records)).not.toContain(token);
    // ...but it was definitely sent to the observer.
    expect(h.requests[0]!.headers.authorization).toBe(`Bearer ${token}`);
  });
});
