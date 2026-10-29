import { useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Notice } from '../../components/States.js';
import { CopyButton } from '../../components/CopyButton.js';
import { Field, PrimaryButton, TextInput } from '../../components/Form.js';
import type { KeySummary } from '../../../core/types.js';

export interface ApiKeyDialogProps {
  kind: 'master' | 'agent';
  onClose: () => void;
}

interface CreatedKey {
  key: KeySummary;
  plaintext: string;
}

/** Quick API-key creation from Settings (show-once plaintext + copy). */
export function ApiKeyDialog({ kind, onClose }: ApiKeyDialogProps) {
  const [name, setName] = useState(kind === 'master' ? 'external-master' : 'external-agent');
  const [expiryHours, setExpiryHours] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedKey | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    if (name.trim() === '') {
      setError('Name is required.');
      return;
    }
    const hours = expiryHours.trim() === '' ? null : Number(expiryHours);
    if (hours !== null && (!Number.isFinite(hours) || hours <= 0)) {
      setError('Expiry must be a positive number of hours.');
      return;
    }
    setBusy(true);
    try {
      const response = await api.createKey({
        name: name.trim(),
        keyType: kind,
        serverGrants: [],
        delegationAllowed: kind === 'master',
        escalationAllowed: true,
        expiresInSeconds: hours === null ? null : Math.round(hours * 3600),
      });
      setCreated(response);
    } catch (createError) {
      setError(formatApiError(createError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open
      title={created === null ? `Create ${kind} API key` : 'API key created'}
      description={
        created === null
          ? kind === 'master'
            ? 'Full-admin key for AI or external clients. Keep it out of the browser.'
            : 'Scoped-by-default agent key. Configure grants afterwards in RBAC.'
          : 'Copy the plaintext now — it is shown exactly once.'
      }
      confirmLabel={created === null ? 'Create key' : 'Done'}
      busy={busy}
      onConfirm={() => {
        if (created === null) void submit();
        else onClose();
      }}
      onCancel={onClose}
    >
      {created === null ? (
        <div className="space-y-3">
          <Field label="Name">
            <TextInput value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </Field>
          <Field label="Expires in hours" hint="blank = never expires">
            <TextInput
              type="number"
              min={1}
              step={1}
              value={expiryHours}
              onChange={(event) => setExpiryHours(event.target.value)}
              placeholder="24"
            />
          </Field>
          {kind === 'agent' && (
            <Notice tone="info">
              This key starts with no server grants. Open RBAC to scope it per server and tool, or add guardrails.
            </Notice>
          )}
          {error !== null && (
            <Notice tone="error" title="Could not create the key" onDismiss={() => setError(null)}>
              {error}
            </Notice>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-slate-400">
            <span className="font-semibold text-slate-200">{created.key.name}</span> · {created.key.keyType} ·{' '}
            {created.key.keyPrefix}…
          </p>
          <pre className="overflow-x-auto rounded-lg border border-emerald-900/60 bg-slate-950 p-3 font-mono text-xs text-emerald-300">
            {created.plaintext}
          </pre>
          <div className="flex flex-wrap gap-2">
            <CopyButton value={created.plaintext} label="Copy key" copiedLabel="Copied" variant="primary" />
            <PrimaryButton onClick={onClose} className="justify-center">
              Done
            </PrimaryButton>
          </div>
        </div>
      )}
    </ConfirmDialog>
  );
}
