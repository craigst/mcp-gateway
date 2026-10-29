/**
 * API key custody: issuance, hashing, verification, revocation and expiry.
 *
 * Security model (spec §5):
 *  - Keys are cryptographically random: `<type prefix>` + 32 random bytes (base64url).
 *  - Only a SHA-256 hash of `(pepper ?? '') + plaintext` is persisted; the plaintext is
 *    returned to the caller exactly once at issuance/import time.
 *  - Revocation and expiry are enforced on every authentication attempt.
 *  - Lookup is by hash, so a database leak does not yield usable keys and comparison
 *    is performed by the database index rather than a timing-sensitive string compare.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { boolToInt, intToBool, parseJson, toJson } from '../core/db.js';
import { invalidKey, invalidParams } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { KeyService } from '../core/ports.js';
import {
  KEY_PREFIX_BY_TYPE,
  KEY_TYPES,
  type ApiKeyRecord,
  type AuthenticatedKey,
  type CreateKeyInput,
  type IssuedKey,
  type KeyType,
  type ServerGrant,
  type ToolGuardrail,
  type UpdateKeyInput,
} from '../core/types.js';

export interface KeyServiceOptions {
  /** Optional HMAC-style pepper mixed into hashes (`MCP_KEY_PEPPER`). */
  pepper?: string | null;
  logger?: Logger;
}

interface ApiKeyRow {
  id: string;
  name: string;
  key_type: string;
  key_hash: string;
  key_prefix: string;
  server_grants: string;
  delegation_allowed: number;
  escalation_allowed: number;
  expires_at: string | null;
  revoked_at: string | null;
  paused_at: string | null;
  created_at: string;
  last_used_at: string | null;
  metadata: string;
}

function mapKeyRow(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    keyType: row.key_type as KeyType,
    keyHash: row.key_hash,
    keyPrefix: row.key_prefix,
    serverGrants: parseJson<ServerGrant[]>(row.server_grants, []),
    delegationAllowed: intToBool(row.delegation_allowed),
    escalationAllowed: intToBool(row.escalation_allowed),
    expiresAt: row.expires_at ?? null,
    revokedAt: row.revoked_at ?? null,
    pausedAt: row.paused_at ?? null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
  };
}

/** Drop the stored hash and (when available) attach the presented plaintext. */
function toAuthenticatedKey(record: ApiKeyRecord, plaintext?: string): AuthenticatedKey {
  const key: AuthenticatedKey = {
    id: record.id,
    name: record.name,
    keyType: record.keyType,
    keyPrefix: record.keyPrefix,
    serverGrants: record.serverGrants,
    delegationAllowed: record.delegationAllowed,
    escalationAllowed: record.escalationAllowed,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    pausedAt: record.pausedAt,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    metadata: record.metadata,
  };
  if (plaintext !== undefined) key.plaintext = plaintext;
  return key;
}

function validateName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw invalidParams('Key name is required.');
  }
  return raw.trim();
}

function validateKeyType(raw: unknown): KeyType {
  if (typeof raw !== 'string' || !(KEY_TYPES as readonly string[]).includes(raw)) {
    throw invalidParams(`Invalid key type. Expected one of: ${KEY_TYPES.join(', ')}.`);
  }
  return raw as KeyType;
}

function validateStringArray(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) throw invalidParams(`${label} must be an array of tool identifiers.`);
  const values: string[] = [];
  const seen = new Set<string>();
  raw.forEach((value, index) => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw invalidParams(`${label}[${index}] must be a non-empty string.`);
    }
    const normalized = value.trim();
    if (seen.has(normalized)) {
      throw invalidParams(`${label}[${index}] duplicates '${normalized}'.`);
    }
    seen.add(normalized);
    values.push(normalized);
  });
  return values;
}

