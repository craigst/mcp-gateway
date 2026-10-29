/**
 * Harness discovery + import service.
 *
 * Scans the configured local harnesses for MCP servers and imports a selected
 * entry into the gateway catalog. Import never copies secret VALUES from the
 * harness config: the caller may supply env values explicitly or point at an
 * env file that stays on disk (`envFile`).
 */
import { basename, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { invalidParams } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { CatalogRepository, HarnessDiscoveryService } from '../core/ports.js';
import type {
  HarnessImportInput,
  HarnessScanResult,
  HarnessSourceInfo,
  RuntimeKind,
  ServerRecord,
  TransportKind,
} from '../core/types.js';
import {
  HARNESS_ADAPTERS,
  expandHome,
  scanAllHarnesses,
  scanAllHarnessesSync,
  type HarnessAdapter,
  type ScanAllOptions,
} from './adapters.js';

export interface HarnessDiscoveryDeps {
  repository: CatalogRepository;
  logger?: Logger;
  /** Test/injection hook: home directory used for `~` expansion. */
  homeDir?: string;
  /** Test/injection hook: environment used for adapter path overrides. */
  env?: NodeJS.ProcessEnv;
  /** Test/injection hook: replace the built-in adapter list. */
  adapters?: readonly HarnessAdapter[];
}

const TRANSPORTS: readonly TransportKind[] = ['stdio', 'http', 'sse', 'websocket'];
const MAX_SERVER_NAME_LENGTH = 64;
const MAX_NAME_COLLISION_ATTEMPTS = 1_000;

/**
 * Derives a safe, unique server name from operator input:
 * `[a-z0-9][a-z0-9-_]{0,63}` (collisions get `-2`, `-3`, …).
 */
export class DefaultHarnessDiscoveryService implements HarnessDiscoveryService {
  private readonly repository: CatalogRepository;
  private readonly logger: Logger;
  private readonly scanOptions: ScanAllOptions;

  constructor(deps: HarnessDiscoveryDeps) {
    this.repository = deps.repository;
    this.logger = deps.logger ?? createLogger('discovery');
    this.scanOptions = { homeDir: deps.homeDir, env: deps.env, adapters: deps.adapters };
  }

  /** Synchronous source list (drives the UI's harness list before a scan). */
  listSources(): HarnessSourceInfo[] {
    return scanAllHarnessesSync(this.scanOptions).sources;
  }

  /** Scans all adapters, or only `harnessIds` when supplied. */
  async scan(harnessIds?: string[]): Promise<HarnessScanResult> {
    const result = await scanAllHarnesses({ ...this.scanOptions, harnessIds });
    this.logger.debug('harness scan finished', {
      harnesses: result.sources.map((source) => source.id),
      entries: result.entries.length,
      errors: result.errors.length,
    });
    return result;
  }

  /** Creates a stopped catalog server from a discovered harness entry. */
  async importEntry(input: HarnessImportInput): Promise<ServerRecord> {
    const adapters = this.scanOptions.adapters ?? HARNESS_ADAPTERS;
    const harness = typeof input?.harness === 'string' ? input.harness.trim() : '';
    const adapter = adapters.find((candidate) => candidate.id === harness);
    if (!adapter) {
      const known = adapters.map((candidate) => candidate.id).join(', ');
      throw invalidParams(`Unknown harness '${harness}'. Known harnesses: ${known}.`);
    }

    const transport = (input.transport ?? 'stdio') as TransportKind;
    if (!TRANSPORTS.includes(transport)) {
      throw invalidParams(`transport must be one of ${TRANSPORTS.join(', ')}`);
    }

    const command = typeof input.command === 'string' ? input.command.trim() : '';
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    // Mirrors the server-create rules in the admin router.
    if (transport === 'stdio' && !command) throw invalidParams('command is required for stdio transport');
    if (transport !== 'stdio' && !url) throw invalidParams('url is required for remote transports');

    const name = this.uniqueServerName(input.name);
    const now = nowIso();
    const record: ServerRecord = {
      id: newId('srv'),
      name,
      runtime: deriveRuntime({ transport, command }),
      transport,
      status: 'stopped',
      command: transport === 'stdio' ? command : null,
      args: transport === 'stdio' && Array.isArray(input.args) ? input.args.map((arg) => String(arg)) : [],
      url: transport === 'stdio' ? null : url,
      // Only user-supplied values are persisted; discovery never yields values.
      env: sanitizeEnv(input.env),
      headers: sanitizeEnv(input.headers),
      manifest: null,
      highPrivilegeTools: stringArray(input.highPrivilegeTools),
      delegationSupported: false,
      sourceUrl: null,
      workDir: null,
      envFile: this.resolveEnvFile(input.envFile),
      approvalRequiredTools: stringArray(input.approvalRequiredTools),
      lastError: null,
      pid: null,
      createdAt: now,
      updatedAt: now,
    };

    this.repository.upsertServer(record);
    this.logger.info('server imported from harness', {
      harness: adapter.id,
      serverId: record.id,
      name: record.name,
      runtime: record.runtime,
      transport: record.transport,
    });
    return record;
  }

  private uniqueServerName(rawName: unknown): string {
    const requested = typeof rawName === 'string' ? rawName.trim() : '';
    if (!requested) throw invalidParams('name is required');
    const base = sanitizeServerName(requested);
    if (!base) throw invalidParams(`name '${requested}' does not contain any usable characters`);

    if (!this.repository.getServerByName(base)) return base;
    for (let suffix = 2; suffix <= MAX_NAME_COLLISION_ATTEMPTS; suffix += 1) {
      const suffixText = `-${suffix}`;
      const candidate = `${base.slice(0, MAX_SERVER_NAME_LENGTH - suffixText.length)}${suffixText}`;
      if (!this.repository.getServerByName(candidate)) return candidate;
    }
    throw invalidParams(`Could not derive a unique server name from '${requested}'`);
  }

  private resolveEnvFile(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const homeDir = this.scanOptions.homeDir ?? homedir();
    const expanded = expandHome(trimmed, homeDir);
    return isAbsolute(expanded) ? expanded : resolve(expanded);
  }
}

/**
 * Derives the runtime kind for an imported entry:
 * remote URLs → `remote-agent`; python/uv executables → `python`; node/bun/npx →
 * `node`; everything else → `binary`.
 */
export function deriveRuntime(input: { transport: TransportKind; command: string }): RuntimeKind {
  if (input.transport !== 'stdio') return 'remote-agent';
  const executable = basename(input.command)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, '');
  if (executable.startsWith('python') || executable.startsWith('uv')) return 'python';
  if (executable === 'node' || executable === 'bun' || executable === 'npx') return 'node';
  return 'binary';
}

/** Sanitizes a server name into `[a-z0-9][a-z0-9-_]{0,63}` (may return ''). */
export function sanitizeServerName(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, MAX_SERVER_NAME_LENGTH)
    .replace(/[-_]+$/, '');
}

function sanitizeEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof key !== 'string' || key.length === 0) continue;
    if (value === null || value === undefined) continue;
    result[key] = String(value);
  }
  return result;
}

function stringArray(value: string[] | undefined): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}
