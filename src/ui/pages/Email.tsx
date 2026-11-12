import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, formatApiError } from '../lib/api.js';
import type {
  EmailAccessOverview,
  EmailAccount,
  EmailAccountInput,
  EmailConnectionStatus,
  EmailFolder,
  EmailMessage,
  EmailMessageSummary,
  EmailTriageAccount,
  EmailTriageOverview,
} from '../../email/types.js';
import { Badge } from '../components/Badge.js';
import { Card } from '../components/Card.js';
import { EmptyState } from '../components/EmptyState.js';
import { SkeletonBlock } from '../components/Skeleton.js';
import { cx } from '../lib/cx.js';
import { EmailAccessDialog } from './email/EmailAccessDialog.js';
import { EmailTriageDrawer } from './email/EmailTriageDrawer.js';

type ComposeState = {
  open: boolean;
  mode: 'new' | 'reply' | 'forward';
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string[];
};

const EMPTY_COMPOSE: ComposeState = {
  open: false,
  mode: 'new',
  to: '',
  cc: '',
  bcc: '',
  subject: '',
  body: '',
};

const SPECIAL_FOLDERS = new Set(['INBOX', 'Sent', 'Drafts', 'Trash', 'Archive', 'Junk']);

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function folderLabel(folder: EmailFolder): string {
  return folder.specialUse?.replace(/^\\/, '') ?? folder.name ?? folder.path;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { day: '2-digit', month: 'short' });
}

function senderName(value: string): string {
  const match = /^([^<]+)</.exec(value);
  return (match?.[1] ?? value).trim() || value;
}

