/**
 * Reusable configuration/credential profiles (v0.4).
 *
 * A profile is a named reference set for sub-server environment variables and HTTP
 * headers. Values are NEVER stored in SQLite:
 *   - `value`     input  -> encrypted into the gateway AES vault immediately
 *                            (`PROFILE_<id>_ENV_<KEY>` / `PROFILE_<id>_HEADER_<KEY>`)
 *   - `secretRef` input  -> reference to an existing named vault secret
 *   - `credentialRef`    -> reference to an external password-manager item
 *                            (Vaultwarden/1Password). Metadata only: no vault write;
 *                            returned by `resolveForServer` for the supervisor to
 *                            resolve at process start.
 *
 * Profiles are attached to servers via `servers.config_profile_ids` and resolved at
 * process start through the supervisor's profile resolver hook. Merge precedence:
 * attached profiles in order (later overrides earlier) < server-specific env/headers.
 */
import type { DatabaseSync } from 'node:sqlite';

import { ErrorCodes, GatewayError, invalidParams } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { createLogger, type Logger } from '../core/logger.js';
import type {
  CatalogRepository,
  ConfigProfileService,
  Supervisor,
  VaultService,
} from '../core/ports.js';
import type {
  ConfigProfile,
  ConfigProfileApplyResult,
  ConfigProfileInput,
  ConfigProfileInputValue,
  ConfigProfileSummary,
  ConfigProfileValue,
  CredentialProviderId,
  CredentialRef,
  InstallTestResult,
  ServerStatus,
} from '../core/types.js';
import { readEnvFile } from '../gateway/supervisor.js';
import { VAULT_SECRET_NAME_PATTERN } from '../vault/store.js';
import { SqliteConfigProfileStore, type NewConfigProfileRecord, type StoredConfigProfile } from './store.js';

export interface ConfigProfileServiceDeps {
  db: DatabaseSync;
  repository: CatalogRepository;
  vault: VaultService;
  supervisor: Supervisor;
  logger?: Logger;
}

const MAX_PROFILE_NAME_LENGTH = 64;
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** RFC 7230 token characters allowed in an HTTP header name. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const MAX_VAULT_SECRET_NAME_LENGTH = 64;
const CREDENTIAL_PROVIDER_IDS: readonly CredentialProviderId[] = [
  'vaultwarden',
  'onepassword',
  'gateway',
];

function isValidCredentialProvider(value: unknown): value is CredentialProviderId {
  return typeof value === 'string' && (CREDENTIAL_PROVIDER_IDS as readonly string[]).includes(value);
}

interface NormalisedCredentialRef {
  provider: CredentialProviderId;
  itemId: string;
  /** Optional field inside the credential item; null when the item itself is the secret. */
  field: string | null;
}

interface NormalisedValue {
  key: string;
  value?: string;
  secretRef?: string;
  credentialRef?: NormalisedCredentialRef;
  /** Update-only: keep the existing encrypted/vault-ref/credential-ref value for this key. */
  keep?: true;
}

interface NormalisedInput {
  name: string;
  description: string | null;
  entries: NormalisedValue[];
  headers: NormalisedValue[];
}

interface EntryPlan {
  values: ConfigProfileValue[];
  /** Plaintext values to encrypt, in order. */
  writes: Array<{ name: string; value: string }>;
}

function vaultRequiredError(): GatewayError {
  return new GatewayError(
    ErrorCodes.NOT_IMPLEMENTED,
    'Vault is not configured; configuration profile values must be encrypted in the vault',
  );
}

function profileNotFound(id: string): GatewayError {
  return new GatewayError(ErrorCodes.TOOL_NOT_FOUND, `Configuration profile '${id}' was not found`, {
    httpStatus: 404,
  });
}

