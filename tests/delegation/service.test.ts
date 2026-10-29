import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import type { HttpObserverProxy, ObserverCallResult } from '../../src/delegation/proxy.js';
import { DefaultDelegationService, type DelegationServiceDeps } from '../../src/delegation/service.js';
import type { DelegationResult, DelegationTarget } from '../../src/core/types.js';

import {
  catchGatewayError,
  catchSyncGatewayError,
  makeDb,
  makeKey,
  makeTarget,
  makeVault,
  recordingLogger,
  silentConfig,
  startHarness,
  type ObserverHarness,
  type ObserverHarnessOptions,
} from './support.js';

let db: DatabaseSync;
let harnesses: ObserverHarness[] = [];

async function harness(options: ObserverHarnessOptions = {}): Promise<ObserverHarness> {
  const started = await startHarness(options);
  harnesses.push(started);
  return started;
}

function makeService(overrides: Partial<DelegationServiceDeps> = {}): DefaultDelegationService {
  return new DefaultDelegationService({ db, config: silentConfig(), ...overrides });
}

beforeEach(() => {
  db = makeDb();
});

afterEach(async () => {
  await Promise.all(harnesses.map((h) => h.close()));
  harnesses = [];
  db.close();
});

describe('DefaultDelegationService — access control & depth', () => {
  it('requires the delegation claim before doing anything else', async () => {
    const svc = makeService();

    const error = await catchGatewayError(
      svc.delegate(
        makeKey({ delegationAllowed: false }),
        { targetId: 'observer-bot', payload: { task: 'x' } },
        { depth: 0, parentRequestId: 'req_parent_1' },
      ),
    );

    expect(error.code).toBe(ErrorCodes.ACCESS_DENIED);
    expect(error.code).toBe(-32001);
    expect(error.message).toContain('lacks delegation claim');
    expect(error.data).toMatchObject({ status: 'FORBIDDEN', reason: 'DELEGATION_NOT_PERMITTED' });
  });

  it('enforces the depth cap: depth 3 + max 3 throws -32003, depth 2 is allowed', async () => {
    const h = await harness();
    const svc = makeService({
      config: silentConfig({ delegationMaxDepth: 3 }),
      targets: [makeTarget(h.url)],
    });

    const error = await catchGatewayError(
      svc.delegate(
        makeKey(),
        { targetId: 'observer-bot', payload: { task: 'x' } },
        { depth: 3, parentRequestId: 'req_parent_1' },
      ),
    );

    expect(error.code).toBe(ErrorCodes.DELEGATION_DEPTH_EXCEEDED);
    expect(error.code).toBe(-32003);
    expect(error.message).toBe('Maximum delegation depth of 3 exceeded.');
    expect(error.data).toMatchObject({ status: 'FORBIDDEN', reason: 'DELEGATION_DEPTH_EXCEEDED' });
    expect(h.requests).toHaveLength(0);

    const result = await svc.delegate(
      makeKey(),
      { targetId: 'observer-bot', payload: { task: 'one level below cap' } },
      { depth: 2, parentRequestId: 'req_parent_1' },
    );

    expect(result.depth).toBe(3);
    expect(result.status).toBe('approved');
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.headers['x-mcp-delegation-depth']).toBe('3');
  });

  it('rejects unknown targets with INVALID_PARAMS and the available ids (no URLs)', async () => {
    const h = await harness();
    const svc = makeService({ targets: [makeTarget(h.url)] });

    const error = await catchGatewayError(
      svc.delegate(
        makeKey(),
        { targetId: 'missing-bot', payload: { task: 'x' } },
        { depth: 0, parentRequestId: 'req_parent_1' },
      ),
    );

    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(error.message).toContain('missing-bot');
    expect(error.message).toContain('observer-bot');
    expect(error.message).not.toContain(h.url);
    expect(error.data?.details).toEqual({ available: ['observer-bot'] });
    expect(h.requests).toHaveLength(0);
  });
});

