import { useState } from 'react';
import { api, formatApiError } from '../lib/api.js';
import type { LoginResponse, SessionUser } from '../lib/api.js';
import { Badge } from '../components/Badge.js';
import { Notice } from '../components/States.js';
import { CopyButton } from '../components/CopyButton.js';
import { Field, PrimaryButton, SecondaryButton, TextInput } from '../components/Form.js';
import { readBackupFile } from '../lib/download.js';
import { cx } from '../lib/cx.js';
import { formatNumber } from '../lib/format.js';
import type { RestoreResult } from '../../core/types.js';

type Step = 'welcome' | 'account' | 'master' | 'done' | 'restored';
type WelcomeTab = 'create' | 'restore';

const CREATE_STEPS: readonly string[] = ['Welcome', 'Account', 'API key', 'Done'];

export interface SetupWizardProps {
  /** Whether a first-run backup restore is possible on this gateway. */
  restoreSupported: boolean;
  onComplete: (user: SessionUser) => void;
  onRestoreComplete: () => void;
}

function SetupProgress({ stepIndex }: { stepIndex: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="Setup progress">
      {CREATE_STEPS.map((label, index) => {
        const done = index < stepIndex;
        const active = index === stepIndex;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cx(
                'flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-bold',
                done
                  ? 'border-emerald-700 bg-emerald-950/70 text-emerald-300'
                  : active
                    ? 'border-sky-600 bg-sky-950/70 text-sky-300'
                    : 'border-slate-700 text-slate-500',
              )}
            >
              {done ? '✓' : index + 1}
            </span>
            <span className={cx('text-[11px]', active ? 'font-semibold text-slate-200' : 'text-slate-500')}>
              {label}
            </span>
            {index < CREATE_STEPS.length - 1 && <span aria-hidden="true" className="text-slate-700">—</span>}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * First-run setup wizard: create the operator account, optionally mint an
 * initial master API key for AI clients, or restore an encrypted backup.
 */
export function SetupWizard({ restoreSupported, onComplete, onRestoreComplete }: SetupWizardProps) {
  const [step, setStep] = useState<Step>('welcome');
  const [welcomeTab, setWelcomeTab] = useState<WelcomeTab>('create');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [createdUsername, setCreatedUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [backupPassword, setBackupPassword] = useState('');
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);

  const [masterPlaintext, setMasterPlaintext] = useState<string | null>(null);
  const [masterBusy, setMasterBusy] = useState(false);

  const stepIndex = step === 'welcome' ? 0 : step === 'account' ? 1 : step === 'master' ? 2 : 3;

  const createAccount = async (): Promise<void> => {
    setError(null);
    const name = username.trim();
    if (name === '') {
      setError('Choose a username.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const session: LoginResponse = await api.setupAccount(name, password);
      setCreatedUsername(session.user.username);
      setPassword('');
      setConfirmPassword('');
      setStep('master');
    } catch (setupError) {
      setError(formatApiError(setupError));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (): Promise<void> => {
    setError(null);
    if (backupFile === null) {
      setError('Choose a .mcpbak or .json backup file.');
      return;
    }
    if (backupPassword === '') {
      setError('Enter the password used when the backup was created.');
      return;
    }
    setBusy(true);
    try {
      const parsed = await readBackupFile(backupFile);
      const result = await api.setupRestore(parsed, backupPassword);
      setRestoreResult(result);
      setStep('restored');
    } catch (restoreError) {
      setError(formatApiError(restoreError));
    } finally {
      setBusy(false);
    }
  };

  const generateMasterKey = async (): Promise<void> => {
    setError(null);
    setMasterBusy(true);
    try {
      const created = await api.createKey({
        name: 'initial-master',
        keyType: 'master',
        serverGrants: [],
        delegationAllowed: true,
        escalationAllowed: true,
        expiresInSeconds: null,
      });
      setMasterPlaintext(created.plaintext);
    } catch (keyError) {
      setError(formatApiError(keyError));
    } finally {
      setMasterBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-slate-100">
      <div className="w-full max-w-xl space-y-6">
        <div className="text-center">
          <span
            aria-hidden="true"
            className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-sky-500/15 text-base font-bold text-sky-300"
          >
            MCP
          </span>
          <h1 className="mt-4 text-xl font-semibold text-slate-100">Set up your MCP Gateway</h1>
          <p className="mt-1 text-xs text-slate-400">
            One operator account protects the console, the encrypted vault and your backups.
          </p>
        </div>

        <SetupProgress stepIndex={step === 'restored' ? 1 : stepIndex} />

        <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-5 shadow-xl shadow-black/30">
          {step === 'welcome' && (
            <div className="space-y-4">
              <div className="flex gap-1" role="tablist" aria-label="Setup path">
                <button
                  type="button"
                  role="tab"
                  aria-selected={welcomeTab === 'create'}
                  onClick={() => {
                    setWelcomeTab('create');
                    setError(null);
                  }}
                  className={cx(
                    'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
                    welcomeTab === 'create'
                      ? 'bg-slate-800 text-sky-300'
                      : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200',
                  )}
                >
                  Create operator account
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={welcomeTab === 'restore'}
                  onClick={() => {
                    setWelcomeTab('restore');
                    setError(null);
                  }}
                  className={cx(
                    'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
                    welcomeTab === 'restore'
                      ? 'bg-slate-800 text-sky-300'
                      : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200',
                  )}
                >
                  Restore from backup
                </button>
              </div>

              {welcomeTab === 'create' ? (
                <div className="space-y-4">
                  <ul className="space-y-1.5 text-xs text-slate-400">
                    <li>• Manage MCP servers, catalogs and harness imports from one console.</li>
                    <li>• Human-approved credential delivery through Vault Warden.</li>
                    <li>• Encrypted settings, API keys and password-protected backups.</li>
                  </ul>
                  <Notice tone="info">
                    Your username and password are the only credentials needed for this console. API keys are for
                    AI / external clients and can be created later.
                  </Notice>
                  <PrimaryButton onClick={() => setStep('account')} className="w-full justify-center">
                    Create operator account
                  </PrimaryButton>
                </div>
              ) : (
                <div className="space-y-3">
                  {!restoreSupported ? (
                    <Notice tone="warning" title="Restore is not available">
                      This gateway has already been initialised. Sign in with an existing account to restore a backup
                      from Settings instead.
                    </Notice>
                  ) : (
                    <>
                      <Notice tone="info">
                        Restoring replaces this fresh gateway&apos;s data with an AES-256-GCM encrypted backup. You
                        will sign in with the original account password afterwards.
                      </Notice>
                      <label className="block">
                        <span className="mb-1 block text-xs font-medium text-slate-300">Backup file</span>
                        <input
                          type="file"
                          accept=".mcpbak,.json,application/json"
                          aria-label="Backup file"
                          onChange={(event) => setBackupFile(event.target.files?.[0] ?? null)}
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-300 file:mr-3 file:rounded file:border-0 file:bg-slate-800 file:px-2 file:py-1 file:text-xs file:text-slate-200"
                        />
                      </label>
                      <Field label="Backup password" hint="The account password used when the backup was created.">
                        <TextInput
                          type="password"
                          value={backupPassword}
                          onChange={(event) => setBackupPassword(event.target.value)}
                          autoComplete="off"
                          disabled={busy}
                        />
                      </Field>
                      <PrimaryButton
                        onClick={() => void restore()}
                        disabled={busy}
                        className="w-full justify-center"
                      >
                        {busy ? 'Restoring…' : 'Restore from backup'}
                      </PrimaryButton>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {step === 'account' && (
            <div className="space-y-4">
              <h2 className="text-sm font-semibold text-slate-200">Create operator account</h2>
              <Field label="Username">
                <TextInput
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="operator"
                  autoComplete="username"
                  autoFocus
                  disabled={busy}
                />
              </Field>
              <Field label="Password" hint="At least 8 characters.">
                <TextInput
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  disabled={busy}
                />
              </Field>
              <Field label="Confirm password">
                <TextInput
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                  disabled={busy}
                />
              </Field>
              {error !== null && (
                <Notice tone="error" title="Could not create the account" onDismiss={() => setError(null)}>
                  {error}
                </Notice>
              )}
              <div className="flex flex-wrap gap-2">
                <PrimaryButton onClick={() => void createAccount()} disabled={busy} className="justify-center">
                  {busy ? 'Creating…' : 'Create account'}
                </PrimaryButton>
                <SecondaryButton onClick={() => setStep('welcome')} disabled={busy}>
                  Back
                </SecondaryButton>
              </div>
            </div>
          )}

          {step === 'master' && (
            <div className="space-y-4">
              <h2 className="text-sm font-semibold text-slate-200">Optional: API key for AI clients</h2>
              <p className="text-xs text-slate-400">
                The console uses your account session. AI agents and external tools authenticate with API keys — you
                can create one now or add scoped keys later from RBAC.
              </p>
              {masterPlaintext === null ? (
                <div className="flex flex-wrap gap-2">
                  <PrimaryButton onClick={() => void generateMasterKey()} disabled={masterBusy}>
                    {masterBusy ? 'Generating…' : 'Generate master API key'}
                  </PrimaryButton>
                  <SecondaryButton onClick={() => setStep('done')} disabled={masterBusy}>
                    Skip for now
                  </SecondaryButton>
                </div>
              ) : (
                <div className="space-y-3">
                  <Notice tone="success" title="Master API key created">
                    Copy it now — it is shown exactly once. This key bypasses scoped grants, so keep it safe.
                  </Notice>
                  <pre className="overflow-x-auto rounded-lg border border-emerald-900/60 bg-slate-950 p-3 font-mono text-xs text-emerald-300">
                    {masterPlaintext}
                  </pre>
                  <div className="flex flex-wrap gap-2">
                    <CopyButton value={masterPlaintext} label="Copy key" copiedLabel="Copied" variant="primary" />
                    <PrimaryButton onClick={() => setStep('done')} className="justify-center">
                      Continue
                    </PrimaryButton>
                  </div>
                </div>
              )}
              {error !== null && (
                <Notice tone="error" title="Could not create the key" onDismiss={() => setError(null)}>
                  {error}
                </Notice>
              )}
            </div>
          )}

          {step === 'done' && (
            <div className="space-y-4 text-center">
              <span aria-hidden="true" className="text-3xl text-emerald-400">
                ✓
              </span>
              <h2 className="text-base font-semibold text-slate-100">You&apos;re all set</h2>
              <p className="text-xs text-slate-400">
                Signed in as <span className="font-semibold text-slate-200">{createdUsername}</span>. The dashboard
                is ready — add a catalog source or import your local agents next.
              </p>
              <PrimaryButton
                onClick={() => onComplete({ username: createdUsername })}
                className="mx-auto justify-center px-4 py-2"
              >
                Open dashboard
              </PrimaryButton>
            </div>
          )}

          {step === 'restored' && restoreResult !== null && (
            <div className="space-y-4">
              <Notice tone="success" title="Backup restored">
                Restored {formatNumber(restoreResult.usersRestored)} user
                {restoreResult.usersRestored === 1 ? '' : 's'}, {formatNumber(restoreResult.keysRestored)} key
                {restoreResult.keysRestored === 1 ? '' : 's'}, {formatNumber(restoreResult.serversRestored)} server
                {restoreResult.serversRestored === 1 ? '' : 's'} and{' '}
                {formatNumber(restoreResult.auditEntriesRestored)} audit entries. Sign in with your original
                password.
              </Notice>
              {restoreResult.reinstallRequired.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Servers to reinstall after sign-in
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {restoreResult.reinstallRequired.map((server) => (
                      <Badge key={server.serverId} tone="warning">
                        {server.name}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              <PrimaryButton onClick={onRestoreComplete} className="w-full justify-center">
                Go to sign in
              </PrimaryButton>
            </div>
          )}

          {step !== 'account' && step !== 'master' && step !== 'done' && error !== null && (
            <Notice tone="error" title="Setup failed" onDismiss={() => setError(null)}>
              {error}
            </Notice>
          )}
        </div>

        <p className="text-center text-[11px] text-slate-500">
          No telemetry leaves this gateway. Credentials and backups are encrypted locally.
        </p>
      </div>
    </div>
  );
}