function serverNotFound(id: string): GatewayError {
  return new GatewayError(ErrorCodes.TOOL_NOT_FOUND, `Server '${id}' was not found`, {
    httpStatus: 404,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateProfileName(raw: unknown): string {
  if (typeof raw !== 'string') throw invalidParams('Configuration profile name is required');
  const name = raw.trim();
  if (name === '') throw invalidParams('Configuration profile name is required');
  if (name.length > MAX_PROFILE_NAME_LENGTH) {
    throw invalidParams(`Configuration profile name must be at most ${MAX_PROFILE_NAME_LENGTH} characters`);
  }
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw invalidParams(
      'Configuration profile name may only contain letters, digits, spaces, dots, underscores and dashes',
    );
  }
  return name;
}

function validateDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw invalidParams('Configuration profile description must be a string');
  const description = raw.trim();
  return description === '' ? null : description;
}

function validateCredentialRef(raw: unknown, key: string): NormalisedCredentialRef {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidParams(`Entry '${key}' credentialRef must be an object`);
  }
  const record = raw as Record<string, unknown>;
  if (!isValidCredentialProvider(record.provider)) {
    throw invalidParams(
      `Entry '${key}' credentialRef provider must be one of ${CREDENTIAL_PROVIDER_IDS.join(', ')}`,
    );
  }
  const itemId = typeof record.itemId === 'string' ? record.itemId.trim() : '';
  if (itemId === '') {
    throw invalidParams(`Entry '${key}' credentialRef itemId must be a non-empty string`);
  }
  let field: string | null = null;
  if (record.field !== undefined && record.field !== null) {
    if (typeof record.field !== 'string') {
      throw invalidParams(`Entry '${key}' credentialRef field must be a string or null`);
    }
    const trimmed = record.field.trim();
    field = trimmed === '' ? null : trimmed;
  }
  return { provider: record.provider, itemId, field };
}

function validateValueList(raw: unknown, kind: 'env' | 'header', allowKeep = false): NormalisedValue[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw invalidParams(`Configuration profile ${kind === 'env' ? 'entries' : 'headers'} must be an array`);
  }
  const values: NormalisedValue[] = [];
  const seenKeys = new Set<string>();
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw invalidParams('Configuration profile entries must be objects');
    }
    const record = item as ConfigProfileInputValue;
    const key = typeof record.key === 'string' ? record.key.trim() : '';
    if (kind === 'env') {
      if (!ENV_KEY_PATTERN.test(key)) {
        throw invalidParams(`Invalid environment variable name '${key}'`);
      }
    } else if (!HEADER_NAME_PATTERN.test(key)) {
      throw invalidParams(`Invalid HTTP header name '${key}'`);
    }
    // Names map to uppercase vault secret names, so duplicates differing only by
    // case would collide.
    if (seenKeys.has(key.toLowerCase())) {
      throw invalidParams(`Duplicate ${kind === 'env' ? 'environment variable' : 'header'} '${key}'`);
    }
    seenKeys.add(key.toLowerCase());

    const hasValue = Object.prototype.hasOwnProperty.call(item, 'value');
    const hasSecretRef = Object.prototype.hasOwnProperty.call(item, 'secretRef');
    const hasCredentialRef = Object.prototype.hasOwnProperty.call(item, 'credentialRef');
    const provided = [hasValue, hasSecretRef, hasCredentialRef].filter(Boolean).length;
    if (provided > 1) {
      throw invalidParams(
        `Entry '${key}' must use exactly one of "value", "secretRef" or "credentialRef"`,
      );
    }
    if (provided === 0) {
      if (!allowKeep) {
        throw invalidParams(`Entry '${key}' must provide a "value", "secretRef" or "credentialRef"`);
      }
      values.push({ key, keep: true });
      continue;
    }
    if (hasCredentialRef) {
      values.push({ key, credentialRef: validateCredentialRef(record.credentialRef, key) });
      continue;
    }
    if (hasValue) {
      if (typeof record.value !== 'string') {
        throw invalidParams(`Entry '${key}' value must be a string`);
      }
      if (record.value.includes('\0')) {
        throw invalidParams(`Entry '${key}' value must not contain NUL bytes`);
      }
      if (kind === 'header' && /[\r\n]/.test(record.value)) {
        throw invalidParams(`Header '${key}' value must not contain line breaks`);
      }
      values.push({ key, value: record.value });
      continue;
    }
    if (typeof record.secretRef !== 'string' || record.secretRef.trim() === '') {
      throw invalidParams(`Entry '${key}' secretRef must be a non-empty string`);
    }
    values.push({ key, secretRef: record.secretRef.trim() });
  }
  return values;
}

