import { useState } from 'react';
import type { ReactNode } from 'react';
import { api, formatApiError } from '../lib/api.js';
import { useAsyncData } from '../lib/hooks.js';
import { formatBytes, formatNumber, formatTimestamp } from '../lib/format.js';
import { triggerBrowserDownload } from '../lib/download.js';
import { Card } from '../components/Card.js';
import { Badge } from '../components/Badge.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState, Notice } from '../components/States.js';
import { SkeletonTable } from '../components/Skeleton.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import {
  DangerButton,
  Field,
  GhostButton,
  PrimaryButton,
  SecondaryButton,
  TextInput,
} from '../components/Form.js';
import { useToast } from '../components/Toasts.js';
import { CreateBackupDialog, RestoreBackupDialog } from './settings/BackupDialogs.js';
import { ApiKeyDialog } from './settings/ApiKeyDialog.js';
import type { PageKey } from '../components/Layout.js';
import type { BackupMetadata, RestoreResult } from '../../core/types.js';

export interface SettingsPageProps {
  /** Signed-in operator username (also available from GET /admin/settings). */
  username: string;
  onNavigate?: (page: PageKey) => void;
  /** Password change / restore invalidates the session → back to login. */
  onReturnToLogin: () => void;
}

/** Settings: account, system info, quick API keys and encrypted backups. */
export function SettingsPage({ username, onNavigate, onReturnToLogin }: SettingsPageProps) {
  const toast = useToast();
  const settings = useAsyncData(() => api.getSettings(), []);
  const backups = useAsyncData(() => api.listBackups(), []);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changeBusy, setChangeBusy] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [apiKeyKind, setApiKeyKind] = useState<'master' | 'agent' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupMetadata | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const settingsInfo = settings.status === 'ready' ? settings.data.settings : null;
  const account = settings.status === 'ready' ? settings.data.account : null;
  const backupList = backups.status === 'ready' ? backups.data : [];

  const changePassword = async (): Promise<void> => {
    setChangeError(null);
    if (currentPassword === '') {
      setChangeError('Enter your current password.');
      return;
    }
    if (newPassword.length < 8) {
      setChangeError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setChangeError('New passwords do not match.');
      return;
    }
    setChangeBusy(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      toast('success', 'Password changed. All sessions were revoked — sign in again.');
      onReturnToLogin();
    } catch (passwordError) {
      setChangeError(formatApiError(passwordError));
    } finally {
      setChangeBusy(false);
    }
  };

  const downloadBackup = async (backup: BackupMetadata): Promise<void> => {
    setDownloadingId(backup.id);
    setActionError(null);
    try {
      const file = await api.downloadBackup(backup.id);
      const saved = triggerBrowserDownload(file.blob, file.fileName);
      toast(
        saved ? 'success' : 'info',
        saved
          ? `Downloaded ${file.fileName}.`
          : `Backup ${file.fileName} is ready but this browser could not start the download.`,
      );
    } catch (downloadError) {
      setActionError(formatApiError(downloadError));
    } finally {
      setDownloadingId(null);
    }
  };

  const handleBackupCreated = async (backup: BackupMetadata): Promise<void> => {
    backups.reload();
    await downloadBackup(backup);
  };

  const confirmDelete = async (): Promise<void> => {
    if (deleteTarget === null) return;
    setDeleteBusy(true);
    setActionError(null);
    try {
      await api.deleteBackup(deleteTarget.id);
      toast('success', `Deleted backup ${deleteTarget.fileName}.`);
      setDeleteTarget(null);
      backups.reload();
    } catch (deleteError) {
      setActionError(formatApiError(deleteError));
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleRestored = (result: RestoreResult): void => {
    toast(
      'success',
      `Restored ${formatNumber(result.usersRestored)} user(s), ${formatNumber(result.serversRestored)} server(s). Sign in again.`,
    );
    backups.reload();
  };

  const systemRows: ReadonlyArray<[string, ReactNode]> =
    settingsInfo === null
      ? []
      : [
          ['Version', settingsInfo.version],
          ['Host / port', `${settingsInfo.host}:${settingsInfo.port}`],
          ['Data directory', <span className="break-all font-mono text-[11px]">{settingsInfo.dataDir}</span>],
          ['Database', <span className="break-all font-mono text-[11px]">{settingsInfo.dbPath}</span>],
          ['Repos directory', <span className="break-all font-mono text-[11px]">{settingsInfo.reposDir}</span>],
          ['UI dist', <span className="break-all font-mono text-[11px]">{settingsInfo.uiDistDir}</span>],
          [
            'Vault',
            <Badge tone={settingsInfo.vaultEnabled ? 'success' : 'danger'}>
              {settingsInfo.vaultEnabled ? 'enabled' : 'disabled'}
            </Badge>,
          ],
          [
            'Git import',
            <Badge tone={settingsInfo.gitImportEnabled ? 'success' : 'neutral'}>
              {settingsInfo.gitImportEnabled ? 'enabled' : 'disabled'}
            </Badge>,
          ],
          [
            'Allowed clone prefixes',
            settingsInfo.gitImportAllowedPrefixes.length === 0 ? (
              'none'
            ) : (
              <span className="flex flex-wrap gap-1">
                {settingsInfo.gitImportAllowedPrefixes.map((prefix) => (
                  <Badge key={prefix} tone="neutral">
                    {prefix}
                  </Badge>
                ))}
              </span>
            ),
          ],
          ['Delegation max depth', settingsInfo.delegationMaxDepth],
          ['Autostart servers', settingsInfo.autostart],
          ['Log level', settingsInfo.logLevel],
          ['Users', `${formatNumber(settingsInfo.userCount)} · ${formatNumber(settingsInfo.sessionCount)} active session(s)`],
          [
            'First-run setup',
            <Badge tone={settingsInfo.setupRequired ? 'warning' : 'success'}>
              {settingsInfo.setupRequired ? 'required' : 'complete'}
            </Badge>,
          ],
        ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-100">Settings</h2>
          <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-slate-400">
            Account, system configuration and password-encrypted backups. System values are read-only — set them via
            environment/container configuration.
          </p>
        </div>
        <Badge tone="info">signed in as {account?.username ?? username}</Badge>
      </div>

      {actionError !== null && (
        <Notice tone="error" title="Settings action failed" onDismiss={() => setActionError(null)}>
          {actionError}
        </Notice>
      )}

      <Card title="Account" subtitle={`${formatNumber(account?.sessionCount ?? 0)} active session(s)`}>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <p className="text-xs text-slate-400">
              Signed in as <span className="font-semibold text-slate-200">{account?.username ?? username}</span>.
              Changing the password revokes every active session, including this one.
            </p>
            <Field label="Current password">
              <TextInput
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
              />
            </Field>
            <Field label="New password" hint="At least 8 characters.">
              <TextInput
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <Field label="Confirm new password">
              <TextInput
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
              />
            </Field>
            {changeError !== null && (
              <Notice tone="error" title="Password change failed" onDismiss={() => setChangeError(null)}>
                {changeError}
              </Notice>
            )}
            <PrimaryButton onClick={() => void changePassword()} disabled={changeBusy}>
              {changeBusy ? 'Changing…' : 'Change password'}
            </PrimaryButton>
          </div>

          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              API keys for AI / external clients
            </h3>
            <p className="text-[11px] text-slate-500">
              The console uses your account session. AI agents and external tools authenticate with API keys.
            </p>
            <div className="flex flex-wrap gap-2">
              <SecondaryButton onClick={() => setApiKeyKind('master')} className="px-3 py-1.5 text-xs">
                Create master key
              </SecondaryButton>
              <SecondaryButton onClick={() => setApiKeyKind('agent')} className="px-3 py-1.5 text-xs">
                Create agent key
              </SecondaryButton>
              <GhostButton onClick={() => onNavigate?.('rbac')}>Manage scopes in RBAC →</GhostButton>
            </div>
          </div>
        </div>
      </Card>

      <Card
        title="System"
        subtitle="Read-only runtime configuration (environment / container managed)"
        actions={<GhostButton onClick={settings.reload}>Refresh</GhostButton>}
      >
        {settings.status === 'loading' && <p className="text-xs text-slate-500">Loading settings…</p>}
        {settings.status === 'error' && <ErrorState message={settings.error} onRetry={settings.reload} />}
        {settings.status === 'ready' && (
          <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {systemRows.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
                <dd className="mt-0.5 break-words text-xs text-slate-300">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </Card>

      <Card
        title="Backups"
        subtitle="AES-256-GCM encrypted, scrypt key derived from your account password"
        actions={
          <>
            <SecondaryButton onClick={() => setCreateOpen(true)} className="px-2 py-1 text-xs">
              Create backup
            </SecondaryButton>
            <SecondaryButton onClick={() => setRestoreOpen(true)} className="px-2 py-1 text-xs">
              Restore backup
            </SecondaryButton>
            <GhostButton onClick={backups.reload}>Refresh</GhostButton>
          </>
        }
        padded={false}
      >
        <div className="space-y-3 p-4">
          <Notice tone="info" title="Backup security">
            Backups are encrypted with AES-256-GCM using a key derived from your account password with scrypt. The
            password is never stored, and restoring requires it. Download a backup and store it offline.
          </Notice>

          {backups.status === 'loading' && (
            <SkeletonTable rows={3} columns={4} label="Loading backups…" />
          )}
          {backups.status === 'error' && <ErrorState message={backups.error} onRetry={backups.reload} />}
          {backups.status === 'ready' &&
            (backupList.length === 0 ? (
              <EmptyState
                icon="⛁"
                title="No backups yet"
                description="Create an encrypted backup before making large changes. It contains users, keys, servers, profiles, vault secrets and optional audit history."
                action={
                  <PrimaryButton onClick={() => setCreateOpen(true)} className="px-3 py-1.5 text-xs">
                    Create backup
                  </PrimaryButton>
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-800 text-left text-sm">
                  <thead className="bg-slate-900/70">
                    <tr>
                      {['Backup', 'Created', 'Size', 'Contents', 'Actions'].map((header) => (
                        <th
                          key={header}
                          scope="col"
                          className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400"
                        >
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {backupList.map((backup) => (
                      <tr key={backup.id} className="hover:bg-slate-800/40">
                        <td className="px-3 py-2.5">
                          <p className="font-mono text-[11px] text-slate-200">{backup.fileName}</p>
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            <Badge tone="neutral">v{backup.gatewayVersion}</Badge>
                            {backup.includeAudit && <Badge tone="info">audit included</Badge>}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-[11px] text-slate-500">
                          {formatTimestamp(backup.createdAt)}
                        </td>
                        <td className="px-3 py-2.5 text-[11px] tabular-nums text-slate-400">
                          {formatBytes(backup.sizeBytes)}
                        </td>
                        <td className="px-3 py-2.5 text-[11px] text-slate-400">
                          {formatNumber(backup.counts.users)} users · {formatNumber(backup.counts.keys)} keys ·{' '}
                          {formatNumber(backup.counts.servers)} servers · {formatNumber(backup.counts.profiles)}{' '}
                          profiles · {formatNumber(backup.counts.auditEntries)} audit
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap items-center gap-1">
                            <GhostButton
                              onClick={() => void downloadBackup(backup)}
                              disabled={downloadingId !== null}
                            >
                              {downloadingId === backup.id ? 'Downloading…' : 'Download'}
                            </GhostButton>
                            <DangerButton
                              onClick={() => setDeleteTarget(backup)}
                              className="px-2 py-1 text-[11px]"
                              disabled={deleteBusy}
                            >
                              Delete
                            </DangerButton>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
        </div>
      </Card>

      {createOpen && (
        <CreateBackupDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(backup) => void handleBackupCreated(backup)}
        />
      )}
      {restoreOpen && (
        <RestoreBackupDialog
          onClose={() => setRestoreOpen(false)}
          onRestored={handleRestored}
          onReturnToLogin={onReturnToLogin}
        />
      )}
      {apiKeyKind !== null && <ApiKeyDialog kind={apiKeyKind} onClose={() => setApiKeyKind(null)} />}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete backup"
        tone="danger"
        confirmLabel="Delete backup"
        busy={deleteBusy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
        description={
          deleteTarget !== null
            ? `Delete ${deleteTarget.fileName}? This encrypted backup is removed from disk and cannot be recovered.`
            : undefined
        }
      />
    </div>
  );
}