function validateGuardrails(raw: unknown, label: string): ToolGuardrail[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw invalidParams(`${label} must be an array of guardrail rules.`);
  return raw.map((rule, index) => {
    const where = `${label}[${index}]`;
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      throw invalidParams(`${where} must be a guardrail object.`);
    }
    const candidate = rule as ToolGuardrail;
    if (
      candidate.kind !== 'regex_applied_to_arguments' &&
      candidate.kind !== 'json_schema'
    ) {
      throw invalidParams(`${where}.kind must be 'regex_applied_to_arguments' or 'json_schema'.`);
    }
    if (candidate.kind === 'regex_applied_to_arguments') {
      if (typeof candidate.pattern !== 'string' || candidate.pattern === '') {
        throw invalidParams(`${where}.pattern is required for regex guardrails.`);
      }
      try {
        // Reject unparseable patterns at configuration time rather than at call time.
        new RegExp(candidate.pattern, candidate.flags ?? 'i');
      } catch {
        throw invalidParams(`${where}.pattern is not a valid regular expression.`);
      }
    }
    if (candidate.kind === 'json_schema') {
      if (
        candidate.schema === undefined ||
        candidate.schema === null ||
        typeof candidate.schema !== 'object' ||
        Array.isArray(candidate.schema)
      ) {
        throw invalidParams(`${where}.schema is required for json_schema guardrails.`);
      }
    }
    if (candidate.flags !== undefined && typeof candidate.flags !== 'string') {
      throw invalidParams(`${where}.flags must be a string.`);
    }
    if (candidate.mustMatch !== undefined && typeof candidate.mustMatch !== 'boolean') {
      throw invalidParams(`${where}.mustMatch must be a boolean.`);
    }
    if (candidate.message !== undefined && typeof candidate.message !== 'string') {
      throw invalidParams(`${where}.message must be a string.`);
    }
    if (
      candidate.tool !== undefined &&
      candidate.tool !== null &&
      typeof candidate.tool !== 'string'
    ) {
      throw invalidParams(`${where}.tool must be a string or null.`);
    }
    return {
      tool: candidate.tool ?? null,
      kind: candidate.kind,
      pattern: candidate.pattern,
      flags: candidate.flags,
      mustMatch: candidate.mustMatch,
      schema: candidate.schema,
      message: candidate.message,
    };
  });
}

function validateServerGrants(raw: unknown): ServerGrant[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw invalidParams('serverGrants must be an array.');
  const seenServerIds = new Set<string>();
  return raw.map((grant, index) => {
    const where = `serverGrants[${index}]`;
    if (grant === null || typeof grant !== 'object' || Array.isArray(grant)) {
      throw invalidParams(`${where} must be an object.`);
    }
    const candidate = grant as ServerGrant;
    if (typeof candidate.serverId !== 'string' || candidate.serverId.trim() === '') {
      throw invalidParams(`${where}.serverId is required.`);
    }
    const serverId = candidate.serverId.trim();
    if (seenServerIds.has(serverId)) {
      throw invalidParams(`${where}.serverId '${serverId}' is duplicated.`);
    }
    seenServerIds.add(serverId);
    if (candidate.paused !== undefined && typeof candidate.paused !== 'boolean') {
      throw invalidParams(`${where}.paused must be a boolean.`);
    }
    const tools =
      candidate.tools === undefined || candidate.tools === null
        ? null
        : validateStringArray(candidate.tools, `${where}.tools`);
    const highPrivilegeTools =
      candidate.highPrivilegeTools === undefined || candidate.highPrivilegeTools === null
        ? null
        : validateStringArray(candidate.highPrivilegeTools, `${where}.highPrivilegeTools`);
    const pausedTools =
      candidate.pausedTools === undefined || candidate.pausedTools === null
        ? null
        : validateStringArray(candidate.pausedTools, `${where}.pausedTools`);
    return {
      serverId,
      tools,
      highPrivilegeTools,
      guardrails: validateGuardrails(candidate.guardrails, `${where}.guardrails`),
      ...(candidate.paused === true ? { paused: true } : {}),
      pausedTools,
    };
  });
}

function validateMetadata(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidParams('metadata must be an object.');
  }
  return raw as Record<string, unknown>;
}

function resolveExpiry(input: CreateKeyInput, now: Date): string | null {
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    if (typeof input.expiresAt !== 'string' || Number.isNaN(Date.parse(input.expiresAt))) {
      throw invalidParams('expiresAt must be a valid ISO-8601 timestamp.');
    }
    return new Date(input.expiresAt).toISOString();
  }
  if (input.expiresInSeconds !== undefined && input.expiresInSeconds !== null) {
    if (typeof input.expiresInSeconds !== 'number' || !Number.isFinite(input.expiresInSeconds)) {
      throw invalidParams('expiresInSeconds must be a finite number.');
    }
    // 0 or negative durations intentionally produce an already-expired key.
    return new Date(now.getTime() + input.expiresInSeconds * 1000).toISOString();
  }
  return null;
}

export class SqliteKeyService implements KeyService {
  private readonly db: DatabaseSync;
  private readonly pepper: string;
  private readonly logger: Logger;