describe('DefaultDelegationService — targets', () => {
  it('validates new targets and defaults timeoutMs to 30000', () => {
    const svc = makeService();

    const added = svc.addTarget({
      id: 'observer-bot',
      name: 'Observer Bot',
      url: 'http://127.0.0.1:4444/observe',
      protocol: 'http',
      timeoutMs: 1_500,
    });

    expect(added).toMatchObject({
      id: 'observer-bot',
      name: 'Observer Bot',
      url: 'http://127.0.0.1:4444/observe',
      protocol: 'http',
      timeoutMs: 1_500,
    });
    expect(svc.listTargets()).toHaveLength(1);

    const badId = catchSyncGatewayError(() =>
      svc.addTarget({ id: '   ', name: 'x', url: 'http://127.0.0.1:1', protocol: 'http', timeoutMs: 1_000 }),
    );
    expect(badId.code).toBe(ErrorCodes.INVALID_PARAMS);

    const badUrl = catchSyncGatewayError(() =>
      svc.addTarget({ id: 'ftp-bot', name: 'x', url: 'ftp://example.test/observe', protocol: 'http', timeoutMs: 1_000 }),
    );
    expect(badUrl.code).toBe(ErrorCodes.INVALID_PARAMS);

    const badTimeout = catchSyncGatewayError(() =>
      svc.addTarget({ id: 'slow-bot', name: 'x', url: 'http://127.0.0.1:1', protocol: 'http', timeoutMs: 0 }),
    );
    expect(badTimeout.code).toBe(ErrorCodes.INVALID_PARAMS);

    const duplicate = catchSyncGatewayError(() =>
      svc.addTarget({ id: 'observer-bot', name: 'dup', url: 'http://127.0.0.1:9999', protocol: 'http', timeoutMs: 1_000 }),
    );
    expect(duplicate.code).toBe(ErrorCodes.INVALID_PARAMS);

    expect(svc.listTargets()).toHaveLength(1);

    const defaulted = svc.addTarget({
      id: 'no-timeout',
      name: '',
      url: 'https://observer.example.test/hook',
      protocol: 'http',
    } as unknown as DelegationTarget);
    expect(defaulted.timeoutMs).toBe(30_000);
    expect(defaulted.name).toBe('no-timeout');
    expect(defaulted.authSecretName).toBeNull();
  });

  it('normalises targets supplied through the constructor', () => {
    const svc = makeService({
      targets: [{ id: 'observer-bot', url: 'https://observer.example.test/hook' } as unknown as DelegationTarget],
    });

    const [target] = svc.listTargets();
    expect(target).toMatchObject({
      id: 'observer-bot',
      name: 'observer-bot',
      protocol: 'http',
      authSecretName: null,
      timeoutMs: 30_000,
    });
  });
});

describe('DefaultDelegationService — delegation flow & traces', () => {
  it('delegates the isolated payload and persists a parent-child trace row', async () => {
    const h = await harness();
    const logger = recordingLogger();
    const svc = makeService({ targets: [makeTarget(h.url)], logger });

    const result = await svc.delegate(
      makeKey(),
      { targetId: 'observer-bot', payload: { task: 'review this PR' }, mode: 'observe_and_verify' },
      { depth: 0, parentRequestId: 'req_parent_42' },
    );

    expect(result).toMatchObject({
      targetId: 'observer-bot',
      status: 'approved',
      verdict: 'payload safe',
      approvalToken: 'apr_test_token',
      output: { ok: true },
      depth: 1,
    });
    expect(typeof result.latencyMs).toBe('number');
    expect(result.traceId).toMatch(/^tr_/);

    // Only the isolated envelope crossed the network boundary.
    const request = h.requests[0]!;
    expect(request.body).toMatchObject({
      mode: 'observe_and_verify',
      payload: { task: 'review this PR' },
      depth: 1,
      traceId: result.traceId,
      parentRequestId: 'req_parent_42',
    });
    expect(request.body).not.toHaveProperty('key');
    expect(JSON.stringify(request.body)).not.toContain('key_test_agent');

    // Trace lineage is persisted.
    const traces = svc.listTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      traceId: result.traceId,
      parentRequestId: 'req_parent_42',
      childRequestId: null,
      target: 'observer-bot',
      depth: 1,
      status: 'approved',
      verdict: 'payload safe',
    });
    expect(traces[0]!.id).toMatch(/^trc_/);
    expect(typeof traces[0]!.latencyMs).toBe('number');
    expect(Number.isNaN(Date.parse(traces[0]!.createdAt))).toBe(false);

    const row = db
      .prepare('SELECT COUNT(*) AS n FROM delegation_traces WHERE parent_request_id = ?')
      .get('req_parent_42') as unknown as { n: number } | undefined;
    expect(Number(row?.n)).toBe(1);
  });

  it('returns traces newest-first and honours the limit', async () => {
    const h = await harness();
    const svc = makeService({ targets: [makeTarget(h.url)] });
    const results: DelegationResult[] = [];

    for (const n of [1, 2, 3]) {
      results.push(
        await svc.delegate(
          makeKey(),
          { targetId: 'observer-bot', payload: { n } },
          { depth: 0, parentRequestId: 'req_list' },
        ),
      );
    }

    const newestFirst = [results[2]!.traceId, results[1]!.traceId, results[0]!.traceId];
    expect(svc.listTraces().map((trace) => trace.traceId)).toEqual(newestFirst);

    const limited = svc.listTraces(2);
    expect(limited).toHaveLength(2);
    expect(limited.map((trace) => trace.traceId)).toEqual(newestFirst.slice(0, 2));

    // Non-positive limits fall back to the default window rather than returning nothing.
    expect(svc.listTraces(0)).toHaveLength(3);
  });

  it('persists an error trace when the observer call fails', async () => {
    const call = vi.fn(async () => {
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, 'observer down');
    });
    const proxy = { call } as unknown as HttpObserverProxy;
    const svc = makeService({ targets: [makeTarget('http://127.0.0.1:9/observer')], proxy });

    const error = await catchGatewayError(
      svc.delegate(makeKey(), { targetId: 'observer-bot', payload: {} }, { depth: 0, parentRequestId: 'req_err' }),
    );

    expect(error.code).toBe(ErrorCodes.UPSTREAM_ERROR);
    const traces = svc.listTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      status: 'error',
      verdict: null,
      parentRequestId: 'req_err',
      target: 'observer-bot',
      depth: 1,
    });
  });

  it('maps observer statuses (approved / denied / error) into results and traces', async () => {
    const call = vi.fn(
      async (): Promise<ObserverCallResult> => ({
        status: 'denied',
        verdict: 'unsafe',
        approvalToken: null,
        output: { reason: 'pii' },
      }),
    );
    const proxy = { call } as unknown as HttpObserverProxy;
    const svc = makeService({ targets: [makeTarget('http://127.0.0.1:9/observer')], proxy });
    const key = makeKey();
    const context = { depth: 0, parentRequestId: 'req_map' };

    const denied = await svc.delegate(key, { targetId: 'observer-bot', payload: { secret: 'ssn' } }, context);
    expect(denied).toEqual({
      targetId: 'observer-bot',
      status: 'denied',
      verdict: 'unsafe',
      approvalToken: null,
      output: { reason: 'pii' },
      latencyMs: expect.any(Number),
      depth: 1,
      traceId: expect.any(String),
    });

    call.mockResolvedValueOnce({
      status: 'approved',
      verdict: 'ok',
      approvalToken: 'apr_map',
      output: { ok: true },
    });
    const approved = await svc.delegate(key, { targetId: 'observer-bot', payload: {} }, context);
    expect(approved.status).toBe('approved');
    expect(approved.approvalToken).toBe('apr_map');

    call.mockResolvedValueOnce({ status: 'error', verdict: 'observer exploded', approvalToken: null, output: null });
    const errored = await svc.delegate(key, { targetId: 'observer-bot', payload: {} }, context);
    expect(errored.status).toBe('error');

    expect(svc.listTraces().map((trace) => trace.status)).toEqual(['error', 'approved', 'denied']);
  });
});

