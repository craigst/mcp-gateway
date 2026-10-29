/**
 * Git clone helpers shared by the import engine and the plugin catalog.
 *
 * Private-repository authentication never embeds credentials in the clone URL.
 * Instead an `http.extraheader` is injected through git's environment config:
 *
 *   GIT_CONFIG_COUNT=1
 *   GIT_CONFIG_KEY_0=http.extraheader
 *   GIT_CONFIG_VALUE_0=AUTHORIZATION: basic <base64(x-access-token:TOKEN)>
 *
 * The token therefore never appears in argv (visible in `ps`), the repository
 * URL (`git remote -v`), or persisted records. Any captured stderr / error text
 * is passed through `scrubSecrets` before it can reach a log or API response.
 */
import { execFile, execFileSync } from 'node:child_process';

import { ErrorCodes, GatewayError, invalidParams } from '../core/errors.js';

const DEFAULT_CLONE_TIMEOUT_MS = 60_000;
/** Max length of the captured output tail echoed in an error. */
const ERROR_TAIL_BYTES = 2_048;
export const REDACTED = '[REDACTED]';

export interface CloneRepositoryOptions {
  url: string;
  targetDir: string;
  /** Branch or tag to check out (`--branch`); defaults to the remote default branch. */
  ref?: string | null;
  /** Plaintext clone token; never logged, persisted, or placed in argv. */
  token?: string | null;
  /** Shallow clone depth (default 1; `null` performs a full clone). */
  depth?: number | null;
  timeoutMs?: number;
}

export interface CloneResultMeta {
  /** Total clone duration in milliseconds. */
  durationMs: number;
}

/** `AUTHORIZATION: basic <base64(x-access-token:TOKEN)>` header value. */
export function basicAuthHeader(token: string): string {
  const encoded = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return `AUTHORIZATION: basic ${encoded}`;
}

/**
 * Extra child-process environment used to authenticate a git clone without
 * putting the token on the command line. Returns an empty object for public
 * clones so the clone behaves exactly as before.
 */
export function cloneEnvExtras(token: string | null | undefined): Record<string, string> {
  if (typeof token !== 'string' || token.length === 0) return {};
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: basicAuthHeader(token),
  };
}

/** Replaces every occurrence of each secret with `[REDACTED]`. */
export function scrubSecrets(text: string, secrets: Array<string | null | undefined>): string {
  let result = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    // Replace both the raw token and the derived header value / base64 form.
    const variants = new Set<string>([secret, basicAuthHeader(secret)]);
    const encoded = Buffer.from(`x-access-token:${secret}`, 'utf8').toString('base64');
    variants.add(encoded);
    for (const variant of variants) {
      if (variant.length === 0) continue;
      result = result.split(variant).join(REDACTED);
    }
  }
  return result;
}

/** Validates a user-supplied git ref before it is passed to `git clone --branch`. */
export function assertSafeRef(ref: string | null | undefined): string | null {
  if (ref === undefined || ref === null) return null;
  const trimmed = ref.trim();
  if (trimmed.length === 0) throw invalidParams('Git "ref" must be a non-empty string when provided');
  if (trimmed.length > 255) throw invalidParams('Git "ref" is too long');
  // Control characters, whitespace and option-looking values are never legal refs.
  if (/[\0\n\r\t]/u.test(trimmed) || /\s/u.test(trimmed)) {
    throw invalidParams('Git "ref" must not contain whitespace or control characters', { ref: trimmed });
  }
  if (trimmed.startsWith('-') || trimmed.startsWith('/') || trimmed.endsWith('/')) {
    throw invalidParams('Git "ref" is not a valid branch or tag name', { ref: trimmed });
  }
  if (trimmed.includes('..') || trimmed.includes('@{') || trimmed.includes('\\')) {
    throw invalidParams('Git "ref" is not a valid branch or tag name', { ref: trimmed });
  }
  return trimmed;
}

