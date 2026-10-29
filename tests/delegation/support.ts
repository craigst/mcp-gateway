/**
 * Shared helpers for delegation tests.
 *
 * The observer harness itself is plain ESM (`tests/fixtures/observer-harness.mjs`);
 * we load it through a static import with a local type shim so tests stay typed
 * while the fixture remains dependency-free JavaScript.
 */
import type { DatabaseSync } from 'node:sqlite';

import { loadConfig, type GatewayConfig } from '../../src/core/config.js';
import { openDatabase } from '../../src/core/db.js';
import { GatewayError } from '../../src/core/errors.js';
import { nowIso } from '../../src/core/ids.js';
import type { Logger } from '../../src/core/logger.js';
import type { VaultService } from '../../src/core/ports.js';
import type { AuthenticatedKey, DelegationTarget } from '../../src/core/types.js';

// @ts-expect-error -- plain-JavaScript test fixture without type declarations (intentional).
import { startObserverHarness as startObserverHarnessRaw } from '../fixtures/observer-harness.mjs';

export type ObserverBehavior = 'approve' | 'deny' | 'error' | 'slow' | 'badjson' | 'capture';

export interface ObserverHarnessOptions {
  behavior?: ObserverBehavior;
  delayMs?: number;
  requiresAuth?: boolean;
  approvalToken?: string;
  httpStatus?: number;
  responseBody?: unknown;
}

export interface ObserverHarnessRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface ObserverHarness {
  url: string;
  port: number;
  requests: ObserverHarnessRequest[];
  close(): Promise<void>;
}

const startObserverHarnessImpl = startObserverHarnessRaw as unknown as (
  options?: ObserverHarnessOptions,
) => Promise<ObserverHarness>;

/** Start the fake observer harness (remember to close it in `afterEach`). */
export function startHarness(options: ObserverHarnessOptions = {}): Promise<ObserverHarness> {
  return startObserverHarnessImpl(options);
}

export function makeDb(): DatabaseSync {
  return openDatabase(':memory:');
}

export function silentConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { ...loadConfig({ MCP_LOG_LEVEL: 'silent' }), logLevel: 'silent', ...overrides };
}

export function makeKey(overrides: Partial<AuthenticatedKey> = {}): AuthenticatedKey {
  return {
    id: 'key_test_agent',
    name: 'test-agent',
    keyType: 'agent',
    keyPrefix: 'mcp_ag_test',
    serverGrants: [],
    delegationAllowed: true,
    escalationAllowed: false,
    expiresAt: null,
    revokedAt: null,
    pausedAt: null,
    createdAt: '2026-10-29T00:00:00.000Z',
    lastUsedAt: null,
    metadata: {},
    ...overrides,
  };
}

export function makeTarget(url: string, overrides: Partial<DelegationTarget> = {}): DelegationTarget {
  return {
    id: 'observer-bot',
    name: 'observer-bot',
    url,
    protocol: 'http',
    authSecretName: null,
    timeoutMs: 2_000,
    ...overrides,
  };
}

export interface LoggedRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context: Record<string, unknown> | undefined;
}

export interface RecordingLogger extends Logger {
  records: LoggedRecord[];
}

/** Logger that captures records so tests can assert secrets never reach logs. */
export function recordingLogger(): RecordingLogger {
  const records: LoggedRecord[] = [];
  const logger: RecordingLogger = {
    module: 'test.delegation',
    records,
    debug: (message, context) => {
      records.push({ level: 'debug', message, context });
    },
    info: (message, context) => {
      records.push({ level: 'info', message, context });
    },
    warn: (message, context) => {
      records.push({ level: 'warn', message, context });
    },
    error: (message, context) => {
      records.push({ level: 'error', message, context });
    },
    child: () => logger,
  };
  return logger;
}

/** Minimal in-memory VaultService double for delegation tests. */
export function makeVault(secrets: Record<string, string> = {}, enabled = true): VaultService {
  const store = new Map(Object.entries(secrets));
  return {
    isEnabled: () => enabled,
    getSecret: (name) => store.get(name) ?? null,
    setSecret: (name, value) => {
      store.set(name, value);
      const ts = nowIso();
      return { name, createdAt: ts, updatedAt: ts };
    },
    listSecrets: () => [...store.keys()].map((name) => ({ name, createdAt: nowIso(), updatedAt: nowIso() })),
    deleteSecret: (name) => store.delete(name),
    resolveSecrets: (names) => {
      const resolved: Record<string, string> = {};
      for (const name of names) {
        const value = store.get(name);
        if (value !== undefined) resolved[name] = value;
      }
      return resolved;
    },
  };
}

/** Await a call expected to reject with a `GatewayError`; returns the error for assertions. */
export async function catchGatewayError(promise: Promise<unknown>): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
  throw new Error('expected the call to reject with a GatewayError');
}

/** Invoke a synchronous function expected to throw a `GatewayError`; returns the error. */
export function catchSyncGatewayError(fn: () => unknown): GatewayError {
  try {
    fn();
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
  throw new Error('expected the call to throw a GatewayError');
}

