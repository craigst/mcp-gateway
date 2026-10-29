import { useState } from 'react';
import { ApiError, api, formatApiError } from '../lib/api.js';
import { useAsyncData } from '../lib/hooks.js';
import { formatTimestamp } from '../lib/format.js';
import { Card } from '../components/Card.js';
import { Table } from '../components/Table.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState, InlineNotice, LoadingState } from '../components/States.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import {
  DangerButton,
  Field,
  GhostButton,
  PrimaryButton,
  TextInput,
} from '../components/Form.js';
import type { VaultSecretMetadata } from '../../core/types.js';

const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface VaultState {
  enabled: boolean;
  secrets: VaultSecretMetadata[];
}

/**
 * The admin router answers 503 `{ data: { reason: 'VAULT_DISABLED' } }` when
 * MCP_VAULT_SECRET is unset; API.md describes a 200 `{ enabled: false }` body.
 * Treat both as the "vault disabled" state rather than a transport failure.
 */
function isVaultDisabledError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 503) return true;
  const data = error.data;
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { reason?: unknown }).reason === 'VAULT_DISABLED'
  );
}

/** Secret vault: metadata-only listing, create/rotate/delete (master key only). */
export function VaultPage() {
  const vault = useAsyncData<VaultState>(async () => {
    try {
      const response = await api.listVaultSecrets();
      return { enabled: response.enabled, secrets: response.secrets };
    } catch (error) {
      if (isVaultDisabledError(error)) return { enabled: false, secrets: [] };
      throw error;
    }
  }, []);

  const [secretName, setSecretName] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [editingName, setEditingName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VaultSecretMetadata | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const enabled = vault.status === 'ready' && vault.data.enabled;
  const secrets: VaultSecretMetadata[] = vault.status === 'ready' ? vault.data.secrets : [];

  const startRotate = (secret: VaultSecretMetadata): void => {
    setEditingName(secret.name);
    setSecretName(secret.name);
    setSecretValue('');
    setError(null);
    setNotice(null);
  };

  const resetForm = (): void => {
    setEditingName(null);
    setSecretName('');
    setSecretValue('');
  };

  const submit = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    const name = secretName.trim();
    if (name.length === 0) {
      setError('Secret name is required');
      return;
    }
    if (!SECRET_NAME_PATTERN.test(name)) {
      setError('Secret names must start with a letter or underscore and contain only letters, digits and underscores');
      return;
    }
    if (secretValue.length === 0) {
      setError('Secret value is required');
      return;
    }
    setBusy(true);
    try {
      await api.setVaultSecret(name, secretValue);
      setNotice(editingName === name ? `Rotated “${name}”.` : `Stored “${name}”.`);
      resetForm();
      vault.reload();
    } catch (submitError) {
      setError(formatApiError(submitError));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setError(null);
    try {
      await api.deleteVaultSecret(deleteTarget.name);
      setDeleteTarget(null);
      if (editingName === deleteTarget.name) resetForm();
      vault.reload();
    } catch (deleteError) {
      setError(formatApiError(deleteError));
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <InlineNotice>
        Vault routes require a <code>master</code> key. Secrets are encrypted with AES-256-GCM; only names and
        timestamps are returned to this console. Rotations are injected into running sub-servers without a restart.
      </InlineNotice>

      {vault.status === 'loading' && (
        <Card>
          <LoadingState label="Loading vault…" />
        </Card>
      )}
      {vault.status === 'error' && (
        <Card>
          <ErrorState message={vault.error} onRetry={vault.reload} />
        </Card>
      )}

      {vault.status === 'ready' && !enabled && (
        <Card title="Secret vault" subtitle="GET /mcp/v1/admin/vault/secrets">
          <EmptyState
            icon="▣"
            title="Vault is disabled"
            description="Set MCP_VAULT_SECRET on the gateway process to enable AES-256-GCM secret storage. Existing servers are unaffected."
          />
        </Card>
      )}

      {vault.status === 'ready' && enabled && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <Card
            title="Stored secrets"
            subtitle={`${secrets.length} secret${secrets.length === 1 ? '' : 's'} · values never leave the gateway`}
            actions={
              <GhostButton onClick={vault.reload}>Refresh</GhostButton>
            }
            padded={false}
          >
            {secrets.length === 0 ? (
              <EmptyState title="No secrets stored" description="Add an API token or database URL on the right." />
            ) : (
              <Table<VaultSecretMetadata>
                rows={secrets}
                getRowKey={(secret) => secret.name}
                columns={[
                  {
                    key: 'name',
                    header: 'Name',
                    render: (secret) => (
                      <span className="font-mono text-xs font-medium text-slate-200">{secret.name}</span>
                    ),
                  },
                  {
                    key: 'created',
                    header: 'Created',
                    render: (secret) => (
                      <span className="text-xs text-slate-500">{formatTimestamp(secret.createdAt)}</span>
                    ),
                  },
                  {
                    key: 'updated',
                    header: 'Updated',
                    render: (secret) => (
                      <span className="text-xs text-slate-500">{formatTimestamp(secret.updatedAt)}</span>
                    ),
                  },
                  {
                    key: 'actions',
                    header: 'Actions',
                    render: (secret) => (
                      <div className="flex flex-wrap gap-1">
                        <GhostButton onClick={() => startRotate(secret)}>Rotate</GhostButton>
                        <DangerButton
                          onClick={() => setDeleteTarget(secret)}
                          className="px-2 py-1 text-[11px]"
                        >
                          Delete
                        </DangerButton>
                      </div>
                    ),
                  },
                ]}
              />
            )}
          </Card>

          <Card
            title={editingName === null ? 'Add secret' : `Rotate · ${editingName}`}
            subtitle="PUT /mcp/v1/admin/vault/secrets/:name"
          >
            <div className="space-y-3">
              <Field label="Name">
                <TextInput
                  value={secretName}
                  onChange={(event) => setSecretName(event.target.value)}
                  placeholder="GITHUB_PAT_TOKEN"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field label="Value" hint="write-only — never returned by the API">
                <TextInput
                  type="password"
                  value={secretValue}
                  onChange={(event) => setSecretValue(event.target.value)}
                  placeholder="ghp_…"
                  autoComplete="new-password"
                  spellCheck={false}
                />
              </Field>
              {error !== null && (
                <p className="rounded-lg border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
                  {error}
                </p>
              )}
              {notice !== null && (
                <p className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
                  {notice}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <PrimaryButton onClick={() => void submit()} disabled={busy}>
                  {busy ? 'Saving…' : editingName === null ? 'Store secret' : 'Rotate secret'}
                </PrimaryButton>
                {editingName !== null && (
                  <GhostButton onClick={resetForm}>Cancel rotation</GhostButton>
                )}
              </div>
            </div>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete vault secret"
        tone="danger"
        confirmLabel="Delete secret"
        busy={deleteBusy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
        description={
          deleteTarget !== null
            ? `Delete “${deleteTarget.name}”? Sub-servers that inject it will fail to restart until it is recreated.`
            : undefined
        }
      />
    </div>
  );
}
