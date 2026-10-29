/**
 * Shared helpers for the harness discovery tests.
 *
 * All fixture data is fake (`example.com`) so the public repository never
 * carries an operator's real paths, URLs or secrets.
 */
import { join, resolve } from 'node:path';
import { createLogger } from '../../src/core/logger.js';

export const HARNESS_FIXTURES = resolve('tests/fixtures/harness');

/** Fake secret VALUES that must never appear in discovery output. */
export const FIXTURE_SECRETS: readonly string[] = [
  'claude-fixture-secret-brain-key',
  'claude-fixture-secret-header-token',
  'opencode-fixture-secret-local-key',
  'opencode-fixture-secret-header-token',
  'opencode-fixture-secret-envfile-value',
  'omb-fixture-secret-header-token',
  'omb-fixture-secret-env-value',
  'generic-fixture-secret-value',
];

/** Environment overrides that point every adapter at the committed fixtures. */
export function fixtureHarnessEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MCP_DISCOVERY_CLAUDE_CONFIG: join(HARNESS_FIXTURES, 'claude.json'),
    MCP_DISCOVERY_OPENCODE_CONFIG: join(HARNESS_FIXTURES, 'opencode', 'opencode.json'),
    MCP_DISCOVERY_OPENMAUSBOT_CONFIG: join(HARNESS_FIXTURES, 'openmausbot', 'config.json'),
    MCP_DISCOVERY_CONFIG: join(HARNESS_FIXTURES, 'generic.json'),
    ...overrides,
  };
}

export const silentLogger = createLogger('test', 'silent');
