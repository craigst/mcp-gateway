/**
 * Git import engine: clone an allowlisted repository, validate its manifest,
 * run a bounded build, then produce a `ServerRecord` for the supervisor.
 *
 * Security invariants:
 *  - The clone URL must match a configured prefix (`gitImportAllowedPrefixes`);
 *    an empty allowlist disables imports entirely. This check happens before
 *    any filesystem or process work.
 *  - No shell is ever used: commands are tokenized and passed to
 *    `spawn(file, args, { shell: false })`.
 *  - Clones and builds have hard timeouts and captured output is truncated.
 *  - Vault secrets are injected into the build environment only; they are never
 *    logged or persisted.
 */
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { GatewayConfig } from '../core/config.js';
import { ErrorCodes, GatewayError, invalidParams } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { createLogger } from '../core/logger.js';
import type { Logger } from '../core/logger.js';
import type {
  CatalogRepository,
  GitImportInput,
  GitImportService as GitImportServicePort,
  VaultService,
} from '../core/ports.js';
import type { RuntimeKind, ServerManifest, ServerRecord } from '../core/types.js';
import { mapRuntime, parseManifestFile, splitCommand } from './manifest.js';

const CLONE_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 180_000;
/** Max length of the captured output tail echoed in an error. */
const ERROR_TAIL_BYTES = 2_048;
/** Cap on captured build output kept in memory. */
const MAX_CAPTURED_OUTPUT = 8_192;
const REPOSITORY_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;

const DEFAULT_BUILD_COMMANDS: Partial<Record<RuntimeKind, string>> = {
  node: 'npm install --no-audit --no-fund',
  python: 'uv sync',
};

export interface GitImportServiceDeps {
  config: GatewayConfig;
  /** Optional catalog persistence. */
  repository?: CatalogRepository;
  /** Optional vault used to resolve `manifest.required_secrets` for the build. */
  vault?: VaultService;
  /** Optional persistence hook (e.g. supervisor registration). */
  persist?: (server: ServerRecord) => void;
  logger?: Logger;
}

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: Error;
}

function tail(text: string, maxBytes = ERROR_TAIL_BYTES): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxBytes) return trimmed;
  return trimmed.slice(trimmed.length - maxBytes);
}

function appendCapped(existing: string, chunk: string): string {
  const combined = existing + chunk;
  return combined.length <= MAX_CAPTURED_OUTPUT
    ? combined
    : combined.slice(combined.length - MAX_CAPTURED_OUTPUT);
}

/** Derive a filesystem/DB-safe server name from user input or the repo basename. */
export function deriveServerName(url: string, requestedName?: string): string {
  const rawName = requestedName?.trim();
  if (rawName !== undefined && rawName.length > 0) {
    if (!REPOSITORY_NAME_PATTERN.test(rawName)) {
      throw invalidParams(
        'Server name must match /^[a-z0-9][a-z0-9-_]{0,63}$/',
        { name: rawName },
      );
    }
    return rawName;
  }

  const trimmedUrl = url.replace(/\/+$/, '');
  const repoBase = basename(trimmedUrl).replace(/\.git$/i, '').toLowerCase();
  if (!REPOSITORY_NAME_PATTERN.test(repoBase)) {
    throw invalidParams(
      'Unable to derive a valid server name from the repository URL; pass "name" explicitly',
      { url },
    );
  }
  return repoBase;
}

export class GitImportService implements GitImportServicePort {
  private readonly config: GatewayConfig;
  private readonly repository: CatalogRepository | undefined;
  private readonly vault: VaultService | undefined;
  private readonly persist: ((server: ServerRecord) => void) | undefined;
  private readonly logger: Logger;

  constructor(deps: GitImportServiceDeps) {
    this.config = deps.config;
    this.repository = deps.repository;
    this.vault = deps.vault;
    this.persist = deps.persist;
    this.logger = deps.logger ?? createLogger('git_engine', 'silent');
  }

