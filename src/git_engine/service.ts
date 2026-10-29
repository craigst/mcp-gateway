/**
 * Git import engine: clone an allowlisted repository, resolve (or auto-detect)
 * its manifest, run a bounded build, then produce a `ServerRecord` for the
 * supervisor.
 *
 * Security invariants:
 *  - The clone URL must match a configured prefix (`gitImportAllowedPrefixes`);
 *    an empty allowlist disables imports entirely. This check happens before
 *    any filesystem or process work.
 *  - Private clones authenticate through git's environment config (never a URL
 *    with embedded credentials, never argv); captured output is scrubbed.
 *  - No shell is ever used: commands are tokenized and passed to
 *    `spawn(file, args, { shell: false })`.
 *  - Clones and builds have hard timeouts and captured output is truncated.
 *  - Vault secrets are injected into the build environment only; they are never
 *    logged or persisted.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

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
import { detectManifest, type DetectedManifest } from './autodetect.js';
import { assertSafeRef, cloneRepository, scrubSecrets } from './clone.js';
import { mapRuntime, splitCommand } from './manifest.js';

const BUILD_TIMEOUT_MS = 180_000;
/** Max length of the captured output tail echoed in an error. */
const ERROR_TAIL_BYTES = 2_048;
/** Cap on captured build output kept in memory. */
const MAX_CAPTURED_OUTPUT = 8_192;
/** Number of build-log lines exposed to the catalog install response. */
const MAX_BUILD_LOG_LINES = 50;
const REPOSITORY_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;

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

/** Validates/undoes a monorepo sub-directory reference before any clone work. */
export function normalizeSubpath(subpath: string | null | undefined): string | null {
  if (subpath === undefined || subpath === null) return null;
  if (typeof subpath !== 'string') throw invalidParams('"subpath" must be a string');
  const trimmed = subpath.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes('\0') || isAbsolute(trimmed)) {
    throw invalidParams('Repository "subpath" must be a relative directory', { subpath: trimmed });
  }
  const segments = trimmed.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..' || segment === '.' || segment.length === 0)) {
    throw invalidParams('Repository "subpath" must not contain "." or ".." segments', { subpath: trimmed });
  }
  return segments.join('/');
}

export class GitImportService implements GitImportServicePort {
  private readonly config: GatewayConfig;
  private readonly repository: CatalogRepository | undefined;
  private readonly vault: VaultService | undefined;
  private readonly persist: ((server: ServerRecord) => void) | undefined;
  private readonly logger: Logger;
  /** Most recent build output, scrubbed and capped; exposed to the catalog API. */
  private lastBuildLog: string[] = [];

  constructor(deps: GitImportServiceDeps) {
    this.config = deps.config;
    this.repository = deps.repository;
    this.vault = deps.vault;
    this.persist = deps.persist;
    this.logger = deps.logger ?? createLogger('git_engine', 'silent');
  }

  /** Tail of the most recent build's combined stdout/stderr (secrets scrubbed). */
  getLastBuildLogTail(): string[] {
    return [...this.lastBuildLog];
  }

