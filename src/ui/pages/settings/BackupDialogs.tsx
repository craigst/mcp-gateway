import { useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Badge } from '../../components/Badge.js';
import { Notice } from '../../components/States.js';
import { CheckboxField, Field, GhostButton, PrimaryButton, TextInput } from '../../components/Form.js';
import { readBackupFile } from '../../lib/download.js';
import { formatBytes, formatNumber, formatTimestamp } from '../../lib/format.js';
import type { BackupMetadata, RestoreResult } from '../../../core/types.js';

export interface CreateBackupDialogProps {
  onClose: () => void;
  onCreated: (backup: BackupMetadata) => void;
}

/** Create an encrypted backup using the account password as the key source. */
export function CreateBackupDialog({ onClose, onCreated }: CreateBackupDialogProps) {
  const [password, setPassword] = useState('');
  const [includeAudit, setIncludeAudit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    if (password === '') {
      setError('Enter your account password to derive the backup key.');
      return;
    }
    setBusy(true);
    try {
      const backup = await api.createBackup({ password, includeAudit });
      onCreated(backup);
      onClose();
    } catch (createError) {
      setError(formatApiError(createError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open
      title="Create encrypted backup"
      description="Creates an AES-256-GCM backup of users, keys, servers, profiles, vault secrets and (optionally) audit history."
      confirmLabel="Create backup"
      busy={busy}
      confirmDisabled={password === ''}
      onConfirm={() => void submit()}
      onCancel={onClose}
    >
      <div className="space-y-3">
        <Notice tone="info" title="The password is never stored">
          The backup key is derived from your account password with scrypt. Restoring this file requires the same
          password.
        </Notice>
        <Field label="Account password">
          <TextInput
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus
          />
        </Field>
        <CheckboxField
          label="Include audit log (recommended)"
          checked={includeAudit}
          onChange={setIncludeAudit}
        />
        <p className="text-[11px] text-slate-500">
          The file downloads automatically after creation. Store it somewhere safe — it contains every encrypted
          gateway secret.
        </p>
        {error !== null && (
          <Notice tone="error" title="Backup failed" onDismiss={() => setError(null)}>
            {error}
          </Notice>
        )}
      </div>
    </ConfirmDialog>
  );
}

export interface RestoreBackupDialogProps {
  onClose: () => void;
  onRestored: (result: RestoreResult) => void;
  onReturnToLogin: () => void;
}

type ReinstallState = { state: 'busy' | 'ok' | 'error'; message: string };

/** Restore an encrypted backup, with post-restore reinstall actions. */
export function RestoreBackupDialog({ onClose, onRestored, onReturnToLogin }: RestoreBackupDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [reinstall, setReinstall] = useState<Record<string, ReinstallState>>({});

  const submit = async (): Promise<void> => {
    setError(null);
    if (file === null) {
      setError('Choose a backup file (.mcpbak or .json).');
      return;
    }
    if (password === '') {
      setError('Enter the password used when the backup was created.');
      return;
    }
    if (confirmText !== 'RESTORE') {
      setError('Type RESTORE exactly to confirm.');
      return;
    }
    setBusy(true);
    try {
      const backup = await readBackupFile(file);
      const restored = await api.restoreBackup({ backup, password });
      setResult(restored);
      onRestored(restored);
    } catch (restoreError) {
      setError(formatApiError(restoreError));
    } finally {
      setBusy(false);
    }
  };

  const reinstallServer = async (serverId: string): Promise<void> => {
    setReinstall((previous) => ({ ...previous, [serverId]: { state: 'busy', message: 'Reinstalling…' } }));
    try {
      const updated = await api.reinstallServer(serverId);
      setReinstall((previous) => ({
        ...previous,
        [serverId]: {
          state: 'ok',
          message: `Rebuilt${updated.after.version ? ` v${updated.after.version}` : ''}${
            updated.test !== null ? ` · ${updated.test.toolCount} tools` : ''
          }`,
        },
      }));
    } catch (reinstallError) {
      setReinstall((previous) => ({
        ...previous,
        [serverId]: { state: 'error', message: formatApiError(reinstallError) },
      }));
    }
  };

  return (
    <ConfirmDialog
      open
      title={result === null ? 'Restore from backup' : 'Backup restored'}
      description={
        result === null
          ? 'Replaces this gateway’s data with an encrypted backup. This cannot be undone.'
          : 'Restored counts are shown below. Servers whose checkout was missing can be reinstalled.'
      }
      tone={result === null ? 'danger' : 'default'}
      confirmLabel={result === null ? 'Restore backup' : 'Close'}
      busy={busy}
      confirmDisabled={result === null && (file === null || password === '' || confirmText === '')}
      onConfirm={() => {
        if (result === null) void submit();
        else onClose();
      }}
      onCancel={onClose}
    >
      {result === null ? (
        <div className="space-y-3">
          <Notice tone="warning" title="This replaces current data">
            Only restore backups you created on this gateway. Existing users, keys, servers and secrets are replaced
            by the backup contents.
          </Notice>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-300">Backup file</span>
            <input
              type="file"
              accept=".mcpbak,.json,application/json"
              aria-label="Backup file"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-300 file:mr-3 file:rounded file:border-0 file:bg-slate-800 file:px-2 file:py-1 file:text-xs file:text-slate-200"
            />
            {file !== null && (
              <span className="mt-1 block text-[11px] text-slate-500">
                {file.name} · {formatBytes(file.size)}
              </span>
            )}
          </label>
          <Field label="Backup password" hint="The account password used when the backup was created.">
            <TextInput
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="Type RESTORE to confirm">
            <TextInput
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              placeholder="RESTORE"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </Field>
          {error !== null && (
            <Notice tone="error" title="Restore failed" onDismiss={() => setError(null)}>
              {error}
            </Notice>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-2 rounded-xl border border-slate-800 bg-slate-900/40 p-4 sm:grid-cols-2">
            {[
              ['Users', result.usersRestored],
              ['API keys', result.keysRestored],
              ['Servers', result.serversRestored],
              ['Tools', result.toolsRestored],
              ['Profiles', result.profilesRestored],
              ['Catalog sources', result.catalogSourcesRestored],
              ['Vault secrets', result.secretsRestored],
              ['Audit entries', result.auditEntriesRestored],
            ].map(([label, value]) => (
              <div key={String(label)} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-slate-400">{label}</span>
                <span className="font-semibold tabular-nums text-slate-200">{formatNumber(Number(value))}</span>
              </div>
            ))}
          </div>

          {result.reinstallRequired.length > 0 ? (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Servers needing a reinstall
              </p>
              <ul className="space-y-2">
                {result.reinstallRequired.map((missing) => {
                  const status = reinstall[missing.serverId];
                  return (
                    <li
                      key={missing.serverId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-slate-200">{missing.name}</p>
                        <p className="font-mono text-[10px] text-slate-500">{missing.serverId}</p>
                        {status !== undefined && (
                          <p
                            className={
                              status.state === 'error'
                                ? 'text-[10px] text-rose-300'
                                : 'text-[10px] text-slate-400'
                            }
                          >
                            {status.message}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {status?.state === 'ok' && <Badge tone="success">reinstalled</Badge>}
                        {status?.state === 'error' && <Badge tone="danger">failed</Badge>}
                        <GhostButton
                          onClick={() => void reinstallServer(missing.serverId)}
                          disabled={status?.state === 'busy'}
                        >
                          {status?.state === 'busy' ? 'Reinstalling…' : 'Reinstall'}
                        </GhostButton>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <p className="text-[11px] text-slate-500">All restored servers have their code available.</p>
          )}

          <Notice tone="warning" title="Sign in again">
            Restoring users invalidates the current console session. Sign out and sign in with the original account
            password.
          </Notice>
          <PrimaryButton
            onClick={() => {
              onClose();
              onReturnToLogin();
            }}
            className="w-full justify-center"
          >
            Sign out &amp; sign in
          </PrimaryButton>
          <p className="text-[11px] text-slate-500">
            Restored at {formatTimestamp(new Date().toISOString())} — keep this file for future recovery.
          </p>
        </div>
      )}
    </ConfirmDialog>
  );
}