describe('DefaultDelegationService — vault-backed observer auth', () => {
  it('resolves the bearer token from the vault and never persists or logs it', async () => {
    const h = await harness({ requiresAuth: true });
    const logger = recordingLogger();
    const svc = makeService({
      targets: [makeTarget(h.url, { authSecretName: 'observer-token' })],
      vault: makeVault({ 'observer-token': 'secret-token' }),
      logger,
    });

    const result = await svc.delegate(
      makeKey(),
      { targetId: 'observer-bot', payload: { task: 'x' } },
      { depth: 0, parentRequestId: 'req_vault' },
    );

    expect(result.status).toBe('approved');
    expect(h.requests[0]!.headers.authorization).toBe('Bearer secret-token');
    expect(JSON.stringify(svc.listTraces())).not.toContain('secret-token');
    expect(JSON.stringify(logger.records)).not.toContain('secret-token');
  });

  it('rejects a target whose vault secret is missing', async () => {
    const h = await harness({ requiresAuth: true });
    const svc = makeService({
      targets: [makeTarget(h.url, { authSecretName: 'missing-secret' })],
      vault: makeVault({}),
    });

    const error = await catchGatewayError(
      svc.delegate(makeKey(), { targetId: 'observer-bot', payload: {} }, { depth: 0, parentRequestId: 'req_vault' }),
    );

    expect(error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(error.message).toMatch(/missing vault secret/);
    expect(error.message).toContain('missing-secret');
    expect(h.requests).toHaveLength(0);
  });

  it('sends no Authorization header when the vault is disabled', async () => {
    const h = await harness({ behavior: 'capture' });
    const svc = makeService({
      targets: [makeTarget(h.url, { authSecretName: 'observer-token' })],
      vault: makeVault({ 'observer-token': 'secret-token' }, false),
    });

    const result = await svc.delegate(
      makeKey(),
      { targetId: 'observer-bot', payload: {} },
      { depth: 0, parentRequestId: 'req_vault' },
    );

    expect(result.status).toBe('approved');
    expect(h.requests[0]!.headers.authorization).toBeUndefined();
  });
});
