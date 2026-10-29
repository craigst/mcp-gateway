/**
 * Master-key rotation controller (v0.2.1).
 *
 * The Web UI can rotate the gateway master key: a fresh master key is issued
 * (returned as plaintext exactly once) and — unless explicitly disabled — every
 * other active master key is revoked. Non-master keys are never touched, and the
 * plaintext is never logged or persisted (KeyService stores only its hash).
 */
import { invalidParams, internalError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { KeyService } from '../core/ports.js';
import type { ApiKeyRecord } from '../core/types.js';

const DEFAULT_MASTER_KEY_NAME = 'web-ui-master';

export interface MasterKeyControlDeps {
  keys: KeyService;
  logger?: Logger;
}

export interface RegenerateMasterKeyInput {
  /** Revoke every other active master key (default true). */
  revokePrevious?: boolean;
  /** Name for the new master key (default `web-ui-master`). */
  name?: string;
}

export interface RegeneratedMasterKey {
  /** Persisted record of the new key — never contains the plaintext. */
  key: ApiKeyRecord;
  /** Plaintext key, returned exactly once to the caller. */
  plaintext: string;
  /** Number of previous master keys revoked by this rotation. */
  revokedCount: number;
}

export class MasterKeyControl {
  private readonly keys: KeyService;
  private readonly logger: Logger;

  constructor(deps: MasterKeyControlDeps) {
    this.keys = deps.keys;
    this.logger = deps.logger ?? createLogger('admin');
  }

  /**
   * Issue a new master key, then (by default) revoke all other active master
   * keys. The new key is issued before revoking so a rotation never leaves the
   * gateway without a usable master key.
   */
  regenerate(input: RegenerateMasterKeyInput = {}): RegeneratedMasterKey {
    const name = this.resolveName(input.name);
    const revokePrevious = input.revokePrevious !== false;

    const issued = this.keys.issue({
      name,
      keyType: 'master',
      serverGrants: [],
      delegationAllowed: true,
      escalationAllowed: true,
    });
    const key = this.keys.get(issued.key.id);
    if (!key) throw internalError(`Newly issued master key '${issued.key.id}' could not be loaded.`);

    let revokedCount = 0;
    if (revokePrevious) {
      // Snapshot the list: `revoke()` mutates records, not the array.
      for (const record of this.keys.list()) {
        if (record.keyType !== 'master') continue;
        if (record.revokedAt !== null) continue;
        if (record.id === key.id) continue;
        this.keys.revoke(record.id);
        revokedCount += 1;
      }
    }

    // Log identifiers only — the plaintext must never reach the log stream.
    this.logger.info('master key regenerated', {
      keyId: key.id,
      keyPrefix: key.keyPrefix,
      revokedCount,
    });
    return { key, plaintext: issued.plaintext, revokedCount };
  }

  private resolveName(raw: unknown): string {
    if (raw === undefined) return DEFAULT_MASTER_KEY_NAME;
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw invalidParams('name must be a non-empty string.');
    }
    return raw.trim();
  }
}
