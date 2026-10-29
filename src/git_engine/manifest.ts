/**
 * `mcp-manifest.json` parsing/validation for the Git import engine.
 *
 * The manifest is untrusted input from a cloned repository. We validate every
 * field we act upon and reject unknown runtime identifiers rather than guessing.
 */
import { readFileSync } from 'node:fs';

import { ErrorCodes, GatewayError, invalidParams } from '../core/errors.js';
import type { RuntimeKind, ServerManifest } from '../core/types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidParams(`Manifest field "${field}" must be a non-empty string`);
  }
  return value;
}

function optionalNonEmptyString(field: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireNonEmptyString(field, value);
}

function validateStringArray(field: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw invalidParams(`Manifest field "${field}" must be an array of non-empty strings`);
  }
  return [...value];
}

/**
 * Map a manifest `runtime` identifier onto the gateway's runtime pool.
 *
 * Recognised forms: `node`, `node20`, `node22`, `nodejs`; `python`, `python3`,
 * `python3.12`; `binary`, `go`, `rust`, `c`, `cpp`, `native` (with optional
 * version suffixes). Anything else is rejected instead of being executed.
 */
export function mapRuntime(runtime: string): RuntimeKind {
  if (typeof runtime !== 'string' || runtime.trim().length === 0) {
    throw invalidParams('Manifest field "runtime" must be a non-empty string');
  }
  const kind = runtime.trim().toLowerCase();
  if (kind.startsWith('node')) return 'node';
  if (kind.startsWith('python')) return 'python';
  if (
    kind.startsWith('binary') ||
    kind.startsWith('go') ||
    kind.startsWith('rust') ||
    kind === 'c' ||
    kind === 'cpp' ||
    kind === 'c++' ||
    kind === 'native'
  ) {
    return 'binary';
  }
  throw invalidParams(`Unsupported manifest runtime "${runtime}"`, { runtime });
}

/**
 * Validate untrusted JSON as a `ServerManifest`.
 *
 * Required: non-empty `name`, `version`, `runtime`, and a start command
 * (`start_command` or the `command` alias). Optional fields are type-checked;
 * unknown top-level keys are preserved for forward compatibility.
 */
export function validateManifest(raw: unknown): ServerManifest {
  if (!isPlainObject(raw)) {
    throw invalidParams('Manifest must be a JSON object');
  }

  const name = requireNonEmptyString('name', raw.name);
  const version = requireNonEmptyString('version', raw.version);
  const runtime = requireNonEmptyString('runtime', raw.runtime);
  // Rejects unknown runtimes up front, before clone/build work can consume them.
  mapRuntime(runtime);

  const startCommand =
    optionalNonEmptyString('start_command', raw.start_command) ??
    optionalNonEmptyString('command', raw.command);
  if (startCommand === undefined) {
    throw invalidParams('Manifest must define "start_command" (or the legacy "command" alias)');
  }

  const buildCommand = optionalNonEmptyString('build_command', raw.build_command);

  let environment: Record<string, string> | undefined;
  if (raw.environment !== undefined && raw.environment !== null) {
    if (!isPlainObject(raw.environment)) {
      throw invalidParams('Manifest field "environment" must be an object of string values');
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.environment)) {
      if (typeof value !== 'string') {
        throw invalidParams(`Manifest environment variable "${key}" must be a string`);
      }
      env[key] = value;
    }
    environment = env;
  }

  let requiredSecrets: string[] | undefined;
  if (raw.required_secrets !== undefined && raw.required_secrets !== null) {
    requiredSecrets = validateStringArray('required_secrets', raw.required_secrets);
  }

  let capabilities: ServerManifest['capabilities'];
  if (raw.capabilities !== undefined && raw.capabilities !== null) {
    if (!isPlainObject(raw.capabilities)) {
      throw invalidParams('Manifest field "capabilities" must be an object');
    }
    const caps = raw.capabilities;
    if (caps.high_privilege_tools !== undefined) {
      validateStringArray('capabilities.high_privilege_tools', caps.high_privilege_tools);
    }
    if (caps.delegation_supported !== undefined && typeof caps.delegation_supported !== 'boolean') {
      throw invalidParams('Manifest field "capabilities.delegation_supported" must be a boolean');
    }
    capabilities = caps as ServerManifest['capabilities'];
  }

  const normalized: Record<string, unknown> = {
    ...raw,
    name,
    version,
    runtime,
    start_command: startCommand,
  };
  if (buildCommand !== undefined) normalized.build_command = buildCommand;
  if (environment !== undefined) normalized.environment = environment;
  if (requiredSecrets !== undefined) normalized.required_secrets = requiredSecrets;
  if (capabilities !== undefined) normalized.capabilities = capabilities;

  return normalized as ServerManifest;
}

/** Read and validate `<repo>/mcp-manifest.json`. */
export function parseManifestFile(filePath: string): ServerManifest {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new GatewayError(ErrorCodes.INVALID_PARAMS, `Unable to read manifest at ${filePath}`, {
      cause: error,
      httpStatus: 400,
      data: { status: 'INVALID_PARAMS', details: { path: filePath } },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new GatewayError(ErrorCodes.INVALID_PARAMS, `Invalid JSON in manifest at ${filePath}`, {
      cause: error,
      httpStatus: 400,
      data: { status: 'INVALID_PARAMS', details: { path: filePath } },
    });
  }

  return validateManifest(parsed);
}

/**
 * Shell-free command tokenizer: splits a command string into an argv array.
 *
 * Supports single quotes (literal), double quotes (with `\"` / `\\` escapes) and
 * backslash escaping outside quotes. No variable expansion, globbing, pipes or
 * redirection — the result is always passed to `spawn(..., { shell: false })`.
 */
export function splitCommand(command: string): string[] {
  if (typeof command !== 'string') {
    throw invalidParams('Command must be a string');
  }

  const tokens: string[] = [];
  let current = '';
  let tokenStarted = false;
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index);

    if (quote === null) {
      if (char === '"' || char === "'") {
        quote = char;
        tokenStarted = true;
      } else if (char === '\\') {
        const next = command.charAt(index + 1);
        if (next !== '') {
          current += next;
          tokenStarted = true;
          index += 1;
        }
      } else if (/\s/.test(char)) {
        if (tokenStarted) {
          tokens.push(current);
          current = '';
          tokenStarted = false;
        }
      } else {
        current += char;
        tokenStarted = true;
      }
      continue;
    }

    if (char === quote) {
      quote = null;
      continue;
    }

    if (quote === '"' && char === '\\') {
      const next = command.charAt(index + 1);
      if (next === '"' || next === '\\') {
        current += next;
        index += 1;
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (quote !== null) {
    throw invalidParams(
      `Unterminated ${quote === '"' ? 'double' : 'single'} quote in command`,
    );
  }

  if (tokenStarted) tokens.push(current);
  return tokens;
}