  constructor(db: DatabaseSync, options: KeyServiceOptions = {}) {
    this.db = db;
    this.pepper = options.pepper ?? '';
    this.logger = options.logger ?? createLogger('rbac');
  }

  private hash(plaintext: string): string {
    return createHash('sha256')
      .update(`${this.pepper}${plaintext}`)
      .digest('hex');
  }

  private findByHash(keyHash: string): ApiKeyRecord | null {
    const row = this.db
      .prepare('SELECT * FROM api_keys WHERE key_hash = ?')
      .get(keyHash) as unknown as ApiKeyRow | undefined;
    return row ? mapKeyRow(row) : null;
  }

  private insert(input: {
    name: string;
    keyType: KeyType;
    plaintext: string;
    serverGrants: ServerGrant[];
    delegationAllowed: boolean;
    escalationAllowed: boolean;
    expiresAt: string | null;
    metadata: Record<string, unknown>;
  }): ApiKeyRecord {
    const createdAt = nowIso();
    const record: ApiKeyRecord = {
      id: newId('key'),
      name: input.name,
      keyType: input.keyType,
      keyHash: this.hash(input.plaintext),
      keyPrefix: input.plaintext.slice(0, 12),
      serverGrants: input.serverGrants,
      delegationAllowed: input.delegationAllowed,
      escalationAllowed: input.escalationAllowed,
      expiresAt: input.expiresAt,
      revokedAt: null,
      pausedAt: null,
      createdAt,
      lastUsedAt: null,
      metadata: input.metadata,
    };
    this.db
      .prepare(
        `INSERT INTO api_keys
           (id, name, key_type, key_hash, key_prefix, server_grants, delegation_allowed,
            escalation_allowed, expires_at, revoked_at, created_at, last_used_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.keyType,
        record.keyHash,
        record.keyPrefix,
        toJson(record.serverGrants),
        boolToInt(record.delegationAllowed),
        boolToInt(record.escalationAllowed),
        record.expiresAt,
        record.revokedAt,
        record.createdAt,
        record.lastUsedAt,
        toJson(record.metadata),
      );
    return record;
  }

  issue(input: CreateKeyInput): IssuedKey {
    const name = validateName(input.name);
    const keyType = validateKeyType(input.keyType);
    const serverGrants = validateServerGrants(input.serverGrants);
    const metadata = validateMetadata(input.metadata);
    const expiresAt = resolveExpiry(input, new Date());
    const plaintext = `${KEY_PREFIX_BY_TYPE[keyType]}${randomBytes(32).toString('base64url')}`;
    const record = this.insert({
      name,
      keyType,
      plaintext,
      serverGrants,
      delegationAllowed: input.delegationAllowed === true,
      escalationAllowed: input.escalationAllowed === true,
      expiresAt,
      metadata,
    });
    this.logger.info('api key issued', {
      keyId: record.id,
      keyType: record.keyType,
      keyPrefix: record.keyPrefix,
    });
    return { key: toAuthenticatedKey(record), plaintext };
  }

  importKey(plaintext: string, input: CreateKeyInput): ApiKeyRecord {
    if (typeof plaintext !== 'string' || plaintext.trim() === '') {
      throw invalidParams('The plaintext key to import is required.');
    }
    const name = validateName(input.name);
    const keyType = validateKeyType(input.keyType);
    const expectedPrefix = KEY_PREFIX_BY_TYPE[keyType];
    if (!plaintext.startsWith(expectedPrefix) || plaintext.length <= expectedPrefix.length) {
      throw invalidParams(`Imported key must start with the ${keyType} prefix '${expectedPrefix}'.`);
    }
    if (this.findByHash(this.hash(plaintext)) !== null) {
      throw invalidParams('An API key with this hash already exists.');
    }
    const record = this.insert({
      name,
      keyType,
      plaintext,
      serverGrants: validateServerGrants(input.serverGrants),
      delegationAllowed: input.delegationAllowed === true,
      escalationAllowed: input.escalationAllowed === true,
      expiresAt: resolveExpiry(input, new Date()),
      metadata: validateMetadata(input.metadata),
    });
    this.logger.info('api key imported', { keyId: record.id, keyType: record.keyType });
    return record;
  }

  authenticate(plaintextKey: string): AuthenticatedKey {
    if (typeof plaintextKey !== 'string' || plaintextKey === '') {
      throw invalidKey('INVALID_API_KEY');
    }
    const record = this.findByHash(this.hash(plaintextKey));
    if (!record) throw invalidKey('INVALID_API_KEY');
    if (record.revokedAt !== null) throw invalidKey('KEY_REVOKED');
    if (record.expiresAt !== null && Date.parse(record.expiresAt) <= Date.now()) {
      throw invalidKey('KEY_EXPIRED');
    }
    const lastUsedAt = nowIso();
    this.db
      .prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
      .run(lastUsedAt, record.id);
    return toAuthenticatedKey({ ...record, lastUsedAt }, plaintextKey);
  }

  get(id: string): ApiKeyRecord | null {
    const row = this.db
      .prepare('SELECT * FROM api_keys WHERE id = ?')
      .get(id) as unknown as ApiKeyRow | undefined;
    return row ? mapKeyRow(row) : null;
  }

  list(): ApiKeyRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM api_keys ORDER BY created_at ASC, id ASC')
      .all() as unknown as ApiKeyRow[];
    return rows.map(mapKeyRow);
  }

  revoke(id: string): ApiKeyRecord {
    const record = this.get(id);
    if (!record) throw invalidParams(`API key '${id}' was not found.`);
    // Idempotent: re-revoking keeps the original revocation timestamp.
    const revokedAt = record.revokedAt ?? nowIso();
    this.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(revokedAt, id);
    this.logger.warn('api key revoked', { keyId: id });
    return { ...record, revokedAt };
  }

  update(id: string, input: UpdateKeyInput): ApiKeyRecord {
    const record = this.get(id);
    if (!record) throw invalidParams(`API key '${id}' was not found.`);
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw invalidParams('Key update body must be an object.');
    }

    let name = record.name;
    if (input.name !== undefined) {
      if (typeof input.name !== 'string') throw invalidParams('name must be a string.');
      const trimmed = input.name.trim();
      if (trimmed === '') throw invalidParams('Key name is required.');
      if (trimmed.length > 120) throw invalidParams('Key name must be at most 120 characters.');
      name = trimmed;
    }

    let pausedAt = record.pausedAt;
    if (input.paused !== undefined) {
      if (typeof input.paused !== 'boolean') throw invalidParams('paused must be a boolean.');
      // Idempotent: pausing an already-paused key keeps the original timestamp.
      pausedAt = input.paused ? (record.pausedAt ?? nowIso()) : null;
    }

    const serverGrants =
      input.serverGrants === undefined ? record.serverGrants : validateServerGrants(input.serverGrants);

    let expiresAt = record.expiresAt;
    if (input.expiresAt !== undefined) {
      if (input.expiresAt === null) {
        expiresAt = null;
      } else if (typeof input.expiresAt !== 'string' || Number.isNaN(Date.parse(input.expiresAt))) {
        throw invalidParams('expiresAt must be a valid ISO-8601 timestamp or null.');
      } else {
        expiresAt = new Date(input.expiresAt).toISOString();
      }
    }

    this.db
      .prepare(
        'UPDATE api_keys SET name = ?, server_grants = ?, expires_at = ?, paused_at = ? WHERE id = ?',
      )
      .run(name, toJson(serverGrants), expiresAt, pausedAt, id);

    this.logger.info('api key updated', { keyId: id, paused: pausedAt !== null });
    return { ...record, name, serverGrants, expiresAt, pausedAt };
  }

  pause(id: string): ApiKeyRecord {
    const record = this.get(id);
    if (!record) throw invalidParams(`API key '${id}' was not found.`);
    const pausedAt = record.pausedAt ?? nowIso();
    if (record.pausedAt === null) {
      this.db.prepare('UPDATE api_keys SET paused_at = ? WHERE id = ?').run(pausedAt, id);
      this.logger.warn('api key paused', { keyId: id });
    }
    return { ...record, pausedAt };
  }

  resume(id: string): ApiKeyRecord {
    const record = this.get(id);
    if (!record) throw invalidParams(`API key '${id}' was not found.`);
    if (record.pausedAt !== null) {
      this.db.prepare('UPDATE api_keys SET paused_at = NULL WHERE id = ?').run(id);
      this.logger.info('api key resumed', { keyId: id });
    }
    return { ...record, pausedAt: null };
  }

  purgeExpired(now: Date = new Date()): number {
    const result = this.db
      .prepare('DELETE FROM api_keys WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .run(now.toISOString());
    const removed = Number(result.changes);
    if (removed > 0) this.logger.info('expired api keys purged', { removed });
    return removed;
  }
}