function normaliseInput(input: ConfigProfileInput, allowKeep = false): NormalisedInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidParams('Configuration profile body must be an object');
  }
  return {
    name: validateProfileName(input.name),
    description: validateDescription(input.description),
    entries: validateValueList(input.entries, 'env', allowKeep),
    headers: validateValueList(input.headers, 'header', allowKeep),
  };
}

/**
 * Vault secret names only allow [A-Za-z0-9_], so header punctuation (e.g. "-")
 * is folded to "_". Collisions created by that folding are rejected per profile.
 */
function vaultKeySegment(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

/** Vault secret name for a profile-owned env value. */
export function profileEnvSecretName(profileId: string, key: string): string {
  return `PROFILE_${profileId.toUpperCase()}_ENV_${vaultKeySegment(key)}`;
}

/** Vault secret name for a profile-owned header value. */
export function profileHeaderSecretName(profileId: string, key: string): string {
  return `PROFILE_${profileId.toUpperCase()}_HEADER_${vaultKeySegment(key)}`;
}

function assertVaultSecretName(name: string, key: string, kind: 'env' | 'header'): void {
  if (name.length > MAX_VAULT_SECRET_NAME_LENGTH || !VAULT_SECRET_NAME_PATTERN.test(name)) {
    throw invalidParams(
      `${kind === 'env' ? 'Environment variable' : 'Header'} '${key}' is too long to map to an encrypted profile secret name`,
    );
  }
}

export class DefaultConfigProfileService implements ConfigProfileService {
  private readonly store: SqliteConfigProfileStore;
  private readonly repository: CatalogRepository;
  private readonly vault: VaultService;
  private readonly supervisor: Supervisor;
  private readonly logger: Logger;

  constructor(deps: ConfigProfileServiceDeps) {
    this.store = new SqliteConfigProfileStore(deps.db);
    this.repository = deps.repository;
    this.vault = deps.vault;
    this.supervisor = deps.supervisor;
    this.logger = deps.logger ?? createLogger('config-profiles');
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  list(): ConfigProfileSummary[] {
    return this.store.list().map((profile) => this.toSummary(profile));
  }

  get(id: string): ConfigProfileSummary | null {
    const profile = this.store.get(id);
    return profile ? this.toSummary(profile) : null;
  }

  profileIdsForServer(serverId: string): string[] {
    return this.store.profileIdsForServer(serverId);
  }

  /**
   * Resolve every attached profile for a server.
   *
   * Encrypted/vault-ref entries are decrypted into `env`/`headers` as before.
   * External password-manager entries are not fetched here: they are returned as
   * `credentialRefs` so the supervisor can resolve them through the credential
   * provider service at process start. Throws a clear GatewayError when the vault
   * is disabled or an encrypted/vault-ref value is missing.
   */
  resolveForServer(serverId: string): {
    env: Record<string, string>;
    headers: Record<string, string>;
    credentialRefs: CredentialRef[];
  } {
    const profileIds = this.store.profileIdsForServer(serverId);
    const env: Record<string, string> = {};
    const headers: Record<string, string> = {};
    const credentialRefs = new Map<string, CredentialRef>();

    for (const profileId of profileIds) {
      const profile = this.store.getStored(profileId);
      if (!profile) {
        this.logger.warn('attached configuration profile is missing', { serverId, profileId });
        continue;
      }
      for (const entry of profile.entries) {
        this.resolveEntryInto(profile, entry, 'env', env, headers, credentialRefs);
      }
      for (const entry of profile.headers) {
        this.resolveEntryInto(profile, entry, 'header', env, headers, credentialRefs);
      }
    }

    return { env, headers, credentialRefs: [...credentialRefs.values()] };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async create(input: ConfigProfileInput): Promise<ConfigProfileSummary> {
    const normalised = normaliseInput(input);
    this.assertNameAvailable(normalised.name);

    const id = newId('cfg');
    const owned: string[] = [];
    try {
      const entriesPlan = this.planValues(id, normalised.entries, 'env');
      const headersPlan = this.planValues(id, normalised.headers, 'header');
      this.writePlan(entriesPlan, owned);
      this.writePlan(headersPlan, owned);
      const record: NewConfigProfileRecord = {
        id,
        name: normalised.name,
        description: normalised.description,
        entries: entriesPlan.values,
        headers: headersPlan.values,
        ownedSecretNames: owned,
      };
      this.store.insert(record);
    } catch (error) {
      this.cleanupSecrets(owned);
      throw error;
    }

    this.logger.info('configuration profile created', {
      profileId: id,
      name: normalised.name,
      entryCount: normalised.entries.length,
      headerCount: normalised.headers.length,
    });
    const created = this.get(id);
    if (!created) throw new Error(`Configuration profile '${id}' disappeared after creation`);
    return created;
  }

  async update(id: string, input: ConfigProfileInput): Promise<ConfigProfileSummary> {
    const existing = this.store.getStored(id);
    if (!existing) throw profileNotFound(id);
    const normalised = this.materialiseKeptValues(normaliseInput(input, true), existing);
    this.assertNameAvailable(normalised.name, id);

    const previousOwned = existing.ownedSecretNames;
    const owned: string[] = [];
    try {
      // Validate both lists before writing anything so a rejected header cannot
      // rotate env values that the old profile row still points at.
      const entriesPlan = this.planValues(id, normalised.entries, 'env');
      const headersPlan = this.planValues(id, normalised.headers, 'header');
      this.writePlan(entriesPlan, owned);
      this.writePlan(headersPlan, owned);
      this.store.replace({
        id,
        name: normalised.name,
        description: normalised.description,
        entries: entriesPlan.values,
        headers: headersPlan.values,
        ownedSecretNames: owned,
      });
    } catch (error) {
      // Only brand-new secret names are safe to remove; existing names may still
      // back the not-yet-updated profile row.
      this.cleanupSecrets(owned.filter((name) => !previousOwned.includes(name)));
      throw error;
    }

    // Remove vault entries this profile used to own but no longer does.
    const stale = previousOwned.filter((name) => !owned.includes(name));
    for (const name of stale) {
      try {
        this.vault.deleteSecret(name);
      } catch (error) {
        this.logger.warn('failed to delete stale profile secret', {
          profileId: id,
          secret: name,
          error: errorMessage(error),
        });
      }
    }

    this.logger.info('configuration profile updated', {
      profileId: id,
      name: normalised.name,
      removedSecrets: stale.length,
    });
    const updated = this.get(id);
    if (!updated) throw new Error(`Configuration profile '${id}' disappeared after update`);
    return updated;
  }

  remove(id: string): void {
    const existing = this.store.getStored(id);
    if (!existing) throw profileNotFound(id);

    this.store.remove(id);
    const detached = this.store.detachProfileFromAllServers(id);
    for (const name of existing.ownedSecretNames) {
      try {
        this.vault.deleteSecret(name);
      } catch (error) {
        this.logger.warn('failed to delete profile secret during removal', {
          profileId: id,
          secret: name,
          error: errorMessage(error),
        });
      }
    }
    this.logger.info('configuration profile removed', {
      profileId: id,
      name: existing.name,
      detachedServers: detached,
    });
  }

  // -------------------------------------------------------------------------
  // Server attachment / application
  // -------------------------------------------------------------------------

  async apply(
    profileIds: string[],
    serverIds: string[],
    options: { restart?: boolean; test?: boolean } = {},
  ): Promise<ConfigProfileApplyResult[]> {
    const ids = this.requireIdArray(profileIds, 'profileIds');
    const servers = this.requireIdArray(serverIds, 'serverIds');
    for (const profileId of ids) {
      if (!this.store.getStored(profileId)) throw profileNotFound(profileId);
    }

    const restart = options.restart !== false;
    const probe = options.test === true;
    const mustRestart = restart || probe;
    const results: ConfigProfileApplyResult[] = [];

    for (const serverId of servers) {
      const existing = this.repository.getServer(serverId);
      if (!existing) {
        results.push({
          serverId,
          serverName: serverId,
          applied: false,
          restarted: false,
          test: null,
          error: `Unknown server '${serverId}'`,
        });
        continue;
      }

      let applied = false;
      let restarted = false;
      let test: InstallTestResult | null = null;
      let error: string | null = null;
      try {
        const current = this.store.profileIdsForServer(serverId);
        const union = [...current, ...ids.filter((profileId) => !current.includes(profileId))];
        this.store.setProfileIdsForServer(serverId, union);
        applied = true;

        if (mustRestart) {
          const status: ServerStatus = this.supervisor.status(serverId);
          if (status === 'stopped' || status === 'failed') {
            await this.supervisor.start(serverId);
          } else {
            await this.supervisor.restart(serverId);
          }
          restarted = true;
        }

        if (probe) {
          test = await this.probeServer(serverId);
          if (!test.ok) error = test.error;
        }
      } catch (caught) {
        error = errorMessage(caught);
        this.logger.warn('configuration profile apply failed for server', { serverId, error });
      }

      results.push({ serverId, serverName: existing.name, applied, restarted, test, error });
    }

    this.logger.info('configuration profiles applied', {
      profileIds: ids,
      serverCount: servers.length,
      okCount: results.filter((result) => result.error === null).length,
    });
    return results;
  }

  detach(profileId: string, serverId: string): void {
    if (!this.store.getStored(profileId)) throw profileNotFound(profileId);
    if (!this.repository.getServer(serverId)) throw serverNotFound(serverId);
    const current = this.store.profileIdsForServer(serverId);
    this.store.setProfileIdsForServer(
      serverId,
      current.filter((id) => id !== profileId),
    );
    this.logger.info('configuration profile detached', { profileId, serverId });
  }

  // -------------------------------------------------------------------------
  // Env-file migration (legacy servers)
  // -------------------------------------------------------------------------

  async migrateEnvFile(serverId: string, name?: string): Promise<ConfigProfileSummary> {
    const server = this.repository.getServer(serverId);
    if (!server) throw serverNotFound(serverId);
    const envFile = typeof server.envFile === 'string' ? server.envFile.trim() : '';
    if (envFile === '') {
      throw invalidParams(`Server '${server.name}' has no legacy env file to migrate`);
    }
    if (!this.vault.isEnabled()) throw vaultRequiredError();

    // Read the file once; values are encrypted below and never persisted in clear.
    const values = readEnvFile(envFile);
    const keys = Object.keys(values);
    if (keys.length === 0) {
      throw invalidParams(`Legacy env file for server '${server.name}' contains no KEY=VALUE entries`);
    }

    const requestedName = typeof name === 'string' && name.trim() !== '' ? validateProfileName(name) : null;
    const profileName = requestedName ?? this.uniqueMigratedName(`${server.name} configuration`);

    const profile = await this.create({
      name: profileName,
      description: 'Migrated from a legacy server env file',
      entries: keys.map((key) => ({ key, value: values[key] as string })),
    });

    // Clear the legacy path first: a subsequent repository upsert projects
    // `config_profile_ids`, so writing it before attaching would wipe the attach.
    this.repository.upsertServer({ ...server, envFile: null, updatedAt: nowIso() });

    // Attach the encrypted profile to the server.
    const current = this.store.profileIdsForServer(serverId);
    this.store.setProfileIdsForServer(
      serverId,
      current.includes(profile.id) ? current : [...current, profile.id],
    );

    this.logger.info('legacy env file migrated to encrypted configuration profile', {
      serverId,
      profileId: profile.id,
      entryCount: keys.length,
    });
    const migrated = this.get(profile.id);
    if (!migrated) throw new Error(`Configuration profile '${profile.id}' disappeared after migration`);
    return migrated;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private toSummary(profile: ConfigProfile): ConfigProfileSummary {
    return {
      id: profile.id,
      name: profile.name,
      description: profile.description,
      entries: profile.entries,
      headers: profile.headers,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      attachedServerIds: this.store.attachedServerIds(profile.id),
    };
  }

  private assertNameAvailable(name: string, excludeId?: string): void {
    const existing = this.store.getByName(name);
    if (existing && existing.id !== excludeId) {
      throw invalidParams(`A configuration profile named '${name}' already exists`);
    }
  }

  private uniqueMigratedName(base: string): string {
    const trimmed = base.slice(0, MAX_PROFILE_NAME_LENGTH);
    if (!this.store.getByName(trimmed)) return trimmed;
    for (let suffix = 2; suffix <= 100; suffix += 1) {
      const suffixText = ` (${suffix})`;
      const candidateBase = trimmed.slice(0, MAX_PROFILE_NAME_LENGTH - suffixText.length);
      const candidate = `${candidateBase}${suffixText}`;
      if (!this.store.getByName(candidate)) return candidate;
    }
    throw invalidParams(`Unable to derive a unique name from '${base}'`);
  }

  /** Validate one entry list (including secretRef existence) without writing. */
  /**
   * Update-only: a row submitted without `value`/`secretRef` keeps the current
   * encrypted value (or existing vault reference) instead of blanking it.
   */
  private materialiseKeptValues(input: NormalisedInput, existing: StoredConfigProfile): NormalisedInput {
    const resolve = (values: NormalisedValue[], current: ConfigProfileValue[], kind: 'env' | 'header'): NormalisedValue[] =>
      values.map((entry) => {
        if (entry.keep !== true) return entry;
        const previous = current.find((candidate) => candidate.key.toLowerCase() === entry.key.toLowerCase());
        if (!previous) {
          throw invalidParams(
            `Entry '${entry.key}' is new and requires a "value", "secretRef" or "credentialRef"`,
          );
        }
        if (previous.source === 'credential-ref') {
          if (!previous.provider || !previous.itemId) {
            throw invalidParams(`Entry '${entry.key}' has an unresolvable credential reference`);
          }
          return {
            key: entry.key,
            credentialRef: {
              provider: previous.provider,
              itemId: previous.itemId,
              field: previous.field ?? null,
            },
          };
        }
        if (previous.source === 'vault-ref') {
          if (!previous.ref) {
            throw invalidParams(`Entry '${entry.key}' has no resolvable vault reference`);
          }
          return { key: entry.key, secretRef: previous.ref };
        }
        const secretName =
          kind === 'env' ? profileEnvSecretName(existing.id, entry.key) : profileHeaderSecretName(existing.id, entry.key);
        const value = this.vault.getSecret(secretName);
        if (value === null) {
          throw invalidParams(`Encrypted value for '${entry.key}' was not found in the vault`);
        }
        return { key: entry.key, value };
      });
    return {
      ...input,
      entries: resolve(input.entries, existing.entries, 'env'),
      headers: resolve(input.headers, existing.headers, 'header'),
    };
  }

  private planValues(profileId: string, values: NormalisedValue[], kind: 'env' | 'header'): EntryPlan {
    const plan: EntryPlan = { values: [], writes: [] };
    const usedSecretNames = new Map<string, string>();
    for (const entry of values) {
      if (entry.credentialRef !== undefined) {
        // External credential reference: metadata only — no vault secret is written
        // and the vault may even be disabled.
        plan.values.push({
          key: entry.key,
          source: 'credential-ref',
          ref: null,
          provider: entry.credentialRef.provider,
          itemId: entry.credentialRef.itemId,
          field: entry.credentialRef.field,
        });
        continue;
      }
      if (entry.secretRef !== undefined) {
        if (!this.vault.isEnabled()) throw vaultRequiredError();
        if (this.vault.getSecret(entry.secretRef) === null) {
          throw invalidParams(`Vault secret '${entry.secretRef}' was not found`);
        }
        plan.values.push({ key: entry.key, source: 'vault-ref', ref: entry.secretRef });
        continue;
      }
      if (!this.vault.isEnabled()) throw vaultRequiredError();
      const secretName =
        kind === 'env'
          ? profileEnvSecretName(profileId, entry.key)
          : profileHeaderSecretName(profileId, entry.key);
      assertVaultSecretName(secretName, entry.key, kind);
      const collision = usedSecretNames.get(secretName);
      if (collision !== undefined) {
        throw invalidParams(
          `${kind === 'env' ? 'Environment variable' : 'Header'} '${entry.key}' collides with '${collision}' in the encrypted secret namespace`,
        );
      }
      usedSecretNames.set(secretName, entry.key);
      if (entry.value === undefined) {
        throw invalidParams(`Entry '${entry.key}' requires a "value" or a "secretRef"`);
      }
      plan.writes.push({ name: secretName, value: entry.value });
      plan.values.push({ key: entry.key, source: 'encrypted', ref: null });
    }
    return plan;
  }

  /** Encrypt planned values into the vault (upsert = rotation for an existing key). */
  private writePlan(plan: EntryPlan, owned: string[]): void {
    for (const write of plan.writes) {
      this.vault.setSecret(write.name, write.value);
      owned.push(write.name);
    }
  }

  private resolveEntryInto(
    profile: StoredConfigProfile,
    entry: ConfigProfileValue,
    target: 'env' | 'header',
    env: Record<string, string>,
    headers: Record<string, string>,
    credentialRefs: Map<string, CredentialRef>,
  ): void {
    const refKey = `${target}:${entry.key}`;
    if (entry.source === 'credential-ref') {
      if (!entry.provider || !entry.itemId) {
        throw invalidParams(
          `Configuration profile '${profile.name}' has an unresolved credential reference for '${entry.key}'`,
        );
      }
      credentialRefs.set(refKey, {
        key: entry.key,
        target,
        provider: entry.provider,
        itemId: entry.itemId,
        field: entry.field ?? null,
      });
      // A later profile's external reference replaces any earlier plain value for
      // the same target; the supervisor injects the resolved credential after
      // profile env/headers.
      if (target === 'header') delete headers[entry.key];
      else delete env[entry.key];
      return;
    }

    const value = this.resolveEntry(profile, entry, target);
    if (target === 'header') headers[entry.key] = value;
    else env[entry.key] = value;
    // A later plain/vault-ref value overrides an earlier profile's credential ref.
    credentialRefs.delete(refKey);
  }

  private resolveEntry(profile: StoredConfigProfile, entry: ConfigProfileValue, kind: 'env' | 'header'): string {
    if (entry.source === 'vault-ref') {
      if (!entry.ref) {
        throw invalidParams(
          `Configuration profile '${profile.name}' has an unresolved secret reference for '${entry.key}'`,
        );
      }
      if (!this.vault.isEnabled()) throw vaultRequiredError();
      const value = this.vault.getSecret(entry.ref);
      if (value === null) {
        throw invalidParams(
          `Missing vault secret '${entry.ref}' referenced by configuration profile '${profile.name}'`,
        );
      }
      return value;
    }

    if (!this.vault.isEnabled()) throw vaultRequiredError();
    const secretName =
      kind === 'env'
        ? profileEnvSecretName(profile.id, entry.key)
        : profileHeaderSecretName(profile.id, entry.key);
    const value = this.vault.getSecret(secretName);
    if (value === null) {
      throw invalidParams(
        `Configuration profile '${profile.name}' is missing its encrypted '${entry.key}' value`,
      );
    }
    return value;
  }

  private async probeServer(serverId: string): Promise<InstallTestResult> {
    const tools: string[] = [];
    const startedAt = Date.now();
    try {
      const client = this.supervisor.client(serverId);
      if (!client) {
        return {
          ok: false,
          toolCount: 0,
          tools,
          latencyMs: Date.now() - startedAt,
          error: 'Server is not running',
        };
      }
      const listed = await client.listTools();
      for (const tool of listed) tools.push(tool.name);
      return {
        ok: true,
        toolCount: listed.length,
        tools,
        latencyMs: Date.now() - startedAt,
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        toolCount: tools.length,
        tools,
        latencyMs: Date.now() - startedAt,
        error: errorMessage(error),
      };
    }
  }

  private requireIdArray(raw: unknown, field: string): string[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw invalidParams(`"${field}" must be a non-empty array of ids`);
    }
    const ids: string[] = [];
    for (const value of raw) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw invalidParams(`"${field}" must contain non-empty strings`);
      }
      ids.push(value.trim());
    }
    return [...new Set(ids)];
  }

  private cleanupSecrets(names: string[]): void {
    for (const name of names) {
      try {
        this.vault.deleteSecret(name);
      } catch {
        // Best-effort cleanup; the original error is the one that matters.
      }
    }
  }
}