/**
 * Clones `url` into `targetDir` (which must not exist yet) with a hard timeout.
 *
 * Rejections are always `GatewayError(UPSTREAM_ERROR)` and the message is
 * scrubbed of the clone token (raw, base64 and header forms) before being used.
 */
export async function cloneRepository(options: CloneRepositoryOptions): Promise<CloneResultMeta> {
  const started = Date.now();
  const ref = assertSafeRef(options.ref);
  await execFileClone(options.url, options.targetDir, {
    ...options,
    ref,
    scrubbedSecrets: [options.token],
  });
  return { durationMs: Date.now() - started };
}

function execFileClone(
  url: string,
  targetDir: string,
  options: CloneRepositoryOptions & { ref: string | null; scrubbedSecrets: Array<string | null | undefined> },
): Promise<void> {
  if (typeof url !== 'string' || url.trim().length === 0) {
    return Promise.reject(invalidParams('Git clone requires a non-empty "url"'));
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
  const depth = options.depth === undefined ? 1 : options.depth;
  const args = ['clone'];
  if (depth !== null && depth > 0) args.push('--depth', String(depth));
  if (options.ref !== null) args.push('--branch', options.ref, '--single-branch');
  args.push('--', url, targetDir);

  return new Promise<void>((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          ...cloneEnvExtras(options.token),
        },
      },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve();
          return;
        }
        const timedOut = error.killed === true || error.signal === 'SIGKILL';
        const outputTail = scrubSecrets(tail(stderr), options.scrubbedSecrets);
        const detail =
          outputTail.length > 0
            ? `: ${outputTail}`
            : error.message
              ? `: ${scrubSecrets(error.message, options.scrubbedSecrets)}`
              : '';
        const message = timedOut
          ? `git clone timed out after ${timeoutMs}ms`
          : `git clone failed${error.code !== undefined ? ` (exit code ${String(error.code)})` : ''}${detail}`;
        reject(
          new GatewayError(ErrorCodes.UPSTREAM_ERROR, message, {
            cause: error,
            data: { status: 'UPSTREAM_ERROR', details: { url: scrubSecrets(url, options.scrubbedSecrets) } },
          }),
        );
      },
    );
  });
}

function tail(text: string, maxBytes = ERROR_TAIL_BYTES): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxBytes) return trimmed;
  return trimmed.slice(trimmed.length - maxBytes);
}

/**
 * Enforces the operator's clone allowlist for a repository URL.
 *
 * Used by the import engine, catalog sources and the update path so every code
 * path that clones a URL applies exactly the same rule (empty allowlist =
 * imports disabled).
 */
export function assertAllowedCloneUrl(url: string, allowedPrefixes: string[]): string {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (trimmed.length === 0) {
    throw invalidParams('Git import requires a non-empty "url"');
  }
  if (allowedPrefixes.length === 0) {
    // SECURITY: disabled before any filesystem/process work.
    throw new GatewayError(ErrorCodes.ACCESS_DENIED, 'Git import is disabled', {
      data: { status: 'FORBIDDEN', reason: 'GIT_IMPORT_DISABLED' },
      httpStatus: 403,
    });
  }
  const allowed = allowedPrefixes.some((prefix) => prefix.length > 0 && trimmed.startsWith(prefix));
  if (!allowed) {
    throw new GatewayError(
      ErrorCodes.ACCESS_DENIED,
      'Clone URL is not in the allowed import prefixes',
      {
        data: { status: 'FORBIDDEN', reason: 'GIT_IMPORT_URL_NOT_ALLOWED', details: { url: trimmed } },
        httpStatus: 403,
      },
    );
  }
  return trimmed;
}

/**
 * Resolves the checked-out commit for a working directory (`git rev-parse HEAD`).
 *
 * Returns null when the directory is missing, not a git repository, or git is
 * unavailable — callers treat "unknown commit" as "update state unknown".
 */
export function resolveGitHead(repoDir: string | null | undefined, timeoutMs = 10_000): string | null {
  if (typeof repoDir !== 'string' || repoDir.length === 0) return null;
  try {
    const output = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      windowsHide: true,
    });
    const sha = output.trim();
    return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