  async importRepository(input: GitImportInput): Promise<ServerRecord> {
    const url = this.assertUrlAllowed(input);
    const name = deriveServerName(url, input.name);
    this.assertCommandOverrides(input);

    if (this.repository?.getServerByName(name) != null) {
      throw invalidParams(`A server named "${name}" is already registered`, { name });
    }

    const targetDir = join(this.config.reposDir, name);
    if (existsSync(targetDir)) {
      throw invalidParams(`Import target already exists: ${targetDir}`, { targetDir });
    }

    this.createTargetDir(targetDir);
    try {
      this.logger.info('Cloning repository for import', { name, url, targetDir });
      await this.clone(url, targetDir);

      const manifest = parseManifestFile(join(targetDir, 'mcp-manifest.json'));
      const runtime = mapRuntime(manifest.runtime);

      const buildCommand =
        input.buildCommand ?? manifest.build_command ?? DEFAULT_BUILD_COMMANDS[runtime];
      if (buildCommand !== undefined && buildCommand !== null) {
        await this.runBuild(buildCommand, targetDir, manifest);
      }

      const record = this.buildRecord({ url, name, targetDir, manifest, runtime, input });
      this.persist?.(record);
      this.repository?.upsertServer(record);
      this.logger.info('Imported sub-server from git repository', {
        serverId: record.id,
        name: record.name,
        runtime: record.runtime,
        sourceUrl: record.sourceUrl,
      });
      return record;
    } catch (error) {
      this.cleanupDir(targetDir);
      if (error instanceof GatewayError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, `Git import failed: ${message}`, {
        cause: error,
        data: { status: 'UPSTREAM_ERROR', details: { url, name } },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  private assertUrlAllowed(input: GitImportInput): string {
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (url.length === 0) {
      throw invalidParams('Git import requires a non-empty "url"');
    }

    const allowedPrefixes = this.config.gitImportAllowedPrefixes;
    if (allowedPrefixes.length === 0) {
      // SECURITY: disabled before any filesystem/process work.
      throw new GatewayError(ErrorCodes.ACCESS_DENIED, 'Git import is disabled', {
        data: { status: 'FORBIDDEN', reason: 'GIT_IMPORT_DISABLED' },
        httpStatus: 403,
      });
    }

    const allowed = allowedPrefixes.some((prefix) => prefix.length > 0 && url.startsWith(prefix));
    if (!allowed) {
      throw new GatewayError(
        ErrorCodes.ACCESS_DENIED,
        'Clone URL is not in the allowed import prefixes',
        {
          data: { status: 'FORBIDDEN', reason: 'GIT_IMPORT_URL_NOT_ALLOWED', details: { url } },
          httpStatus: 403,
        },
      );
    }
    return url;
  }

  private assertCommandOverrides(input: GitImportInput): void {
    if (input.buildCommand !== undefined && input.buildCommand.trim().length === 0) {
      throw invalidParams('"buildCommand" must be a non-empty string when provided');
    }
    if (input.startCommand !== undefined && input.startCommand.trim().length === 0) {
      throw invalidParams('"startCommand" must be a non-empty string when provided');
    }
  }

  // -------------------------------------------------------------------------
  // Clone
  // -------------------------------------------------------------------------

  private clone(url: string, targetDir: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      execFile(
        'git',
        ['clone', '--depth', '1', '--', url, targetDir],
        {
          timeout: CLONE_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
          // Never block on interactive credential prompts inside a service.
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
        (error, _stdout, stderr) => {
          if (error === null) {
            resolve();
            return;
          }
          const timedOut = error.killed === true || error.signal === 'SIGKILL';
          const outputTail = tail(stderr);
          const detail =
            outputTail.length > 0
              ? `: ${outputTail}`
              : error.message
                ? `: ${error.message}`
                : '';
          const message = timedOut
            ? `git clone timed out after ${CLONE_TIMEOUT_MS}ms`
            : `git clone failed${error.code !== undefined ? ` (exit code ${String(error.code)})` : ''}${detail}`;
          reject(
            new GatewayError(ErrorCodes.UPSTREAM_ERROR, message, {
              cause: error,
              data: { status: 'UPSTREAM_ERROR', details: { url } },
            }),
          );
        },
      );
    });
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  private async runBuild(
    commandLine: string,
    cwd: string,
    manifest: ServerManifest,
  ): Promise<void> {
    const tokens = splitCommand(commandLine);
    const file = tokens[0];
    if (file === undefined) {
      throw invalidParams('Build command is empty');
    }
    const args = tokens.slice(1);

    const env: NodeJS.ProcessEnv = { ...process.env, ...(manifest.environment ?? {}) };
    const requiredSecrets = manifest.required_secrets ?? [];
    // Missing named secrets throw INVALID_PARAMS (names only) before the build runs.
    const resolvedSecrets = this.vault?.resolveSecrets(requiredSecrets) ?? {};
    for (const [key, value] of Object.entries(resolvedSecrets)) {
      env[key] = value;
    }

    this.logger.info('Running import build', { cwd, command: file, args, timeoutMs: BUILD_TIMEOUT_MS });
    const result = await this.spawnProcess(file, args, cwd, env, BUILD_TIMEOUT_MS);

    if (result.spawnError !== undefined) {
      throw new GatewayError(
        ErrorCodes.UPSTREAM_ERROR,
        `Failed to start build command "${file}": ${result.spawnError.message}`,
        { cause: result.spawnError, data: { status: 'UPSTREAM_ERROR' } },
      );
    }

    if (result.timedOut) {
      const outputTail = tail(result.stderr || result.stdout);
      throw new GatewayError(
        ErrorCodes.UPSTREAM_ERROR,
        `Build timed out after ${BUILD_TIMEOUT_MS}ms${outputTail.length > 0 ? `: ${outputTail}` : ''}`,
        { data: { status: 'UPSTREAM_ERROR', details: { timedOut: true } } },
      );
    }

    if (result.exitCode !== 0) {
      const outputTail = tail(result.stderr || result.stdout);
      throw new GatewayError(
        ErrorCodes.UPSTREAM_ERROR,
        `Build failed (exit code ${String(result.exitCode)} for "${file}")${outputTail.length > 0 ? `: ${outputTail}` : ''}`,
        { data: { status: 'UPSTREAM_ERROR', details: { exitCode: result.exitCode } } },
      );
    }

    this.logger.debug('Import build completed', { cwd, exitCode: result.exitCode });
  }

  private spawnProcess(
    file: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
  ): Promise<ProcessResult> {
    return new Promise<ProcessResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(file, args, {
          cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError: error instanceof Error ? error : new Error(String(error)),
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      const finish = (result: ProcessResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout = appendCapped(stdout, chunk);
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr = appendCapped(stderr, chunk);
      });
      child.on('error', (error) => {
        finish({ exitCode: null, signal: null, stdout, stderr, timedOut, spawnError: error });
      });
      child.on('close', (code, signal) => {
        finish({ exitCode: code, signal, stdout, stderr, timedOut });
      });
    });
  }

  // -------------------------------------------------------------------------
  // Record assembly / cleanup
  // -------------------------------------------------------------------------

  private buildRecord(args: {
    url: string;
    name: string;
    targetDir: string;
    manifest: ServerManifest;
    runtime: RuntimeKind;
    input: GitImportInput;
  }): ServerRecord {
    const { url, name, targetDir, manifest, runtime, input } = args;
    const startCommand = input.startCommand ?? manifest.start_command;
    if (startCommand === undefined || startCommand.trim().length === 0) {
      throw invalidParams('Manifest does not define a usable start command');
    }
    const startTokens = splitCommand(startCommand);
    const command = startTokens[0];
    if (command === undefined) {
      throw invalidParams('Start command is empty');
    }

    const now = nowIso();
    const capabilities = manifest.capabilities ?? {};
    return {
      id: newId('srv'),
      name,
      runtime,
      transport: 'stdio',
      status: 'stopped',
      command,
      args: startTokens.slice(1),
      url: null,
      env: { ...(manifest.environment ?? {}) },
      manifest,
      highPrivilegeTools: [...(capabilities.high_privilege_tools ?? [])],
      delegationSupported: capabilities.delegation_supported === true,
      sourceUrl: url,
      workDir: targetDir,
      lastError: null,
      pid: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  private createTargetDir(targetDir: string): void {
    try {
      mkdirSync(this.config.reposDir, { recursive: true });
      // Non-recursive: an EEXIST here means a concurrent import won the race.
      mkdirSync(targetDir);
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw invalidParams(`Import target already exists: ${targetDir}`, { targetDir });
      }
      throw new GatewayError(
        ErrorCodes.UPSTREAM_ERROR,
        `Unable to create import directory ${targetDir}`,
        { cause: error, data: { status: 'UPSTREAM_ERROR', details: { targetDir } } },
      );
    }
  }

  private cleanupDir(targetDir: string): void {
    try {
      rmSync(targetDir, { recursive: true, force: true });
    } catch (error) {
      this.logger.warn('Failed to clean up import directory', {
        targetDir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Alias matching the task's preferred class name. */
export { GitImportService as DefaultGitImportService };
