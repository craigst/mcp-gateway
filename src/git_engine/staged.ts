/**
 * Staged update build: clone + detect + build a NEW working copy without
 * touching the live server directory.
 *
 * The caller (update service) only swaps directories after this function has
 * succeeded, so a failing build can never damage a running installation. On any
 * failure the staging directory is removed and a scrubbed `GatewayError` is
 * thrown; the live `server.workDir` is never read, written, or renamed here.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import type { GatewayConfig } from '../core/config.js';
import { ErrorCodes, GatewayError, invalidParams } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type { Logger } from '../core/logger.js';
import type { CatalogRepository, VaultService } from '../core/ports.js';
import type { RuntimeKind, ServerManifest, ServerRecord } from '../core/types.js';
import { detectManifest } from './autodetect.js';
import { BUILD_TIMEOUT_MS, runBuildCommand } from './build.js';
import {
  assertAllowedCloneUrl,
  assertSafeRef,
  cloneRepository,
  resolveGitHead,
  scrubSecrets,
} from './clone.js';
import { mapRuntime, splitCommand } from './manifest.js';
import { normalizeSubpath } from './service.js';

export interface StagedUpdateInput {
  config: GatewayConfig;
  /** Present for API symmetry; staged builds never mutate the catalog. */
  repository?: CatalogRepository;
  vault?: VaultService;
  /** The currently installed server whose upstream repository is being rebuilt. */
  server: ServerRecord;
  /** Branch/tag to build; defaults to the remote default branch. */
  ref?: string | null;
  /** Non-secret environment supplied by the caller (merged over manifest env). */
  env?: Record<string, string>;
  /**
   * Plaintext clone token for a private repository. Not part of the original
   * signature but required so staged updates of vault-backed sources work; it
   * never reaches argv or logs.
   */
  token?: string | null;
  logger?: Logger;
}

export interface StagedUpdate {
  /** Directory containing the (possibly subpath) manifest; becomes server.workDir. */
  workDir: string;
  /** Clone root (the directory that replaces the old repository root). */
  repoRoot: string;
  subpath: string | null;
  command: string;
  args: string[];
  manifest: ServerManifest;
  version: string | null;
  commit: string | null;
  runtime: RuntimeKind;
  /** Scrubbed build output tail (empty when the manifest has no build step). */
  buildLogTail: string[];
}

/**
 * Clones and builds a candidate version of `server`'s source into a temporary
 * directory under `${config.reposDir}/.update-${serverId}-${ts}`.
 *
 * The temp directory is returned via `repoRoot`/`workDir`; the caller owns it and
 * must either promote it into place or delete it.
 */
export async function stagedUpdateRepository(input: StagedUpdateInput): Promise<StagedUpdate> {
  const logger = input.logger ?? createLogger('git_engine', 'silent');
  const url = typeof input.server.sourceUrl === 'string' ? input.server.sourceUrl.trim() : '';
  if (url.length === 0) {
    throw invalidParams('Server has no tracked source URL to update from', {
      serverId: input.server.id,
    });
  }
  const allowedUrl = assertAllowedCloneUrl(url, input.config.gitImportAllowedPrefixes);
  const ref = assertSafeRef(input.ref ?? null);
  const subpath = deriveSubpath(input.server, input.config);
  const secrets: Array<string | null | undefined> = [input.token, ...Object.values(input.env ?? {})];

  const repoRoot = join(input.config.reposDir, `.update-${input.server.id}-${Date.now()}`);
  if (existsSync(repoRoot)) {
    throw new GatewayError(ErrorCodes.INTERNAL_ERROR, 'Staged update directory already exists', {
      httpStatus: 500,
      data: { status: 'INTERNAL_ERROR', details: { repoRoot } },
    });
  }
  mkdirSync(input.config.reposDir, { recursive: true });

  try {
    logger.info('staging server update', {
      serverId: input.server.id,
      repoUrl: allowedUrl,
      ref,
      subpath,
      private: typeof input.token === 'string' && input.token.length > 0,
    });
    await cloneRepository({ url: allowedUrl, targetDir: repoRoot, ref, token: input.token ?? null });

    const detected = detectManifest(repoRoot, subpath);
    const runtime = mapRuntime(detected.manifest.runtime);
    const workDir = subpath === null ? repoRoot : join(repoRoot, subpath);

    let buildLogTail: string[] = [];
    const buildCommand = detected.buildCommand;
    if (buildCommand !== null && buildCommand.trim().length > 0) {
      const env: Record<string, string> = {
        ...(detected.manifest.environment ?? {}),
        ...(input.env ?? {}),
      };
      const resolvedSecrets = input.vault?.resolveSecrets(detected.manifest.required_secrets ?? []) ?? {};
      Object.assign(env, resolvedSecrets);
      const buildSecrets = [...secrets, ...Object.values(resolvedSecrets)];
      const result = await runBuildCommand({
        commandLine: buildCommand,
        cwd: workDir,
        env,
        timeoutMs: BUILD_TIMEOUT_MS,
        secrets: buildSecrets,
      });
      buildLogTail = result.logTail;
    }

    const startCommand = detected.startCommand ?? detected.manifest.start_command;
    if (startCommand === undefined || startCommand.trim().length === 0) {
      throw invalidParams('Updated manifest does not define a usable start command', {
        serverId: input.server.id,
      });
    }
    const startTokens = splitCommand(startCommand);
    const command = startTokens[0];
    if (command === undefined) throw invalidParams('Start command is empty');

    return {
      workDir,
      repoRoot,
      subpath,
      command,
      args: startTokens.slice(1),
      manifest: detected.manifest,
      version: detected.manifest.version ?? null,
      commit: resolveGitHead(repoRoot),
      runtime,
      buildLogTail,
    };
  } catch (error) {
    cleanup(repoRoot, logger);
    if (error instanceof GatewayError) {
      throw scrubbedGatewayError(error, secrets);
    }
    const message = scrubSecrets(error instanceof Error ? error.message : String(error), secrets);
    throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, `Staged update failed: ${message}`, {
      cause: error,
      data: { status: 'UPSTREAM_ERROR', details: { serverId: input.server.id } },
    });
  }
}

/**
 * Derives the monorepo subpath of an installed server from its work directory.
 *
 * Imported repositories always live at `<reposDir>/<server.name>`; a server
 * installed with `subpath` has `workDir = <repoRoot>/<subpath>`. Anything else
 * (manual/remote installs) yields null and the clone root is used.
 */
export function deriveSubpath(server: ServerRecord, config: GatewayConfig): string | null {
  if (typeof server.workDir !== 'string' || server.workDir.length === 0) return null;
  const repoRoot = join(config.reposDir, server.name);
  const rel = relative(repoRoot, server.workDir).replace(/\\/g, '/');
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return null;
  try {
    return normalizeSubpath(rel);
  } catch {
    return null;
  }
}

function cleanup(dir: string, logger: Logger): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    logger.warn('failed to clean staged update directory', {
      dir,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Deep-scrubs token/env values from an error before it leaves the engine. */
export function scrubbedGatewayError(
  error: GatewayError,
  secrets: Array<string | null | undefined>,
): GatewayError {
  const message = scrubSecrets(error.message, secrets);
  let data = error.data;
  if (error.data !== undefined) {
    try {
      data = JSON.parse(scrubSecrets(JSON.stringify(error.data), secrets)) as GatewayError['data'];
    } catch {
      data = { status: error.data.status, reason: error.data.reason };
    }
  }
  if (message === error.message && data === error.data) return error;
  return new GatewayError(error.code, message, {
    data,
    httpStatus: error.httpStatus,
    cause: error.cause,
  });
}