  async importRepository(input: GitImportInput): Promise<ServerRecord> {
    const url = this.assertUrlAllowed(input);
    const name = deriveServerName(url, input.name);
    this.assertCommandOverrides(input);
    const ref = assertSafeRef(input.ref);
    const subpath = normalizeSubpath(input.subpath);
    const extraEnv = this.assertExtraEnv(input.env);

    if (this.repository?.getServerByName(name) != null) {
      throw invalidParams(`A server named "${name}" is already registered`, { name });
    }

    const targetDir = join(this.config.reposDir, name);
    if (existsSync(targetDir)) {
      throw invalidParams(`Import target already exists: ${targetDir}`, { targetDir });
    }

    this.lastBuildLog = [];
    this.createTargetDir(targetDir);
    try {
      this.logger.info('Cloning repository for import', {
        name,
        url,
        targetDir,
        ref,
        subpath,
        private: typeof input.token === 'string' && input.token.length > 0,
      });
      await cloneRepository({ url, targetDir, ref, token: input.token ?? null });

      // A checked-in manifest wins; otherwise derive one from package.json /
      // pyproject.toml+server.py. Detection failures reject before any build.
      const detected = detectManifest(targetDir, subpath);
      const runtime = mapRuntime(detected.manifest.runtime);
      const workDir = subpath === null ? targetDir : join(targetDir, subpath);

      const buildCommand = input.buildCommand ?? detected.buildCommand;
      if (buildCommand !== undefined && buildCommand !== null && buildCommand.trim().length > 0) {
        await this.runBuild(buildCommand, workDir, detected.manifest, {
          token: input.token ?? null,
          extraEnv,
          requiredSecrets: detected.manifest.required_secrets ?? [],
        });
      }

      const record = this.buildRecord({
        url,
        name,
        targetDir,
        workDir,
        detected,
        runtime,
        input,
        extraEnv,
      });
      this.persist?.(record);
      this.repository?.upsertServer(record);
      this.logger.info('Imported sub-server from git repository', {
        serverId: record.id,
        name: record.name,
        runtime: record.runtime,
        sourceUrl: record.sourceUrl,
        detectedFrom: detected.detectedFrom,
      });
      return record;
    } catch (error) {
      this.cleanupDir(targetDir);
      if (error instanceof GatewayError) {
        // Ensure no secret material can ride along in an error (defensive).
        throw scrubGatewayError(error, input);
      }
      const message = scrubSecrets(error instanceof Error ? error.message : String(error), [
        input.token,
        ...Object.values(extraEnv),
      ]);
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

  private assertExtraEnv(env: Record<string, string> | undefined): Record<string, string> {
    if (env === undefined || env === null) return {};
    if (typeof env !== 'object' || Array.isArray(env)) {
      throw invalidParams('Import "env" must be an object of string values');
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw invalidParams(`Invalid environment variable name "${key}"`, { name: key });
      }
      if (typeof value !== 'string') {
        throw invalidParams(`Environment variable "${key}" must be a string`, { name: key });
      }
      result[key] = value;
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  private async runBuild(
    commandLine: string,
    cwd: string,
    manifest: ServerManifest,
    options: { token: string | null; extraEnv: Record<string, string>; requiredSecrets: string[] },
  ): Promise<void> {
    const tokens = splitCommand(commandLine);
    const file = tokens[0];
    if (file === undefined) {
      throw invalidParams('Build command is empty');
    }
    const args = tokens.slice(1);

    // Precedence: process env < manifest static env < catalog/import UI env.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(manifest.environment ?? {}),
      ...options.extraEnv,
    };
    // Missing named secrets throw INVALID_PARAMS (names only) before the build runs.
    const resolvedSecrets = this.vault?.resolveSecrets(options.requiredSecrets) ?? {};
    for (const [key, value] of Object.entries(resolvedSecrets)) {
      env[key] = value;
    }
    const scrubList: Array<string | null | undefined> = [
      options.token,
      ...Object.values(options.extraEnv),
      ...Object.values(resolvedSecrets),
    ];

    this.logger.info('Running import build', { cwd, command: file, args, timeoutMs: BUILD_TIMEOUT_MS });
    const result = await this.spawnProcess(file, args, cwd, env, BUILD_TIMEOUT_MS);
    const combined = `${result.stdout}${result.stderr}`;
    this.lastBuildLog = tailLines(scrubSecrets(combined, scrubList), MAX_BUILD_LOG_LINES);

    if (result.spawnError !== undefined) {
      throw new GatewayError(
        ErrorCodes.UPSTREAM_ERROR,
        `Failed to start build command "${file}": ${scrubSecrets(result.spawnError.message, scrubList)}`,
        { cause: result.spawnError, data: { status: 'UPSTREAM_ERROR' } },
      );
    }

    if (result.timedOut) {
      const outputTail = tail(scrubSecrets(result.stderr || result.stdout, scrubList));
      throw new GatewayError(
        ErrorCodes.UPSTREAM_ERROR,
        `Build timed out after ${BUILD_TIMEOUT_MS}ms${outputTail.length > 0 ? `: ${outputTail}` : ''}`,
        { data: { status: 'UPSTREAM_ERROR', details: { timedOut: true } } },
      );
    }

    if (result.exitCode !== 0) {
      const outputTail = tail(scrubSecrets(result.stderr || result.stdout, scrubList));
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
    workDir: string;
    detected: DetectedManifest;
    runtime: RuntimeKind;
    input: GitImportInput;
    extraEnv: Record<string, string>;
  }): ServerRecord {
    const { url, name, workDir, detected, runtime, input, extraEnv } = args;
    const manifest = detected.manifest;
    const startCommand = input.startCommand ?? detected.startCommand ?? manifest.start_command;
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
      env: { ...(manifest.environment ?? {}), ...extraEnv },
      manifest,
      highPrivilegeTools: [...(capabilities.high_privilege_tools ?? [])],
      delegationSupported: capabilities.delegation_supported === true,
      sourceUrl: url,
      workDir,
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

/** Splits captured output into at most `maxLines` non-empty trailing lines. */
function tailLines(text: string, maxLines: number): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return lines.slice(Math.max(0, lines.length - maxLines));
}

/**
 * Defensive deep-scrub of a GatewayError: token/secret values from the import
 * request must never surface through an error message or its `data` payload.
 */
function scrubGatewayError(error: GatewayError, input: GitImportInput): GatewayError {
  const secrets: Array<string | null | undefined> = [input.token, ...Object.values(input.env ?? {})];
  const scrubbedMessage = scrubSecrets(error.message, secrets);
  const data =
    error.data === undefined
      ? undefined
      : (JSON.parse(scrubSecrets(JSON.stringify(error.data), secrets)) as GatewayError['data']);
  if (scrubbedMessage === error.message && data === error.data) return error;
  return new GatewayError(error.code, scrubbedMessage, {
    data,
    httpStatus: error.httpStatus,
    cause: error.cause,
  });
}

/** Alias matching the task's preferred class name. */
export { GitImportService as DefaultGitImportService };
