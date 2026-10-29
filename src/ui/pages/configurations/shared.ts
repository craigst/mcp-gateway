/**
 * Pure helpers for the encrypted configuration-profile editor.
 *
 * A profile row is either:
 *  - `encrypted` — a value the gateway encrypts into its own vault (write-only),
 *  - `vault-ref` — a reference to an existing named secret from the Vault page, or
 *  - `credential-ref` — a reference to an item in an external password manager
 *    (Vaultwarden / 1Password) via the credential-provider layer.
 * Values are never returned by the API, so edit mode only shows keys/sources.
 */
import type {
  ConfigProfileInputValue,
  ConfigProfileValue,
  CredentialProviderId,
} from '../../../core/types.js';

export const CONFIG_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** HTTP header names allow digits and hyphens (e.g. `X-Api-Key`). */
export const HEADER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export type ConfigRowMode = 'encrypted' | 'vault-ref' | 'credential-ref';

export interface ConfigRow {
  id: number;
  key: string;
  mode: ConfigRowMode;
  /** New plaintext value for `encrypted` rows (write-only; blank = keep current). */
  value: string;
  /** Vault secret name for `vault-ref` rows. */
  secretRef: string;
  /** Password-manager provider for `credential-ref` rows. */
  credentialProvider: CredentialProviderId;
  /** Provider item id (Vaultwarden alias/name, 1Password item id). */
  credentialItemId: string;
  /** Field to resolve from the item (defaults to `password`). */
  credentialField: string;
  /** True when this row came from an existing profile (blank value means keep). */
  existing: boolean;
}

let rowSequence = 0;

export function newConfigRow(): ConfigRow {
  rowSequence += 1;
  return {
    id: rowSequence,
    key: '',
    mode: 'encrypted',
    value: '',
    secretRef: '',
    credentialProvider: 'vaultwarden',
    credentialItemId: '',
    credentialField: 'password',
    existing: false,
  };
}

/** Seed editor rows from a stored profile's key/source list (values never returned). */
export function rowsFromValues(values: readonly ConfigProfileValue[]): ConfigRow[] {
  return values.map((value) => {
    rowSequence += 1;
    return {
      id: rowSequence,
      key: value.key,
      mode:
        value.source === 'vault-ref'
          ? 'vault-ref'
          : value.source === 'credential-ref'
            ? 'credential-ref'
            : 'encrypted',
      value: '',
      secretRef: value.ref ?? '',
      credentialProvider: value.provider ?? 'vaultwarden',
      credentialItemId: value.itemId ?? '',
      credentialField: value.field ?? 'password',
      existing: true,
    };
  });
}

export interface BuildRowsResult {
  values: ConfigProfileInputValue[];
  error: string | null;
}

/**
 * Validate editor rows and convert them into the write-only API shape.
 * Blank encrypted values are omitted (keep current) — they are only required
 * for brand-new rows.
 */
export function buildConfigValues(
  rows: readonly ConfigRow[],
  label: string,
  keyPattern: RegExp = CONFIG_KEY_PATTERN,
): BuildRowsResult {
  const values: ConfigProfileInputValue[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const key = row.key.trim();
    if (key === '') {
      if (row.value.trim() !== '' || row.secretRef.trim() !== '' || row.credentialItemId.trim() !== '') {
        return { values, error: `A ${label} has a value but no key.` };
      }
      continue;
    }
    if (!keyPattern.test(key)) {
      return { values, error: `Invalid ${label} key: ${key}` };
    }
    if (seen.has(key)) {
      return { values, error: `Duplicate ${label} key: ${key}` };
    }
    seen.add(key);

    if (row.mode === 'vault-ref') {
      const ref = row.secretRef.trim();
      if (ref === '') return { values, error: `Choose a vault secret for ${key}.` };
      values.push({ key, secretRef: ref });
      continue;
    }

    if (row.mode === 'credential-ref') {
      const itemId = row.credentialItemId.trim();
      if (itemId === '') return { values, error: `Choose a password-manager item for ${key}.` };
      const field = row.credentialField.trim();
      values.push({
        key,
        credentialRef: {
          provider: row.credentialProvider,
          itemId,
          ...(field === '' ? {} : { field }),
        },
      });
      continue;
    }

    const value = row.value;
    if (value === '' && !row.existing) {
      return { values, error: `Enter an encrypted value for ${key}.` };
    }
    values.push(value === '' ? { key } : { key, value });
  }

  return { values, error: null };
}

/** Count rows whose values live in the vault as references to named secrets. */
export function countVaultRefs(values: readonly ConfigProfileValue[]): number {
  return values.filter((value) => value.source === 'vault-ref').length;
}

export function countEncrypted(values: readonly ConfigProfileValue[]): number {
  return values.filter((value) => value.source === 'encrypted').length;
}

/** Count rows that resolve from an external password manager (credential refs). */
export function countCredentialRefs(values: readonly ConfigProfileValue[]): number {
  return values.filter((value) => value.source === 'credential-ref').length;
}
