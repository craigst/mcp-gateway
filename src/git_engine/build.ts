/**
 * Shell-free, bounded build execution shared by the import engine and the
 * staged update path.
 *
 * Security invariants (identical to the original import-engine build):
 *  - Commands are tokenized and spawned with `{ shell: false }`.
 *  - A hard timeout kills the whole process group.
 *  - Captured output is capped and scrubbed of known secrets before it is
 *    returned, logged, or embedded in an error message.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import { ErrorCodes, GatewayError, invalidParams } from '../core/errors.js';
import { scrubSecrets } from './clone.js';
import { splitCommand } from './manifest.js';

export const BUILD_TIMEOUT_MS = 180_000;
/** Max length of the captured output tail echoed in an error. */
const ERROR_TAIL_BYTES = 2_048;
/** Cap on captured build output kept in memory. */
const MAX_CAPTURED_OUTPUT = 8_192;
/** Number of build-log lines exposed to API responses. */
export const MAX_BUILD_LOG_LINES = 50;

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: Error;
}

export interface RunBuildOptions {
  /** Command line to tokenize and execute (no shell, no expansion). */
  commandLine: string;
  cwd: string;
  /** Extra environment merged over `process.env`. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Secret values scrubbed from captured output and error messages. */
  secrets?: Array<string | null | undefined>;
}

export interface RunBuildResult {
  exitCode: number;
  /** Trailing, scrubbed, non-empty output lines (bounded). */
  logTail: string[];
}

/** Splits captured output into at most `maxLines` non-empty trailing lines. */
export function tailLines(text: string, maxLines = MAX_BUILD_LOG_LINES): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return lines.slice(Math.max(0, lines.length - maxLines));
}

/**
 * Runs a build command, throwing `GatewayError(UPSTREAM_ERROR)` on spawn
 * failure, timeout, or a non-zero exit code. The message contains a scrubbed
 * output tail so operators can diagnose the failure without leaking secrets.
 */
export async function runBuildCommand(options: RunBuildOptions): Promise<RunBuildResult> {
  const tokens = splitCommand(options.commandLine);
  const file = tokens[0];
  if (file === undefined) {
    throw invalidParams('Build command is empty');
  }
  const args = tokens.slice(1);
  const timeoutMs = options.timeoutMs ?? BUILD_TIMEOUT_MS;
  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };
  const secrets = options.secrets ?? [];

  const result = await spawnProcess(file, args, options.cwd, env, timeoutMs);
  const logTail = tailLines(scrubSecrets(`${result.stdout}${result.stderr}`, secrets));

  if (result.spawnError !== undefined) {
    throw new GatewayError(
      ErrorCodes.UPSTREAM_ERROR,
      `Failed to start build command "${file}": ${scrubSecrets(result.spawnError.message, secrets)}`,
      { cause: result.spawnError, data: { status: 'UPSTREAM_ERROR' } },
    );
  }

  if (result.timedOut) {
    const outputTail = tail(scrubSecrets(result.stderr || result.stdout, secrets));
    throw new GatewayError(
      ErrorCodes.UPSTREAM_ERROR,
      `Build timed out after ${timeoutMs}ms${outputTail.length > 0 ? `: ${outputTail}` : ''}`,
      { data: { status: 'UPSTREAM_ERROR', details: { timedOut: true } } },
    );
  }

  if (result.exitCode !== 0) {
    const outputTail = tail(scrubSecrets(result.stderr || result.stdout, secrets));
    throw new GatewayError(
      ErrorCodes.UPSTREAM_ERROR,
      `Build failed (exit code ${String(result.exitCode)} for "${file}")${outputTail.length > 0 ? `: ${outputTail}` : ''}`,
      { data: { status: 'UPSTREAM_ERROR', details: { exitCode: result.exitCode } } },
    );
  }

  return { exitCode: result.exitCode, logTail };
}

function spawnProcess(
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

function appendCapped(existing: string, chunk: string): string {
  const combined = existing + chunk;
  return combined.length <= MAX_CAPTURED_OUTPUT
    ? combined
    : combined.slice(combined.length - MAX_CAPTURED_OUTPUT);
}

function tail(text: string, maxBytes = ERROR_TAIL_BYTES): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxBytes) return trimmed;
  return trimmed.slice(trimmed.length - maxBytes);
}
