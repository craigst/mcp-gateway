import { useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Badge } from '../../components/Badge.js';
import { Notice } from '../../components/States.js';
import { Field, GhostButton, Select, TextInput } from '../../components/Form.js';
import { useToast } from '../../components/Toasts.js';
import { HEADER_KEY_PATTERN, buildConfigValues, newConfigRow, rowsFromValues } from './shared.js';
import type { ConfigRow } from './shared.js';
import type { ConfigProfileInput, ConfigProfileSummary } from '../../../core/types.js';

interface RowEditorProps {
  row: ConfigRow;
  label: string;
  vaultSecrets: readonly string[];
  onChange: (next: ConfigRow) => void;
  onRemove: () => void;
}

function RowEditor({ row, label, vaultSecrets, onChange, onRemove }: RowEditorProps) {
  const badge =
    row.mode === 'encrypted' ? (
      <Badge tone="warning">encrypted</Badge>
    ) : (
      <Badge tone="accent">vault: {row.secretRef.trim() === '' ? '…' : row.secretRef}</Badge>
    );

  return (
    <li className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <TextInput
          aria-label={`${label} key`}
          value={row.key}
          onChange={(event) => onChange({ ...row, key: event.target.value })}
          placeholder={label === 'Environment variable' ? 'N8N_API_KEY' : 'X-API-Key'}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 font-mono"
        />
        <Select
          aria-label={`${label} value source`}
          value={row.mode}
          onChange={(event) => onChange({ ...row, mode: event.target.value as ConfigRow['mode'] })}
          className="w-52"
        >
          <option value="encrypted">Store encrypted value</option>
          <option value="vault-ref">Reference vault secret</option>
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {row.mode === 'encrypted' ? (
          <TextInput
            aria-label={`${label} value`}
            type="password"
            value={row.value}
            onChange={(event) => onChange({ ...row, value: event.target.value })}
            placeholder={row.existing ? 'leave blank to keep current' : 'new encrypted value'}
            autoComplete="new-password"
            spellCheck={false}
            className="min-w-0 flex-1"
          />
        ) : (
          <Select
            aria-label={`${label} vault secret`}
            value={row.secretRef}
            onChange={(event) => onChange({ ...row, secretRef: event.target.value })}
            className="min-w-0 flex-1"
          >
            <option value="">
              {vaultSecrets.length === 0 ? 'No vault secrets available' : 'Select vault secret…'}
            </option>
            {vaultSecrets.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        )}
        {badge}
        <GhostButton onClick={onRemove} aria-label={`Remove ${label} ${row.key || 'row'}`}>
          Remove
        </GhostButton>
      </div>
    </li>
  );
}

export interface ConfigProfileDialogProps {
  /** Existing profile to edit, or null to create a new one. */
  profile: ConfigProfileSummary | null;
  vaultSecrets: readonly string[];
  vaultAvailable: boolean;
  onClose: () => void;
  onSaved: (profile: ConfigProfileSummary) => void;
}

/**
 * Create/edit dialog for gateway-managed configuration profiles. Values are
 * write-only: new encrypted values rotate the stored value; blank keeps it.
 */
export function ConfigProfileDialog({
  profile,
  vaultSecrets,
  vaultAvailable,
  onClose,
  onSaved,
}: ConfigProfileDialogProps) {
  const toast = useToast();
  const [name, setName] = useState(profile?.name ?? '');
  const [description, setDescription] = useState(profile?.description ?? '');
  const [entries, setEntries] = useState<ConfigRow[]>(() => rowsFromValues(profile?.entries ?? []));
  const [headers, setHeaders] = useState<ConfigRow[]>(() => rowsFromValues(profile?.headers ?? []));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const editing = profile !== null;

  const submit = async (): Promise<void> => {
    setError(null);
    if (name.trim() === '') {
      setError('Profile name is required.');
      return;
    }
    const builtEntries = buildConfigValues(entries, 'environment variable');
    if (builtEntries.error !== null) {
      setError(builtEntries.error);
      return;
    }
    const builtHeaders = buildConfigValues(headers, 'header', HEADER_KEY_PATTERN);
    if (builtHeaders.error !== null) {
      setError(builtHeaders.error);
      return;
    }

    const input: ConfigProfileInput = {
      name: name.trim(),
      description: description.trim() === '' ? null : description.trim(),
      entries: builtEntries.values,
      headers: builtHeaders.values,
    };

    setBusy(true);
    try {
      const saved =
        profile === null
          ? await api.createConfigProfile(input)
          : await api.updateConfigProfile(profile.id, input);
      toast('success', `${editing ? 'Updated' : 'Created'} configuration profile “${saved.name}”.`);
      onSaved(saved);
      onClose();
    } catch (saveError) {
      setError(formatApiError(saveError));
    } finally {
      setBusy(false);
    }
  };

  const addRow = (setRows: (updater: (previous: ConfigRow[]) => ConfigRow[]) => void): void => {
    setRows((previous) => [...previous, newConfigRow()]);
  };

  return (
    <ConfirmDialog
      open
      title={editing ? `Edit ${profile.name}` : 'New configuration profile'}
      description="Every value is encrypted into the gateway vault. Values are write-only — nothing is ever returned to the browser."
      size="xl"
      confirmLabel={editing ? 'Save profile' : 'Create profile'}
      busy={busy}
      onConfirm={() => void submit()}
      onCancel={onClose}
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <TextInput
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Internal services"
              autoFocus
            />
          </Field>
          <Field label="Description" hint="optional">
            <TextInput
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Shared n8n endpoint + credentials"
            />
          </Field>
        </div>

        {!vaultAvailable && (
          <Notice tone="warning" title="Vault is not configured">
            The gateway reports that its vault is disabled, so encrypted values cannot be stored. Set
            <code className="mx-1 font-mono">MCP_VAULT_SECRET</code> and reload this page.
          </Notice>
        )}

        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Environment variables
              </h3>
              <p className="text-[11px] text-slate-500">
                Inject API keys, DB strings, IPs and ports into every attached server. Values live in the
                gateway vault, never in an env file.
              </p>
            </div>
            <GhostButton onClick={() => addRow(setEntries)}>Add variable</GhostButton>
          </div>
          {entries.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-3 py-2.5 text-[11px] text-slate-500">
              No variables yet. Add the values this profile should inject into servers.
            </p>
          ) : (
            <ul className="space-y-2">
              {entries.map((row) => (
                <RowEditor
                  key={row.id}
                  row={row}
                  label="Environment variable"
                  vaultSecrets={vaultSecrets}
                  onChange={(next) =>
                    setEntries((previous) => previous.map((candidate) => (candidate.id === row.id ? next : candidate)))
                  }
                  onRemove={() => setEntries((previous) => previous.filter((candidate) => candidate.id !== row.id))}
                />
              ))}
            </ul>
          )}
        </section>

        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                HTTP headers
              </h3>
              <p className="text-[11px] text-slate-500">
                Optional encrypted headers for remote MCP transports (for example <code className="font-mono">Authorization</code>).
              </p>
            </div>
            <GhostButton onClick={() => addRow(setHeaders)}>Add header</GhostButton>
          </div>
          {headers.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-3 py-2.5 text-[11px] text-slate-500">
              No headers yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {headers.map((row) => (
                <RowEditor
                  key={row.id}
                  row={row}
                  label="Header"
                  vaultSecrets={vaultSecrets}
                  onChange={(next) =>
                    setHeaders((previous) => previous.map((candidate) => (candidate.id === row.id ? next : candidate)))
                  }
                  onRemove={() => setHeaders((previous) => previous.filter((candidate) => candidate.id !== row.id))}
                />
              ))}
            </ul>
          )}
        </section>

        {error !== null && (
          <Notice tone="error" title="Could not save the profile" onDismiss={() => setError(null)}>
            {error}
          </Notice>
        )}
      </div>
    </ConfirmDialog>
  );
}
