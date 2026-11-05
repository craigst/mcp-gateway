import { useEffect, useState } from 'react';
import { api, formatApiError, type InstagramSessionInfo } from '../../lib/api.js';
import { Card } from '../../components/Card.js';
import { Badge } from '../../components/Badge.js';
import { Notice } from '../../components/States.js';
import { TextInput, PrimaryButton, SecondaryButton } from '../../components/Form.js';

export function InstagramSessionCard() {
  const [info, setInfo] = useState<InstagramSessionInfo | null>(null);
  const [sessionid, setSessionid] = useState('');
  const [userId, setUserId] = useState('268219632');
  const [proxy, setProxy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      setInfo(await api.getInstagramSession());
    } catch (cause) {
      setError(formatApiError(cause));
    }
  };

  useEffect(() => { void load(); }, []);

  const saveSession = async (): Promise<void> => {
    setBusy(true); setError(null); setSuccess(null);
    try {
      const next = await api.setInstagramSession(sessionid.trim(), userId.trim());
      setInfo(next); setSessionid('');
      setSuccess('Instagram session saved and the Instagram/watcher services restarted.');
    } catch (cause) {
      setError(formatApiError(cause));
    } finally { setBusy(false); }
  };

  const saveProxy = async (): Promise<void> => {
    setBusy(true); setError(null); setSuccess(null);
    try {
      const next = await api.setInstagramProxy(proxy.trim());
      setInfo(next); setProxy('');
      setSuccess('Instagram proxy saved and the Instagram/watcher services restarted.');
    } catch (cause) {
      setError(formatApiError(cause));
    } finally { setBusy(false); }
  };

  return (
    <Card
      title="Instagram session"
      subtitle="Paste a fresh browser sessionid here. It is sent over stdin to the Instagram CLI and never returned by the gateway."
      actions={<SecondaryButton onClick={() => void load()}>Refresh</SecondaryButton>}
    >
      <div className="space-y-4">
        {error !== null && <Notice tone="error" title="Instagram settings failed" onDismiss={() => setError(null)}>{error}</Notice>}
        {success !== null && <Notice tone="success" title="Saved" onDismiss={() => setSuccess(null)}>{success}</Notice>}

        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          {info === null ? <span>Loading…</span> : (
            <>
              <Badge tone={info.configured ? 'success' : 'danger'}>{info.configured ? 'Session present' : 'No session'}</Badge>
              <span>{info.bytes} bytes{info.modifiedAt ? ` · ${new Date(info.modifiedAt).toLocaleString()}` : ''}</span>
              <Badge tone={info.proxyConfigured ? 'success' : 'warning'}>
                {info.proxyConfigured ? `Proxy ${info.proxyHost ?? ''}` : 'No egress proxy'}
              </Badge>
            </>
          )}
        </div>

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
      </div>
    </Card>
  );
}
