/**
 * Persistence for computer-use connection metadata and availability.
 *
 * Two small tables (see `core/db.ts`):
 *   computer_use_settings      singleton row: broker URL/CA, enabled flag,
 *                              global availability + audit attribution
 *   computer_use_availability  per-computer overrides (absence = available)
 *
 * The broker token is deliberately NOT stored here: it comes from the gateway
 * environment or the encrypted vault.
 */
import type { DatabaseSync } from 'node:sqlite';

import { nowIso } from '../core/ids.js';
import type { ComputerUseAvailability } from '../core/types.js';

export interface StoredComputerUseSettings {
  brokerUrl: string | null;
  publicBrokerUrl: string | null;
  caFile: string | null;
  enabled: boolean;
  availability: ComputerUseAvailability;
  updatedAt: string | null;
}

export interface SettingsSeed {
  brokerUrl: string | null;
  publicBrokerUrl: string | null;
  caFile: string | null;
  enabled: boolean;
}

export interface AvailabilityPatch {
  available: boolean;
  reason: string | null;
  until: string | null;
  updatedBy: string;
}

interface SettingsRow {
  broker_url: string | null;
  public_broker_url: string | null;
  ca_file: string | null;
  enabled: number;
  agents_available: number;
  paused_reason: string | null;
  paused_until: string | null;
  availability_updated_at: string | null;
  availability_updated_by: string | null;
  updated_at: string | null;
}

interface AvailabilityRow {
  computer_id: string;
  available: number;
  reason: string | null;
  until: string | null;
  updated_at: string;
  updated_by: string | null;
}

