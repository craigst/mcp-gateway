/**
 * Remote-ref inspection for update checks and semver tag selection.
 *
 * `git ls-remote` is read-only: it never writes a work tree and authenticates a
 * private repository through the same git environment header used by clones, so
 * a token never appears in argv or output. Errors are scrubbed.
 */
import { execFile } from 'node:child_process';

import { ErrorCodes, GatewayError } from '../core/errors.js';
import { cloneEnvExtras, scrubSecrets } from './clone.js';

const DEFAULT_LS_REMOTE_TIMEOUT_MS = 30_000;
const ERROR_TAIL_BYTES = 2_048;

export interface RemoteRefs {
  /** Branch name → commit sha (`refs/heads/<name>`). */
  heads: Record<string, string>;
  /** Tag name → commit sha; annotated tags resolve to the peeled commit. */
  tags: Record<string, string>;
}

export interface ResolveRemoteRefsInput {
  url: string;
  token?: string | null;
  timeoutMs?: number;
}

/**
 * Lists branches and tags of a remote repository.
 *
 * Rejections are `GatewayError(UPSTREAM_ERROR)` with the token/URL scrubbed from
 * the message so private repository names cannot leak secrets into logs.
 */
export async function resolveRemoteRefs(input: ResolveRemoteRefsInput): Promise<RemoteRefs> {
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (url.length === 0) {
    throw new GatewayError(ErrorCodes.INVALID_PARAMS, 'A repository URL is required to resolve refs', {
      httpStatus: 400,
      data: { status: 'INVALID_PARAMS' },
    });
  }
  const secrets = [input.token];
  const timeoutMs = input.timeoutMs ?? DEFAULT_LS_REMOTE_TIMEOUT_MS;

  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      ['ls-remote', '--heads', '--tags', '--', url],
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...cloneEnvExtras(input.token) },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        const timedOut = error.killed === true || error.signal === 'SIGKILL';
        const outputTail = scrubSecrets(tail(stderr), secrets);
        const detail =
          outputTail.length > 0
            ? `: ${outputTail}`
            : error.message
              ? `: ${scrubSecrets(error.message, secrets)}`
              : '';
        const message = timedOut
          ? `git ls-remote timed out after ${timeoutMs}ms`
          : `git ls-remote failed${error.code !== undefined ? ` (exit code ${String(error.code)})` : ''}${detail}`;
        reject(
          new GatewayError(ErrorCodes.UPSTREAM_ERROR, message, {
            cause: error,
            data: {
              status: 'UPSTREAM_ERROR',
              details: { url: scrubSecrets(url, secrets) },
            },
          }),
        );
      },
    );
  });

  const refs: RemoteRefs = { heads: {}, tags: {} };
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const commit = line.slice(0, tab).trim();
    const refName = line.slice(tab + 1).trim();
    if (!/^[0-9a-f]{7,64}$/i.test(commit)) continue;

    if (refName.startsWith('refs/heads/')) {
      refs.heads[refName.slice('refs/heads/'.length)] = commit;
      continue;
    }
    if (refName.startsWith('refs/tags/')) {
      const tagName = refName.slice('refs/tags/'.length);
      if (tagName.endsWith('^{}')) {
        // Annotated tag: the peeled line is the commit an update would check out.
        refs.tags[tagName.slice(0, -3)] = commit;
      } else if (refs.tags[tagName] === undefined) {
        refs.tags[tagName] = commit;
      }
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Semver tag selection
// ---------------------------------------------------------------------------

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemverTag(tag: string): ParsedSemver | null {
  if (typeof tag !== 'string') return null;
  const match = SEMVER_PATTERN.exec(tag.trim());
  if (match === null) return null;
  return {
    major: Number.parseInt(match[1] as string, 10),
    minor: Number.parseInt(match[2] as string, 10),
    patch: Number.parseInt(match[3] as string, 10),
    prerelease: match[4] === undefined ? [] : (match[4] as string).split('.'),
  };
}

export function isSemverTag(tag: string): boolean {
  return parseSemverTag(tag) !== null;
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  // A stable release sorts above any prerelease of the same core version.
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const diff = Number.parseInt(a, 10) - Number.parseInt(b, 10);
      if (diff !== 0) return diff;
      continue;
    }
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/** Semver comparison (numeric majors/minors/patch, then prerelease ordering). */
export function compareSemverTags(left: string, right: string): number {
  const a = parseSemverTag(left);
  const b = parseSemverTag(right);
  if (a === null || b === null) {
    throw new GatewayError(ErrorCodes.INVALID_PARAMS, 'Cannot compare non-semver tags', {
      data: { status: 'INVALID_PARAMS' },
    });
  }
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) return core;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Picks the highest semver tag (`v1.2.3` or `1.2.3`). Non-semver tags are
 * ignored; an empty/no-semver table returns null.
 */
export function pickLatestTag(tags: Record<string, string>): { tag: string; commit: string } | null {
  let best: { tag: string; commit: string } | null = null;
  for (const [tag, commit] of Object.entries(tags ?? {})) {
    if (typeof commit !== 'string' || commit.length === 0) continue;
    if (parseSemverTag(tag) === null) continue;
    if (best === null || compareSemverTags(tag, best.tag) > 0) {
      best = { tag, commit };
    }
  }
  return best;
}

/** Picks the most conventional default branch from a heads table. */
export function pickDefaultBranch(heads: Record<string, string>): string | null {
  const names = Object.keys(heads ?? {});
  if (names.length === 0) return null;
  for (const candidate of ['main', 'master', 'default', 'trunk']) {
    if (Object.prototype.hasOwnProperty.call(heads, candidate)) return candidate;
  }
  return names.length === 1 ? (names[0] as string) : null;
}

/**
 * Human-facing changelog URL.
 *
 *  - GitHub: `<repo>/compare/<from12>...<to12>` (or `/commits` when unknown).
 *  - Other http(s) remotes: `<repo>/releases`.
 *  - Local/ssh remotes: null (there is no browsable changelog).
 */
export function buildChangelogUrl(
  repoUrl: string | null | undefined,
  fromCommit: string | null | undefined,
  toCommit: string | null | undefined,
): string | null {
  if (typeof repoUrl !== 'string' || repoUrl.trim().length === 0) return null;
  const base = repoUrl.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const isGithub = /^https?:\/\/(?:www\.)?github\.com\//i.test(base);
  const isHttp = /^https?:\/\//i.test(base);
  if (!isHttp) return null;
  if (isGithub) {
    if (
      typeof fromCommit === 'string' &&
      typeof toCommit === 'string' &&
      fromCommit.length >= 7 &&
      toCommit.length >= 7
    ) {
      return `${base}/compare/${fromCommit.slice(0, 12)}...${toCommit.slice(0, 12)}`;
    }
    return `${base}/commits`;
  }
  return `${base}/releases`;
}

function tail(text: string, maxBytes = ERROR_TAIL_BYTES): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxBytes) return trimmed;
  return trimmed.slice(trimmed.length - maxBytes);
}
