import { useEffect, useState } from 'react';
import {
  api,
  formatApiError,
  type InstagramAutoRefreshInput,
  type InstagramAutoRefreshStatus,
  type InstagramSessionInfo,
} from '../../lib/api.js';
import { Card } from '../../components/Card.js';
import { Badge } from '../../components/Badge.js';
import { Notice } from '../../components/States.js';
import { CheckboxField, TextInput, PrimaryButton, SecondaryButton } from '../../components/Form.js';

interface AutoForm {
  enabled: boolean;
  username: string;
  password: string;
  totpSecret: string;
  minIntervalHours: number;
}

const EMPTY_FORM: AutoForm = {
  enabled: false,
  username: '',
  password: '',
  totpSecret: '',
  minIntervalHours: 12,
};

export function InstagramSessionCard() {
  const [info, setInfo] = useState<InstagramSessionInfo | null>(null);
  const [auto, setAuto] = useState<InstagramAutoRefreshStatus | null>(null);
  const [sessionid, setSessionid] = useState('');
  const [userId, setUserId] = useState('268219632');
  const [proxy, setProxy] = useState('');
  const [autoForm, setAutoForm] = useState<AutoForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [savingAuto, setSavingAuto] = useState(false);
  const [testing, setTesting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const apply = (next: {
    session: InstagramSessionInfo;
    autoRefresh: InstagramAutoRefreshStatus;
  }): void => {
    setInfo(next.session);
    setAuto(next.autoRefresh);
    setAutoForm((current) => ({
      ...current,
      enabled: next.autoRefresh.enabled,
      username: next.autoRefresh.username,
      minIntervalHours: next.autoRefresh.minIntervalHours,
    }));
  };

  const load = async (): Promise<void> => {
    try {
      apply(await api.getInstagramSession());
    } catch (cause) {
      setError(formatApiError(cause));
    }
  };

  useEffect(() => { void load(); }, []);

  // Refresh asks Instagram directly (a few seconds); the plain load reads the
  // connector's state file, which is what the badge is driven by.
  const refresh = async (): Promise<void> => {
    setVerifying(true); setError(null); setSuccess(null);
    try {
      const next = await api.getInstagramSession(true);
      apply(next);
      if (next.session.verifyError !== null) setError(`Could not verify the session: ${next.session.verifyError}`);
      else if (next.session.status === 'valid') setSuccess('Checked with Instagram: the saved session is valid.');
    } catch (cause) {
      setError(formatApiError(cause));
    } finally { setVerifying(false); }
  };

  const saveSession = async (): Promise<void> => {
    setBusy(true); setError(null); setSuccess(null);
    try {
      const next = await api.setInstagramSession(sessionid.trim(), userId.trim());
      apply(next); setSessionid('');
      setSuccess('Instagram session saved and the Instagram/watcher services restarted.');
    } catch (cause) {
      setError(formatApiError(cause));
    } finally { setBusy(false); }
  };

  const saveProxy = async (): Promise<void> => {
    setBusy(true); setError(null); setSuccess(null);
    try {
      const next = await api.setInstagramProxy(proxy.trim());
      apply(next); setProxy('');
      setSuccess('Instagram proxy saved and the Instagram/watcher services restarted.');
    } catch (cause) {
      setError(formatApiError(cause));
    } finally { setBusy(false); }
  };

  const saveAuto = async (): Promise<void> => {
    setSavingAuto(true); setError(null); setSuccess(null);
    try {
      const input: InstagramAutoRefreshInput = {
        enabled: autoForm.enabled,
        username: autoForm.username.trim(),
        minIntervalHours: autoForm.minIntervalHours,
      };
      if (autoForm.password !== '') input.password = autoForm.password;
      if (autoForm.totpSecret.trim() !== '') input.totpSecret = autoForm.totpSecret.trim();
      const next = await api.saveInstagramAutoRefresh(input);
      apply(next);
      setAutoForm((current) => ({ ...current, password: '', totpSecret: '' }));
      setSuccess('Automatic re-login settings saved.');
    } catch (cause) {
      setError(formatApiError(cause));
    } finally { setSavingAuto(false); }
  };

  const testLogin = async (): Promise<void> => {
    setTesting(true); setError(null); setSuccess(null);
    try {
      const result = await api.testInstagramLogin();
      setInfo(result.session);
      setAuto(result.autoRefresh);
      setAutoForm((current) => ({ ...current, enabled: result.autoRefresh.enabled, username: result.autoRefresh.username }));
      setSuccess(`Logged in as @${result.username ?? 'unknown'} — a new session was saved and the services restarted.`);
    } catch (cause) {
      setError(formatApiError(cause));
    } finally { setTesting(false); }
  };

  return (
    <Card
      title="Instagram session"
      subtitle="Paste a fresh browser sessionid here. It is sent over stdin to the Instagram CLI and never returned by the gateway."
      actions={<SecondaryButton onClick={() => void refresh()} disabled={verifying}>{verifying ? 'Checking…' : 'Refresh'}</SecondaryButton>}
    >
      <div className="space-y-4">
        {error !== null && <Notice tone="error" title="Instagram settings failed" onDismiss={() => setError(null)}>{error}</Notice>}
        {success !== null && <Notice tone="success" title="Saved" onDismiss={() => setSuccess(null)}>{success}</Notice>}

        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          {info === null ? <span>Loading…</span> : (
            <>
              {!info.configured ? (
                <Badge tone="danger">No session</Badge>
              ) : info.status === 'expired' ? (
                <Badge tone="danger">Session expired</Badge>
              ) : info.status === 'valid' ? (
                <Badge tone="success">Session valid{info.username ? ` · @${info.username}` : ''}</Badge>
              ) : (
                <Badge tone="warning">Session present — not verified</Badge>
              )}
              <span>{info.bytes} bytes{info.modifiedAt ? ` · saved ${new Date(info.modifiedAt).toLocaleString()}` : ''}</span>
              {info.lastOkAt !== null && <span>last OK {new Date(info.lastOkAt).toLocaleString()}</span>}
              {info.verifiedAt !== null && <span>checked {new Date(info.verifiedAt).toLocaleString()}</span>}
              <Badge tone={info.proxyConfigured ? 'success' : 'warning'}>
                {info.proxyConfigured ? `Proxy ${info.proxyHost ?? ''}` : 'No egress proxy'}
              </Badge>
            </>
          )}
        </div>
        {info?.status === 'expired' && (
          <p className="text-[11px] leading-relaxed text-rose-300">
            {info.lastError ?? 'Instagram rejected the saved session.'}
            {info.lastErrorAt !== null ? ` (reported ${new Date(info.lastErrorAt).toLocaleString()})` : ''} — paste a fresh sessionid below, or let automatic re-login do it.
          </p>
        )}

        <div className="grid gap-3 lg:grid-cols-[1fr_180px_auto]">
          <label className="space-y-1 text-xs text-slate-400">
            <span>New Instagram sessionid</span>
            <TextInput
              type="password"
              value={sessionid}
              onChange={(event) => setSessionid(event.target.value)}
              placeholder="paste sessionid cookie"
              autoComplete="off"
            />
          </label>
          <label className="space-y-1 text-xs text-slate-400">
            <span>ds_user_id</span>
            <TextInput
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              placeholder="268219632"
            />
          </label>
          <div className="flex items-end">
            <PrimaryButton
              onClick={() => void saveSession()}
              disabled={busy || sessionid.trim().length < 20 || !/^\d+$/.test(userId.trim())}
              className="w-full"
            >
              {busy ? 'Saving…' : 'Save session'}
            </PrimaryButton>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-3">
          <p className="text-xs font-medium text-slate-200">Egress proxy</p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Instagram must leave through the UK pi5 proxy. Paste the full authenticated URL; it is stored only in the gateway env files.
          </p>
          <div className="mt-2 grid gap-2 lg:grid-cols-[1fr_auto]">
            <TextInput
              type="password"
              value={proxy}
              onChange={(event) => setProxy(event.target.value)}
              placeholder="socks5h://user:password@10.10.254.85:1080"
              autoComplete="off"
            />
            <PrimaryButton
              onClick={() => void saveProxy()}
              disabled={busy || !/^(socks5h?|https?):\/\//i.test(proxy.trim())}
            >
              Save proxy
            </PrimaryButton>
          </div>
        </div>

        <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/30 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-xs font-medium text-slate-200">Automatic re-login</p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                The password and 2FA seed are stored encrypted in the gateway vault. The gateway only signs in when the
                session is dead, and never more than once every {auto?.minIntervalHours ?? autoForm.minIntervalHours} h.
              </p>
            </div>
            <Badge tone={auto?.enabled === true ? 'success' : 'neutral'}>
              {auto?.enabled === true ? 'Enabled' : 'Disabled'}
            </Badge>
          </div>

          <CheckboxField
            label="Enable automatic re-login"
            checked={autoForm.enabled}
            onChange={(checked) => setAutoForm((current) => ({ ...current, enabled: checked }))}
            disabled={savingAuto}
          />

          <div className="grid gap-2 lg:grid-cols-3">
            <label className="space-y-1 text-xs text-slate-400">
              <span>Instagram username</span>
              <TextInput
                value={autoForm.username}
                onChange={(event) => setAutoForm((current) => ({ ...current, username: event.target.value }))}
                placeholder="cra1gst"
                autoComplete="username"
              />
            </label>
            <label className="space-y-1 text-xs text-slate-400">
              <span>Password</span>
              <TextInput
                type="password"
                value={autoForm.password}
                onChange={(event) => setAutoForm((current) => ({ ...current, password: event.target.value }))}
                placeholder={auto?.hasPassword === true ? 'saved — leave blank to keep' : 'account password'}
                autoComplete="current-password"
              />
            </label>
            <label className="space-y-1 text-xs text-slate-400">
              <span>2FA secret (authenticator key)</span>
              <TextInput
                type="password"
                value={autoForm.totpSecret}
                onChange={(event) => setAutoForm((current) => ({ ...current, totpSecret: event.target.value }))}
                placeholder={auto?.hasTotp === true ? 'saved — leave blank to keep' : 'JBSWY3DPEHPK3PXP'}
                autoComplete="off"
              />
              <span className="block text-[10px] leading-relaxed text-slate-600">
                Bitwarden: the item’s authenticator key (the long base32 seed), not the rotating 6-digit code.
              </span>
            </label>
          </div>

          <div className="grid gap-2 lg:grid-cols-[150px_auto_auto]">
            <label className="space-y-1 text-xs text-slate-400">
              <span>Min interval (hours)</span>
              <TextInput
                type="number"
                min={1}
                max={168}
                value={String(autoForm.minIntervalHours)}
                onChange={(event) => {
                  const parsed = Number(event.target.value);
                  setAutoForm((current) => ({
                    ...current,
                    minIntervalHours: Number.isFinite(parsed)
                      ? Math.min(168, Math.max(1, Math.round(parsed)))
                      : current.minIntervalHours,
                  }));
                }}
              />
            </label>
            <div className="flex items-end">
              <PrimaryButton
                onClick={() => void saveAuto()}
                disabled={savingAuto || auto?.vaultEnabled === false}
                className="w-full"
              >
                {savingAuto ? 'Saving…' : 'Save credentials'}
              </PrimaryButton>
            </div>
            <div className="flex items-end">
              <SecondaryButton
                onClick={() => void testLogin()}
                disabled={testing || auto?.vaultEnabled === false}
                className="w-full"
              >
                {testing ? 'Logging in…' : 'Test login now'}
              </SecondaryButton>
            </div>
          </div>

          {auto !== null && (
            <p className="text-[11px] leading-relaxed text-slate-500">
              {auto.vaultEnabled ? 'Vault ready' : 'Vault not configured'}
              {' · '}{auto.hasPassword ? 'password saved' : 'no password'}
              {' · '}{auto.hasTotp ? '2FA secret saved' : 'no 2FA secret'}
              {auto.lastAttemptAt !== null ? ` · last attempt ${new Date(auto.lastAttemptAt).toLocaleString()}` : ''}
              {auto.lastSuccessAt !== null ? ` · last success ${new Date(auto.lastSuccessAt).toLocaleString()}` : ''}
              {auto.nextEligibleAt !== null ? ` · next allowed ${new Date(auto.nextEligibleAt).toLocaleString()}` : ''}
            </p>
          )}
          {auto !== null && auto.lastError !== null && (
            <p className="text-[11px] text-rose-300">Last automatic attempt: {auto.lastError}</p>
          )}
          <p className="text-[11px] text-slate-500">
            “Test login now” performs a real sign-in and replaces the current session. The 2FA code is generated
            locally from the saved secret (current step expires in {auto?.totpSecondsRemaining ?? 30}s).
          </p>
        </div>
      </div>
    </Card>
  );
}