export function EmailPage() {
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [status, setStatus] = useState<Record<string, EmailConnectionStatus>>({});
  const [activeAccount, setActiveAccount] = useState<string | null>(null);
  const [folders, setFolders] = useState<EmailFolder[]>([]);
  const [activeFolder, setActiveFolder] = useState('INBOX');
  const [messages, setMessages] = useState<EmailMessageSummary[]>([]);
  const [selected, setSelected] = useState<EmailMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [compose, setCompose] = useState<ComposeState>(EMPTY_COMPOSE);
  const [showAccountDialog, setShowAccountDialog] = useState(false);
  const [editing, setEditing] = useState<EmailAccount | null>(null);
  const [sending, setSending] = useState(false);
  // Access overview is fetched separately so a failure never blocks the mailbox list.
  const [access, setAccess] = useState<EmailAccessOverview | null>(null);
  const [accessLoading, setAccessLoading] = useState(true);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [showAccess, setShowAccess] = useState(false);
  const [accessFocus, setAccessFocus] = useState<string | null>(null);
  // Triage is fetched separately too: which mailboxes are watched must never
  // depend on the access view loading.
  const [triage, setTriage] = useState<EmailTriageOverview | null>(null);
  const [triageLoading, setTriageLoading] = useState(true);
  const [triageFocus, setTriageFocus] = useState<string | null>(null);
  const [showTriage, setShowTriage] = useState(false);

  const active = useMemo(() => accounts.find((account) => account.id === activeAccount) ?? null, [accounts, activeAccount]);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listEmailAccounts();
      setAccounts(list);
      setActiveAccount((current) => current ?? list.find((account) => account.isDefault)?.id ?? list[0]?.id ?? null);
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const loadAccess = useCallback(async () => {
    setAccessLoading(true);
    try {
      setAccess(await api.getEmailAccess());
      setAccessError(null);
    } catch (cause) {
      setAccessError(formatApiError(cause));
    } finally {
      setAccessLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAccess();
  }, [loadAccess]);

  const loadTriage = useCallback(async () => {
    setTriageLoading(true);
    try {
      setTriage(await api.getEmailTriage());
    } catch {
      // A triage failure must not stop the mailbox list from rendering.
      setTriage(null);
    } finally {
      setTriageLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTriage();
  }, [loadTriage]);

  const triageByAccount = useMemo(() => {
    const map = new Map<string, EmailTriageAccount>();
    for (const entry of triage?.accounts ?? []) map.set(entry.accountId, entry);
    return map;
  }, [triage]);

  const openTriage = (accountId: string): void => {
    setTriageFocus(accountId);
    setShowTriage(true);
  };

  const applyTriage = useCallback((next: EmailTriageAccount) => {
    setTriage((current) =>
      current === null
        ? current
        : { ...current, accounts: current.accounts.map((entry) => (entry.accountId === next.accountId ? next : entry)) },
    );
  }, []);

  const accessCounts = useMemo(() => {
    const counts = new Map<string, { bots: number; keys: number }>();
    if (access === null) return counts;
    for (const account of access.accounts) {
      counts.set(account.id, {
        bots: access.bots.filter((subject) => subject.emailEnabled && subject.accounts[account.id] !== false).length,
        keys: access.keys.filter((subject) => subject.emailEnabled && subject.accounts[account.id] !== false).length,
      });
    }
    return counts;
  }, [access]);

  const openAccess = (accountId: string | null = null): void => {
    setAccessFocus(accountId);
    setShowAccess(true);
  };

  useEffect(() => {
    if (activeAccount === null) {
      setFolders([]);
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoadingMessages(true);
    setError(null);
    Promise.all([
      api.testEmailAccount(activeAccount).catch((cause): EmailConnectionStatus => ({
        accountId: activeAccount,
        ok: false,
        folders: 0,
        latencyMs: 0,
        checkedAt: new Date().toISOString(),
        error: formatApiError(cause),
      })),
      api.listEmailFolders(activeAccount).catch(() => []),
    ])
      .then(([connection, folderList]) => {
        if (cancelled) return;
        setStatus((current) => ({ ...current, [activeAccount]: connection }));
        setFolders(folderList);
        setActiveFolder((current) => {
          const wanted = folderList.some((folder) => folder.path === current) ? current : 'INBOX';
          return folderList.some((folder) => folder.path === wanted) ? wanted : folderList[0]?.path ?? 'INBOX';
        });
      })
      .catch((cause) => {
        if (!cancelled) setError(formatApiError(cause));
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeAccount]);

  const loadMessages = useCallback(async () => {
    if (activeAccount === null) return;
    setLoadingMessages(true);
    setError(null);
    setSelected(null);
    try {
      setMessages(
        await api.listEmailMessages(activeAccount, {
          folder: activeFolder,
          limit: 50,
          unreadOnly,
          search: search.trim() || undefined,
        }),
      );
    } catch (cause) {
      setError(formatApiError(cause));
      setMessages([]);
    } finally {
      setLoadingMessages(false);
    }
  }, [activeAccount, activeFolder, search, unreadOnly]);

  useEffect(() => {
    if (activeAccount !== null) void loadMessages();
  }, [loadMessages, activeAccount]);

  const openMessage = async (summary: EmailMessageSummary) => {
    if (activeAccount === null) return;
    setError(null);
    try {
      const message = await api.readEmailMessage(activeAccount, summary.uid, activeFolder);
      setSelected(message);
      if (message.unread) {
        await api.markEmailRead(activeAccount, summary.uid, true, activeFolder);
        setMessages((current) => current.map((row) => (row.uid === summary.uid ? { ...row, unread: false } : row)));
      }
    } catch (cause) {
      setError(formatApiError(cause));
    }
  };

  const openCompose = (mode: ComposeState['mode'], message?: EmailMessage) => {
    if (mode === 'new') {
      setCompose({ ...EMPTY_COMPOSE, open: true, mode });
      return;
    }
    if (message === undefined) return;
    if (mode === 'reply') {
      setCompose({
        open: true,
        mode,
        to: message.replyTo || message.from,
        cc: '',
        bcc: '',
        subject: message.subject.toLowerCase().startsWith('re:') ? message.subject : `Re: ${message.subject}`,
        body: `\n\n---\nOn ${new Date(message.date).toLocaleString()}, ${message.from} wrote:\n${message.text}`,
        inReplyTo: message.messageId,
        references: [...message.references, ...(message.messageId ? [message.messageId] : [])],
      });
    } else {
      setCompose({
        open: true,
        mode,
        to: '',
        cc: '',
        bcc: '',
        subject: message.subject.toLowerCase().startsWith('fwd:') ? message.subject : `Fwd: ${message.subject}`,
        body: `\n\n--- Forwarded message ---\nFrom: ${message.from}\nSubject: ${message.subject}\n\n${message.text}`,
      });
    }
  };

  const sendCompose = async () => {
    if (activeAccount === null) return;
    setSending(true);
    setError(null);
    try {
      await api.sendEmail(activeAccount, {
        to: compose.to,
        cc: compose.cc || undefined,
        bcc: compose.bcc || undefined,
        subject: compose.subject,
        text: compose.body,
        inReplyTo: compose.inReplyTo ?? null,
        references: compose.references,
      });
      setCompose(EMPTY_COMPOSE);
      await loadMessages();
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setSending(false);
    }
  };

  const deleteMessage = async () => {
    if (activeAccount === null || selected === null) return;
    if (!window.confirm(`Delete "${selected.subject}"?`)) return;
    try {
      await api.deleteEmailMessage(activeAccount, selected.uid, activeFolder);
      setSelected(null);
      await loadMessages();
    } catch (cause) {
      setError(formatApiError(cause));
    }
  };

  const saveAccount = async (input: EmailAccountInput) => {
    try {
      if (editing === null) await api.createEmailAccount(input);
      else await api.updateEmailAccount(editing.id, input);
      setShowAccountDialog(false);
      setEditing(null);
      await loadAccounts();
    } catch (cause) {
      setError(formatApiError(cause));
    }
  };

  const removeAccount = async (account: EmailAccount) => {
    if (!window.confirm(`Remove the "${account.name}" email account?`)) return;
    try {
      await api.deleteEmailAccount(account.id);
      setActiveAccount(null);
      await loadAccounts();
    } catch (cause) {
      setError(formatApiError(cause));
    }
  };

  const connection = activeAccount === null ? undefined : status[activeAccount];
  const shownFolders = folders.filter((folder) => {
    if (folder.path === activeFolder) return true;
    if (SPECIAL_FOLDERS.has(folder.path)) return true;
    return folder.specialUse !== null || /inbox|sent|draft|trash|archive|junk|spam/i.test(folder.path);
  });

  return (
    <div className="space-y-4">
      {error !== null && (
        <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[220px_260px_minmax(0,1fr)]">
        {/* Accounts */}
        <Card className="p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-slate-100">Mailboxes</p>
              <p className="text-[11px] text-slate-500">{accounts.length} account{accounts.length === 1 ? '' : 's'}</p>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => openAccess(null)}
                className="rounded-md border border-slate-700 px-2 py-1 text-xs font-semibold text-slate-300 hover:bg-slate-800"
                title="See which bots and API keys can use email"
                aria-label="Manage email access from the mailbox list"
              >
                Access
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setShowAccountDialog(true);
                }}
                className="rounded-md border border-slate-700 px-2 py-1 text-xs font-semibold text-slate-300 hover:bg-slate-800"
                title="Add an email account"
              >
                + Add
              </button>
            </div>
          </div>
          {loading ? (
            <div className="space-y-2">
              <SkeletonBlock className="h-14 w-full" />
              <SkeletonBlock className="h-14 w-full" />
            </div>
          ) : accounts.length === 0 ? (
            <EmptyState title="No email accounts" description="Import the Odysseus accounts or add one manually." />
          ) : (
            <div className="space-y-1">
              {accounts.map((account) => {
                const accountStatus = status[account.id];
                const connected = accountStatus?.ok ?? account.lastTestOk;
                const accessCount = accessCounts.get(account.id) ?? { bots: 0, keys: 0 };
                const accessLabel =
                  access !== null
                    ? `Access: ${plural(accessCount.bots, 'bot')} · ${plural(accessCount.keys, 'key')}`
                    : accessLoading
                      ? 'Access: checking…'
                      : 'Access: unavailable';
                const triageEntry = triageByAccount.get(account.id);
                const triageLabel =
                  triageEntry === undefined
                    ? triageLoading
                      ? 'Triage: checking…'
                      : 'Triage: unavailable'
                    : triageEntry.enabled
                      ? triageEntry.mode === 'full'
                        ? 'Triage: on · cards + filing'
                        : 'Triage: on · cards only'
                      : 'Triage: off';
                return (
                  <div
                    key={account.id}
                    className={cx(
                      'rounded-lg border transition-colors',
                      account.id === activeAccount
                        ? 'border-sky-500/50 bg-sky-500/10'
                        : 'border-transparent hover:border-slate-700 hover:bg-slate-900',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setActiveAccount(account.id);
                        setActiveFolder('INBOX');
                        setSelected(null);
                      }}
                      className="w-full px-2.5 pt-2 text-left"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-semibold text-slate-200">{account.name}</span>
                        <span
                          className={cx(
                            'h-2 w-2 shrink-0 rounded-full',
                            connected === true ? 'bg-emerald-400' : connected === false ? 'bg-rose-400' : 'bg-slate-600',
                          )}
                          title={connected === true ? 'Connected' : connected === false ? 'Not connected' : 'Not tested'}
                        />
                      </div>
                      <p className="mt-0.5 truncate text-[11px] text-slate-500">{account.email}</p>
                      {accountStatus?.ok === false && accountStatus.error !== null && (
                        <p className="mt-1 line-clamp-2 text-[10px] text-rose-300">{accountStatus.error}</p>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => openAccess(account.id)}
                      aria-label={`Manage access to ${account.name}`}
                      title={`Who can use the ${account.name} mailbox`}
                      className="w-full px-2.5 pt-1 text-left text-[10px] font-medium text-slate-500 transition-colors hover:text-sky-300"
                    >
                      {accessLabel}
                    </button>
                    <button
                      type="button"
                      onClick={() => openTriage(account.id)}
                      aria-label={`Manage triage for ${account.name}`}
                      title={`Whether new mail in ${account.name} is judged and drafted for you`}
                      className={cx(
                        'w-full rounded-b-lg px-2.5 pb-1.5 pt-0.5 text-left text-[10px] font-medium transition-colors',
                        triageEntry?.enabled === true ? 'text-emerald-400/80 hover:text-emerald-300' : 'text-slate-500 hover:text-sky-300',
                      )}
                    >
                      {triageLabel}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {active !== null && (
            <div className="mt-3 space-y-2 border-t border-slate-800 pt-3">
              <button
                type="button"
                onClick={() => {
                  setEditing(active);
                  setShowAccountDialog(true);
                }}
                className="w-full rounded-md border border-slate-700 px-2 py-1 text-xs font-semibold text-slate-300 hover:bg-slate-800"
              >
                Account settings
              </button>
              <button
                type="button"
                onClick={() => void removeAccount(active)}
                className="w-full rounded-md border border-rose-500/30 px-2 py-1 text-xs font-semibold text-rose-300 hover:bg-rose-500/10"
              >
                Remove account
              </button>
            </div>
          )}
        </Card>

        {/* Folders + message list */}
        <Card className="flex min-h-[70vh] flex-col p-0">
          <div className="border-b border-slate-800 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-slate-100">Mail</span>
              <button
                type="button"
                onClick={() => void loadMessages()}
                className="rounded-md border border-slate-700 px-2 py-1 text-[11px] font-semibold text-slate-300 hover:bg-slate-800"
              >
                Refresh
              </button>
            </div>
            <div className="mt-2 flex gap-1 overflow-x-auto">
              {shownFolders.slice(0, 6).map((folder) => (
                <button
                  key={folder.path}
                  type="button"
                  onClick={() => {
                    setActiveFolder(folder.path);
                    setSelected(null);
                  }}
                  className={cx(
                    'shrink-0 rounded-full border px-2 py-1 text-[10px] font-semibold',
                    activeFolder === folder.path
                      ? 'border-sky-500/50 bg-sky-500/10 text-sky-200'
                      : 'border-slate-700 text-slate-400 hover:bg-slate-800',
                  )}
                >
                  {folderLabel(folder)}
                </button>
              ))}
              {shownFolders.length > 6 && <span className="self-center text-[10px] text-slate-600">…</span>}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void loadMessages();
                }}
                placeholder="Search this mailbox"
                className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600"
              />
              <label className="flex items-center gap-1 text-[10px] text-slate-400">
                <input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} />
                Unread
              </label>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loadingMessages ? (
              <div className="space-y-2 p-3">
                <SkeletonBlock className="h-16 w-full" />
                <SkeletonBlock className="h-16 w-full" />
                <SkeletonBlock className="h-16 w-full" />
              </div>
            ) : messages.length === 0 ? (
              <div className="p-4">
                <EmptyState title="No messages" description={activeFolder === 'INBOX' ? 'This inbox is empty.' : 'No messages in this folder.'} />
              </div>
            ) : (
              <ul className="divide-y divide-slate-800">
                {messages.map((message) => (
                  <li key={message.uid}>
                    <button
                      type="button"
                      onClick={() => void openMessage(message)}
                      className={cx(
                        'w-full px-3 py-2.5 text-left transition-colors hover:bg-slate-900',
                        selected?.uid === message.uid && 'bg-slate-900',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={cx('truncate text-xs', message.unread ? 'font-bold text-slate-100' : 'font-medium text-slate-300')}>
                          {senderName(message.from) || '(unknown sender)'}
                        </span>
                        <span className="shrink-0 text-[10px] text-slate-500">{formatDate(message.date)}</span>
                      </div>
                      <p className={cx('mt-0.5 truncate text-xs', message.unread ? 'font-semibold text-slate-200' : 'text-slate-400')}>
                        {message.subject}
                      </p>
                      <div className="mt-1 flex items-center gap-1.5">
                        {message.unread && <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />}
                        {message.flagged && <span className="text-[10px] text-amber-300">★</span>}
                        <span className="truncate text-[10px] text-slate-600">{message.to}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        {/* Reader */}
        <Card className="flex min-h-[70vh] flex-col p-0">
          {selected === null ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState
                title={active === null ? 'Choose an account' : 'Select a message'}
                description={active === null ? 'Pick a mailbox on the left to browse email.' : 'Select a message to read it here.'}
              />
            </div>
          ) : (
            <>
              <div className="border-b border-slate-800 px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-slate-100">{selected.subject}</h2>
                    <p className="mt-1 truncate text-xs text-slate-400">
                      {selected.from} → {selected.to}
                    </p>
                    <p className="text-[11px] text-slate-500">{new Date(selected.date).toLocaleString()}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button type="button" onClick={() => openCompose('reply', selected)} className="rounded-md border border-slate-700 px-2 py-1 text-[11px] font-semibold text-slate-300 hover:bg-slate-800">
                      Reply
                    </button>
                    <button type="button" onClick={() => openCompose('forward', selected)} className="rounded-md border border-slate-700 px-2 py-1 text-[11px] font-semibold text-slate-300 hover:bg-slate-800">
                      Forward
                    </button>
                    <button type="button" onClick={() => void deleteMessage()} className="rounded-md border border-rose-500/30 px-2 py-1 text-[11px] font-semibold text-rose-300 hover:bg-rose-500/10">
                      Delete
                    </button>
                  </div>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap px-4 py-3 text-sm text-slate-300">
                {selected.text || (selected.html ? 'This message has HTML content; ask support to render it.' : '(no text content)')}
              </div>
              {selected.attachments.length > 0 && (
                <div className="border-t border-slate-800 px-4 py-2">
                  <p className="text-[11px] font-semibold text-slate-400">Attachments</p>
                  <ul className="mt-1 space-y-1">
                    {selected.attachments.map((attachment) => (
                      <li key={attachment.part} className="text-[11px] text-slate-500">
                        {attachment.filename ?? 'attachment'} · {attachment.contentType} · {Math.ceil(attachment.size / 1024)} KB
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </Card>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          {connection === undefined ? (
            <span>Checking connection…</span>
          ) : connection.ok ? (
            <Badge tone="success">Connected · {connection.latencyMs} ms</Badge>
          ) : (
            <Badge tone="danger">Not connected</Badge>
          )}
          {active !== null && <span>{active.imapUser} via {active.imapHost}:{active.imapPort}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => openAccess(null)}
            aria-label="Manage email access"
            title="See which bots and API keys can use email"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-800"
          >
            Access
            {access !== null && (
              <span className="rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-slate-300">
                {access.bots.length + access.keys.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => openCompose('new')}
            disabled={activeAccount === null}
            className="rounded-lg bg-sky-500 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            New email
          </button>
        </div>
      </div>

      {compose.open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 p-4 sm:items-center">
          <div className="w-full max-w-2xl rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-100">
                {compose.mode === 'reply' ? 'Reply' : compose.mode === 'forward' ? 'Forward' : 'New email'}
              </h3>
              <button type="button" onClick={() => setCompose(EMPTY_COMPOSE)} className="text-slate-400 hover:text-slate-200">
                ✕
              </button>
            </div>
            <div className="space-y-2 p-4">
              <input
                value={compose.to}
                onChange={(event) => setCompose({ ...compose, to: event.target.value })}
                placeholder="To"
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={compose.cc}
                  onChange={(event) => setCompose({ ...compose, cc: event.target.value })}
                  placeholder="Cc"
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                />
                <input
                  value={compose.bcc}
                  onChange={(event) => setCompose({ ...compose, bcc: event.target.value })}
                  placeholder="Bcc"
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                />
              </div>
              <input
                value={compose.subject}
                onChange={(event) => setCompose({ ...compose, subject: event.target.value })}
                placeholder="Subject"
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
              />
              <textarea
                value={compose.body}
                onChange={(event) => setCompose({ ...compose, body: event.target.value })}
                rows={10}
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-800 px-4 py-3">
              <button type="button" onClick={() => setCompose(EMPTY_COMPOSE)} className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-800">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void sendCompose()}
                disabled={sending || compose.to.trim() === '' || compose.subject.trim() === ''}
                className="rounded-md bg-sky-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}

      <EmailAccessDialog
        open={showAccess}
        onClose={() => setShowAccess(false)}
        overview={access}
        loading={accessLoading}
        error={accessError}
        onRefresh={loadAccess}
        focusAccountId={accessFocus}
      />

      <EmailTriageDrawer
        open={showTriage}
        triage={triageFocus === null ? null : (triageByAccount.get(triageFocus) ?? null)}
        onClose={() => setShowTriage(false)}
        onSaved={applyTriage}
      />

      {showAccountDialog && (
        <AccountDialog
          account={editing}
          onClose={() => {
            setShowAccountDialog(false);
            setEditing(null);
          }}
          onSave={saveAccount}
        />
      )}
    </div>
  );
}

function AccountDialog({
  account,
  onClose,
  onSave,
}: {
  account: EmailAccount | null;
  onClose: () => void;
  onSave: (input: EmailAccountInput) => Promise<void>;
}) {
  const [form, setForm] = useState<EmailAccountInput>({
    name: account?.name ?? '',
    email: account?.email ?? '',
    displayName: account?.displayName ?? '',
    kind: account?.kind ?? 'imap',
    imapHost: account?.imapHost ?? '',
    imapPort: account?.imapPort ?? 143,
    imapSecure: account?.imapSecure ?? false,
    imapStartTls: account?.imapStartTls ?? true,
    imapUser: account?.imapUser ?? '',
    imapPassword: '',
    smtpHost: account?.smtpHost ?? '',
    smtpPort: account?.smtpPort ?? 25,
    smtpSecure: account?.smtpSecure ?? false,
    smtpUser: account?.smtpUser ?? '',
    smtpPassword: '',
    fromAddress: account?.fromAddress ?? '',
    enabled: account?.enabled ?? true,
    isDefault: account?.isDefault ?? false,
  });
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof EmailAccountInput>(key: K, value: EmailAccountInput[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/70 p-4 sm:items-center">
      <div className="w-full max-w-2xl rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-100">{account === null ? 'Add email account' : 'Email account settings'}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-200">✕</button>
        </div>
        <div className="grid max-h-[75vh] gap-3 overflow-y-auto p-4 sm:grid-cols-2">
          {[
            ['name', 'Account name', 'text'],
            ['email', 'Email address', 'email'],
            ['displayName', 'Display name', 'text'],
            ['fromAddress', 'From address', 'email'],
          ].map(([key, label, type]) => (
            <label key={key} className="space-y-1 text-xs text-slate-400">
              <span>{label}</span>
              <input
                type={type}
                value={String(form[key as keyof EmailAccountInput] ?? '')}
                onChange={(event) => set(key as keyof EmailAccountInput, event.target.value as never)}
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
              />
            </label>
          ))}
          <label className="space-y-1 text-xs text-slate-400">
            <span>Kind</span>
            <select
              value={form.kind}
              onChange={(event) => set('kind', event.target.value as EmailAccountInput['kind'])}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
            >
              <option value="imap">IMAP</option>
              <option value="proton">Proton Bridge / local mail</option>
              <option value="gmail">Gmail</option>
            </select>
          </label>
          <div className="sm:col-span-2">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Incoming IMAP</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input value={form.imapHost} onChange={(event) => set('imapHost', event.target.value)} placeholder="imap host" className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200" />
              <input type="number" value={form.imapPort} onChange={(event) => set('imapPort', Number(event.target.value))} placeholder="port" className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200" />
              <input value={form.imapUser} onChange={(event) => set('imapUser', event.target.value)} placeholder="username" className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200" />
              <input type="password" value={form.imapPassword ?? ''} onChange={(event) => set('imapPassword', event.target.value)} placeholder={account === null ? 'password' : 'leave blank to keep'} className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200" />
            </div>
            <div className="mt-2 flex gap-4 text-xs text-slate-400">
              <label className="flex items-center gap-1"><input type="checkbox" checked={form.imapSecure} onChange={(event) => set('imapSecure', event.target.checked)} /> SSL/TLS</label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={form.imapStartTls} onChange={(event) => set('imapStartTls', event.target.checked)} /> STARTTLS</label>
            </div>
          </div>
          <div className="sm:col-span-2">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Outgoing SMTP</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input value={form.smtpHost} onChange={(event) => set('smtpHost', event.target.value)} placeholder="smtp host" className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200" />
              <input type="number" value={form.smtpPort} onChange={(event) => set('smtpPort', Number(event.target.value))} placeholder="port" className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200" />
              <input value={form.smtpUser} onChange={(event) => set('smtpUser', event.target.value)} placeholder="username" className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200" />
              <input type="password" value={form.smtpPassword ?? ''} onChange={(event) => set('smtpPassword', event.target.value)} placeholder={account === null ? 'password' : 'leave blank to keep'} className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200" />
            </div>
            <label className="mt-2 flex items-center gap-1 text-xs text-slate-400"><input type="checkbox" checked={form.smtpSecure} onChange={(event) => set('smtpSecure', event.target.checked)} /> SSL/TLS</label>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={form.enabled} onChange={(event) => set('enabled', event.target.checked)} /> Enabled</label>
          <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={form.isDefault} onChange={(event) => set('isDefault', event.target.checked)} /> Default account</label>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-800 px-4 py-3">
          <button type="button" onClick={onClose} className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-800">Cancel</button>
          <button
            type="button"
            onClick={() => {
              setSaving(true);
              void onSave(form).finally(() => setSaving(false));
            }}
            disabled={saving || form.name.trim() === '' || form.imapHost.trim() === '' || form.smtpHost.trim() === ''}
            className="rounded-md bg-sky-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
