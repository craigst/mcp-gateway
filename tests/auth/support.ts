/**
 * Shared helpers for the auth test suites (not a test file itself).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import type { GatewayConfig } from '../../src/core/config.js';
import { openDatabase } from '../../src/core/db.js';
import type { Logger } from '../../src/core/logger.js';
import { SESSION_COOKIE_NAME } from '../../src/auth/cookies.js';

export const TEST_TTL_MS = 12 * 60 * 60 * 1000;
export const TEST_USERNAME = 'admin';
export const TEST_PASSWORD = 'correct-horse-battery-staple';

export function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 8080,
    dataDir: '/tmp/mcp-gateway-test-data',
    dbPath: ':memory:',
    uiDistDir: 'ui/dist',
    vaultSecret: null,
    bootstrapMasterKey: null,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: [],
    reposDir: '/tmp/mcp-gateway-test-repos',
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 60_000,
    keyPepper: null,
    uiUsername: TEST_USERNAME,
    uiPassword: TEST_PASSWORD,
    uiSessionTtlMs: TEST_TTL_MS,
    uiCookieSecure: false,
    publicBaseUrl: 'http://localhost:8080',
    ...overrides,
  };
}

export function makeDb(): DatabaseSync {
  return openDatabase(':memory:');
}

const noop = (): void => undefined;

export function silentLogger(): Logger {
  return {
    module: 'test',
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => silentLogger(),
  };
}

export interface CapturedLog {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context: Record<string, unknown> | undefined;
}

export interface CaptureLogger {
  logger: Logger;
  records: CapturedLog[];
}

/** Logger that records every call so tests can assert on warnings (never on stdout). */
export function captureLogger(): CaptureLogger {
  const records: CapturedLog[] = [];
  const logger: Logger = {
    module: 'test',
    debug: (message, context) => records.push({ level: 'debug', message, context }),
    info: (message, context) => records.push({ level: 'info', message, context }),
    warn: (message, context) => records.push({ level: 'warn', message, context }),
    error: (message, context) => records.push({ level: 'error', message, context }),
    child: () => logger,
  };
  return { logger, records };
}

export interface MockRequestOptions {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  /** When provided, the request body stream yields this JSON value (or raw string). */
  body?: unknown;
}

export function mockRequest(options: MockRequestOptions = {}): IncomingMessage {
  const chunks: Buffer[] = [];
  if (options.body !== undefined) {
    const raw = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    chunks.push(Buffer.from(raw, 'utf8'));
  }
  const request = Readable.from(chunks) as unknown as IncomingMessage;
  request.method = options.method ?? 'GET';
  request.url = options.url ?? '/';
  request.headers = (options.headers ?? {}) as IncomingMessage['headers'];
  return request;
}

export interface MockResponse {
  statusCode: number;
  headersSent: boolean;
  writableEnded: boolean;
  headers: Record<string, string | number | string[]>;
  payload: string;
  setHeader(name: string, value: string | number | string[]): void;
  getHeader(name: string): string | number | string[] | undefined;
  end(chunk?: string | Buffer): void;
  /** View of the mock usable where the handler expects a real ServerResponse. */
  asServerResponse(): ServerResponse;
}

export function mockResponse(): MockResponse {
  const response: MockResponse = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    headers: {},
    payload: '',
    setHeader(name, value) {
      response.headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return response.headers[name.toLowerCase()];
    },
    end(chunk) {
      response.writableEnded = true;
      response.headersSent = true;
      if (typeof chunk === 'string') response.payload += chunk;
      else if (chunk) response.payload += chunk.toString('utf8');
    },
    asServerResponse() {
      return response as unknown as ServerResponse;
    },
  };
  return response;
}

export function jsonResponse(res: MockResponse): any {
  return JSON.parse(res.payload);
}

export function setCookieHeader(res: MockResponse): string {
  const value = res.headers['set-cookie'];
  if (Array.isArray(value)) return value[0] ?? '';
  return value === undefined ? '' : String(value);
}

/** Extract the raw session token from a `Set-Cookie` value. */
export function tokenFromSetCookie(cookie: string): string | null {
  const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]*)`).exec(cookie);
  const token = match?.[1] ?? '';
  return token === '' ? null : token;
}