export class ComputerUseStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Creates the singleton row on first use, seeded from environment defaults. */
  ensureRow(seed: SettingsSeed): StoredComputerUseSettings {
    const existing = this.db.prepare('SELECT * FROM computer_use_settings WHERE id = 1').get() as
      | SettingsRow
      | undefined;
    if (!existing) {
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO computer_use_settings
             (id, broker_url, public_broker_url, ca_file, enabled, agents_available,
              paused_reason, paused_until, availability_updated_at, availability_updated_by, updated_at)
           VALUES (1, ?, ?, ?, ?, 1, NULL, NULL, NULL, NULL, ?)`,
        )
        .run(seed.brokerUrl, seed.publicBrokerUrl, seed.caFile, seed.enabled ? 1 : 0, now);
      return this.get();
    }
    return mapSettings(existing);
  }

  get(): StoredComputerUseSettings {
    const row = this.db.prepare('SELECT * FROM computer_use_settings WHERE id = 1').get() as SettingsRow | undefined;
    if (!row) throw new Error('computer_use_settings row is missing');
    return mapSettings(row);
  }

  update(patch: {
    brokerUrl?: string | null;
    publicBrokerUrl?: string | null;
    caFile?: string | null;
    enabled?: boolean;
  }): StoredComputerUseSettings {
    const current = this.get();
    const next = {
      brokerUrl: patch.brokerUrl === undefined ? current.brokerUrl : patch.brokerUrl,
      publicBrokerUrl: patch.publicBrokerUrl === undefined ? current.publicBrokerUrl : patch.publicBrokerUrl,
      caFile: patch.caFile === undefined ? current.caFile : patch.caFile,
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled,
    };
    this.db
      .prepare(
        `UPDATE computer_use_settings
            SET broker_url = ?, public_broker_url = ?, ca_file = ?, enabled = ?, updated_at = ?
          WHERE id = 1`,
      )
      .run(next.brokerUrl, next.publicBrokerUrl, next.caFile, next.enabled ? 1 : 0, nowIso());
    return this.get();
  }

  /** Global operator switch. `available: true` clears the pause metadata. */
  setGlobalAvailability(patch: AvailabilityPatch): StoredComputerUseSettings {
    const now = nowIso();
    if (patch.available) {
      this.db
        .prepare(
          `UPDATE computer_use_settings
              SET agents_available = 1, paused_reason = NULL, paused_until = NULL,
                  availability_updated_at = ?, availability_updated_by = ?, updated_at = ?
            WHERE id = 1`,
        )
        .run(now, patch.updatedBy, now);
    } else {
      this.db
        .prepare(
          `UPDATE computer_use_settings
              SET agents_available = 0, paused_reason = ?, paused_until = ?,
                  availability_updated_at = ?, availability_updated_by = ?, updated_at = ?
            WHERE id = 1`,
        )
        .run(patch.reason, patch.until, now, patch.updatedBy, now);
    }
    return this.get();
  }

  computerAvailability(computerId: string): ComputerUseAvailability {
    const row = this.db
      .prepare('SELECT * FROM computer_use_availability WHERE computer_id = ?')
      .get(computerId) as AvailabilityRow | undefined;
    if (!row) return availableRecord();
    return resolveAvailability({
      available: Number(row.available) === 1,
      reason: row.reason,
      until: row.until,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    });
  }

  listComputerAvailability(): Map<string, ComputerUseAvailability> {
    const rows = this.db
      .prepare('SELECT * FROM computer_use_availability')
      .all() as unknown as AvailabilityRow[];
    const map = new Map<string, ComputerUseAvailability>();
    for (const row of rows) {
      map.set(row.computer_id, resolveAvailability({
        available: Number(row.available) === 1,
        reason: row.reason,
        until: row.until,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      }));
    }
    return map;
  }

  setComputerAvailability(computerId: string, patch: AvailabilityPatch): ComputerUseAvailability {
    const now = nowIso();
    if (patch.available) {
      this.db
        .prepare(
          `INSERT INTO computer_use_availability (computer_id, available, reason, until, updated_at, updated_by)
           VALUES (?, 1, NULL, NULL, ?, ?)
           ON CONFLICT(computer_id) DO UPDATE SET
             available = 1, reason = NULL, until = NULL, updated_at = excluded.updated_at,
             updated_by = excluded.updated_by`,
        )
        .run(computerId, now, patch.updatedBy);
    } else {
      this.db
        .prepare(
          `INSERT INTO computer_use_availability (computer_id, available, reason, until, updated_at, updated_by)
           VALUES (?, 0, ?, ?, ?, ?)
           ON CONFLICT(computer_id) DO UPDATE SET
             available = 0, reason = excluded.reason, until = excluded.until,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .run(computerId, patch.reason, patch.until, now, patch.updatedBy);
    }
    return this.computerAvailability(computerId);
  }
}

/** An expired pause is not a pause: availability is computed on every read. */
export function resolveAvailability(stored: {
  available: boolean;
  reason: string | null;
  until: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}): ComputerUseAvailability {
  if (stored.available) return availableRecord(stored.updatedAt, stored.updatedBy);
  if (stored.until !== null) {
    const untilMs = Date.parse(stored.until);
    if (Number.isFinite(untilMs) && untilMs <= Date.now()) {
      return availableRecord(stored.updatedAt, stored.updatedBy);
    }
  }
  return {
    available: false,
    state: 'paused',
    reason: stored.reason,
    until: stored.until,
    updatedAt: stored.updatedAt,
    updatedBy: stored.updatedBy,
  };
}

function availableRecord(updatedAt: string | null = null, updatedBy: string | null = null): ComputerUseAvailability {
  return { available: true, state: 'available', reason: null, until: null, updatedAt, updatedBy };
}

function mapSettings(row: SettingsRow): StoredComputerUseSettings {
  return {
    brokerUrl: row.broker_url,
    publicBrokerUrl: row.public_broker_url,
    caFile: row.ca_file,
    enabled: Number(row.enabled) === 1,
    availability: resolveAvailability({
      available: Number(row.agents_available) === 1,
      reason: row.paused_reason,
      until: row.paused_until,
      updatedAt: row.availability_updated_at,
      updatedBy: row.availability_updated_by,
    }),
    updatedAt: row.updated_at,
  };
}
