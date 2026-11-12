import { useEffect, useMemo, useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import type {
  EmailAccessAccount,
  EmailAccessOverview,
  EmailAccessSubject,
} from '../../../email/types.js';
import { Badge } from '../../components/Badge.js';
import { Drawer } from '../../components/Drawer.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorState, LoadingState, Notice } from '../../components/States.js';
import { TabPanel, Tabs } from '../../components/Tabs.js';
import { cx } from '../../lib/cx.js';
import { formatTimestamp } from '../../lib/format.js';

export type EmailAccessSegment = 'bots' | 'keys';

export interface EmailAccessDialogProps {
  open: boolean;
  onClose: () => void;
  /** The access overview fetched by the Email page; null while unavailable. */
  overview: EmailAccessOverview | null;
  loading?: boolean;
  error?: string | null;
  /** Refetch the overview after a successful change. */
  onRefresh: () => void | Promise<void>;
  /** Mailbox to focus when the drawer was opened from a mailbox row. */
  focusAccountId?: string | null;
}

interface PendingChange {
  subjectId: string;
  target: string;
}

function subjectLabel(subject: EmailAccessSubject): string {
  return subject.name.trim() !== '' ? subject.name : (subject.keyName ?? subject.slug ?? subject.id);
}

function subjectSubtitle(subject: EmailAccessSubject): string {
  const parts: string[] = [];
  if (subject.kind === 'bot') {
    if (subject.title !== null && subject.title.trim() !== '') parts.push(subject.title);
    if (subject.slug !== null && subject.slug.trim() !== '') parts.push(`@${subject.slug}`);
    if (subject.keyName !== null && subject.keyName.trim() !== '') parts.push(subject.keyName);
  } else {
    if (subject.keyType !== null && subject.keyType.trim() !== '') parts.push(subject.keyType);
    if (subject.keyPrefix !== null && subject.keyPrefix.trim() !== '') parts.push(subject.keyPrefix);
  }
  return parts.join(' · ');
}

/** Effective mailbox access: a missing decision inherits the allow default. */
function accountAllowed(subject: EmailAccessSubject, accountId: string): boolean {
  return subject.accounts[accountId] !== false;
}

function hasFullAccess(subject: EmailAccessSubject): boolean {
  return (
    subject.emailEnabled &&
    !subject.emailPaused &&
    !subject.revoked &&
    subject.totalToolCount > 0 &&
    subject.grantedToolCount >= subject.totalToolCount
  );
}

/** Master switch is unavailable when there is no link, or the key is locked/revoked. */
function masterDisabled(subject: EmailAccessSubject): boolean {
  return subject.keyId === null || subject.locked || subject.revoked;
}

function disabledReason(subject: EmailAccessSubject): string | undefined {
  if (subject.keyId === null) return 'This bot has no gateway key — link one in the gateway first.';
  if (subject.revoked) return 'This API key is revoked.';
  if (subject.locked) return 'Master keys always have email access.';
  return undefined;
}

function masterHint(subject: EmailAccessSubject, pending: boolean): string {
  if (subject.keyId === null) return 'No gateway key';
  if (subject.revoked) return 'Revoked';
  if (subject.locked) return 'Always allowed';
  if (pending) return 'Saving…';
  if (subject.emailEnabled) return 'On';
  if (subject.emailPaused) return 'Paused';
  return 'Off';
}

function matchesSearch(subject: EmailAccessSubject, query: string): boolean {
  if (query.trim() === '') return true;
  const needle = query.trim().toLowerCase();
  return [
    subject.name,
    subject.title,
    subject.slug,
    subject.botId,
    subject.keyId,
    subject.keyName,
    subject.keyType,
    subject.keyPrefix,
  ].some((value) => value !== null && value.toLowerCase().includes(needle));
}

function filterSubjects(subjects: readonly EmailAccessSubject[], query: string): EmailAccessSubject[] {
  return subjects.filter((subject) => matchesSearch(subject, query));
}

interface SwitchProps {
  checked: boolean;
  disabled?: boolean;
  label: string;
  title?: string;
  onToggle: () => void;
}

function Switch({ checked, disabled = false, label, title, onToggle }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      title={title}
      onClick={onToggle}
      className={cx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70 disabled:cursor-not-allowed disabled:opacity-40',
        checked ? 'border-emerald-700 bg-emerald-600/70' : 'border-slate-700 bg-slate-800',
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

function SubjectBadges({ subject }: { subject: EmailAccessSubject }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {subject.kind === 'bot' && subject.keyId === null && <Badge tone="warning">No gateway key</Badge>}
      {subject.revoked && <Badge tone="danger">Revoked</Badge>}
      {!subject.revoked && subject.emailPaused && <Badge tone="warning">Paused</Badge>}
      {!subject.revoked &&
        !subject.emailPaused &&
        !subject.emailGranted &&
        subject.keyId !== null && <Badge tone="neutral">Not granted</Badge>}
      {subject.locked && <Badge tone="info">Master key</Badge>}
      {hasFullAccess(subject) && <Badge tone="success">Full access</Badge>}
    </span>
  );
}

interface SubjectCardProps {
  subject: EmailAccessSubject;
  accounts: readonly EmailAccessAccount[];
  pending: PendingChange | null;
  error: string | null;
  focusedAccountId: string | null;
  onToggleMaster: (subject: EmailAccessSubject) => void;
  onToggleAccount: (subject: EmailAccessSubject, account: EmailAccessAccount) => void;
}

function SubjectCard({
  subject,
  accounts,
  pending,
  error,
  focusedAccountId,
  onToggleMaster,
  onToggleAccount,
}: SubjectCardProps) {
  const label = subjectLabel(subject);
  const rowPending = pending !== null && pending.subjectId === subject.id;
  const anyPending = pending !== null;
  const controlsDisabled = masterDisabled(subject);
  const subtitle = subjectSubtitle(subject);
  const reason = disabledReason(subject);
  const hint = masterHint(subject, rowPending && pending?.target === 'master');
  const busyTarget = rowPending ? pending?.target : null;

  return (
    <article
      aria-busy={rowPending}
      className={cx(
        'rounded-xl border bg-slate-900/60 p-3 transition-colors',
        rowPending ? 'border-sky-500/40' : 'border-slate-800',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-slate-100">{label}</h3>
            <SubjectBadges subject={subject} />
          </div>
          {subtitle !== '' && <p className="mt-0.5 truncate text-[11px] text-slate-500">{subtitle}</p>}
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
            <span>
              {subject.grantedToolCount}/{subject.totalToolCount} email tools
            </span>
            <span>Last used {subject.lastUsedAt === null ? 'never' : formatTimestamp(subject.lastUsedAt)}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="text-right">
            <p className="text-[11px] font-medium text-slate-300">Email access</p>
            <p className={cx('text-[10px]', rowPending ? 'text-sky-300' : 'text-slate-500')}>{hint}</p>
          </div>
          <Switch
            checked={subject.emailEnabled}
            disabled={controlsDisabled || anyPending}
            label={`Email access for ${label}`}
            title={reason}
            onToggle={() => onToggleMaster(subject)}
          />
        </div>
      </div>

      {reason !== undefined && <p className="mt-1 text-[11px] text-amber-200/80">{reason}</p>}

      <div className="mt-3 border-t border-slate-800 pt-2">
        <p className="text-[10px] font-semibold tracking-wide text-slate-500 uppercase">Mailboxes</p>
        {accounts.length === 0 ? (
          <p className="mt-1 text-[11px] text-slate-500">No mailboxes have been configured yet.</p>
        ) : (
          <div className="mt-1 space-y-1">
            {accounts.map((account) => {
              const allowed = accountAllowed(subject, account.id);
              const focused = focusedAccountId === account.id;
              const mailboxPending = busyTarget === `account:${account.id}`;
              const disabled = !subject.emailEnabled || controlsDisabled || anyPending;
              return (
                <div
                  key={account.id}
                  data-email-access-focus={focused ? 'true' : undefined}
                  className={cx(
                    'flex items-center justify-between gap-3 rounded-lg px-2 py-1.5',
                    focused
                      ? 'border border-sky-500/40 bg-sky-500/5'
                      : 'border border-transparent',
                  )}
                >
                  <div className="min-w-0">
                    <p
                      className={cx(
                        'truncate text-xs font-medium',
                        allowed ? 'text-slate-200' : 'text-slate-500',
                      )}
                    >
                      {account.name}
                      {account.isDefault && <span className="ml-1 text-[10px] font-normal text-slate-500">default</span>}
                    </p>
                    <p className="truncate text-[10px] text-slate-500">{account.email}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {mailboxPending && <span className="text-[10px] text-sky-300">Saving…</span>}
                    <Switch
                      checked={allowed}
                      disabled={disabled}
                      label={`${account.name} mailbox for ${label}`}
                      title={
                        subject.emailEnabled
                          ? undefined
                          : 'Turn on email access for this subject first.'
                      }
                      onToggle={() => onToggleAccount(subject, account)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {error !== null && (
        <p
          role="alert"
          className="mt-2 rounded-md border border-rose-900/60 bg-rose-950/30 px-2 py-1 text-[11px] text-rose-200"
        >
          {error}
        </p>
      )}
    </article>
  );
}

/**
 * Operator view of who can use the shared email MCP server.
 *
 * Each row is an access subject (an OMB bot bound to a gateway key, or a plain
 * API key). The master switch enables/pauses the subject's whole `email` grant;
 * the per-mailbox switches record explicit account decisions.
 */
export function EmailAccessDialog({
  open,
  onClose,
  overview,
  loading = false,
  error = null,
  onRefresh,
  focusAccountId = null,
}: EmailAccessDialogProps) {
  const [segment, setSegment] = useState<EmailAccessSegment>('bots');
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [focusedAccount, setFocusedAccount] = useState<string | null>(null);

  // Opening from a mailbox row focuses that mailbox; a plain open clears it.
  useEffect(() => {
    if (!open) return;
    setFocusedAccount(focusAccountId ?? null);
    setRowErrors({});
  }, [open, focusAccountId]);

  useEffect(() => {
    if (open) setSearch('');
  }, [open]);

  // Bring the focused mailbox into view (the drawer body scrolls).
  useEffect(() => {
    if (!open || focusedAccount === null) return;
    const element = document.querySelector('[data-email-access-focus="true"]') as HTMLElement | null;
    if (element !== null && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest' });
    }
  }, [open, focusedAccount, overview, segment]);

  const bots = overview?.bots ?? [];
  const keys = overview?.keys ?? [];
  const accounts = overview?.accounts ?? [];
  const server = overview?.server ?? null;

  const filteredBots = useMemo(() => filterSubjects(bots, search), [bots, search]);
  const filteredKeys = useMemo(() => filterSubjects(keys, search), [keys, search]);

  const focusedAccountName = useMemo(() => {
    if (focusedAccount === null) return null;
    return accounts.find((account) => account.id === focusedAccount)?.name ?? null;
  }, [accounts, focusedAccount]);

  const setRowError = (subjectId: string, message: string | null): void => {
    setRowErrors((current) => {
      const next = { ...current };
      if (message === null) delete next[subjectId];
      else next[subjectId] = message;
      return next;
    });
  };

  const refreshSafely = async (): Promise<void> => {
    try {
      await onRefresh();
    } catch {
      // The page owns its own access-error banner; a failed refresh must not be
      // reported as a failed toggle.
    }
  };

  const change = async (
    subject: EmailAccessSubject,
    target: string,
    update: () => Promise<unknown>,
  ): Promise<void> => {
    if (subject.keyId === null || pending !== null) return;
    setPending({ subjectId: subject.id, target });
    setRowError(subject.id, null);
    try {
      await update();
      await refreshSafely();
    } catch (cause) {
      setRowError(subject.id, formatApiError(cause));
    } finally {
      setPending(null);
    }
  };

  const toggleMaster = (subject: EmailAccessSubject): void => {
    if (subject.keyId === null || masterDisabled(subject)) return;
    void change(subject, 'master', () =>
      api.updateEmailKeyAccess(subject.keyId as string, { enabled: !subject.emailEnabled }),
    );
  };

  const toggleAccount = (subject: EmailAccessSubject, account: EmailAccessAccount): void => {
    if (subject.keyId === null) return;
    const next = !accountAllowed(subject, account.id);
    void change(subject, `account:${account.id}`, () =>
      api.updateEmailKeyAccess(subject.keyId as string, { accounts: { [account.id]: next } }),
    );
  };

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    await refreshSafely();
    setRefreshing(false);
  };

  const subtitle =
    overview === null
      ? loading
        ? 'Loading access overview…'
        : error !== null
          ? 'Access overview unavailable'
          : 'No access data'
      : server === null
        ? 'Email MCP server is not installed'
        : `${server.name} · ${server.status} · ${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`;

  const renderList = (
    subjects: readonly EmailAccessSubject[],
    filtered: readonly EmailAccessSubject[],
    kind: EmailAccessSegment,
  ) => {
    if (subjects.length === 0) {
      return (
        <EmptyState
          title={kind === 'bots' ? 'No bots found' : 'No API keys found'}
          description={
            kind === 'bots'
              ? 'No OpenMausBot agents are attached to this gateway yet.'
              : 'Create an agent key in Keys to give automation access to email.'
          }
        />
      );
    }
    if (filtered.length === 0) {
      return (
        <EmptyState
          title="No matches"
          description={`No ${kind === 'bots' ? 'bots' : 'API keys'} match “${search.trim()}”.`}
        />
      );
    }
    return (
      <div className="space-y-2">
        {filtered.map((subject) => (
          <SubjectCard
            key={subject.id}
            subject={subject}
            accounts={accounts}
            pending={pending}
            error={rowErrors[subject.id] ?? null}
            focusedAccountId={focusedAccount}
            onToggleMaster={toggleMaster}
            onToggleAccount={toggleAccount}
          />
        ))}
      </div>
    );
  };

  return (
    <Drawer
      open={open}
      size="xl"
      title="Email access"
      subtitle={subtitle}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-[11px] text-slate-500">
            {overview === null ? 'Admin only' : `Generated ${formatTimestamp(overview.generatedAt)} · Admin only`}
          </span>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing || loading}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-sky-400"
          >
            Close
          </button>
        </>
      }
    >
      {loading && overview === null ? (
        <LoadingState label="Loading email access…" />
      ) : error !== null && overview === null ? (
        <ErrorState message={error} onRetry={() => void refresh()} />
      ) : overview === null ? (
        <EmptyState
          title="No access data"
          description="The access overview could not be loaded yet. Refresh to try again."
        />
      ) : (
        <div className="space-y-3">
          {server !== null && server.highPrivilegeTools.length > 0 && (
            <p className="text-[11px] text-slate-500">
              Granted callers can use {server.highPrivilegeTools.length} high-privilege tool
              {server.highPrivilegeTools.length === 1 ? '' : 's'}: {server.highPrivilegeTools.join(', ')}
            </p>
          )}
          {server === null && (
            <Notice tone="warning" title="Email server not installed">
              Install and start the email MCP server before granting access.
            </Notice>
          )}
          {error !== null && (
            <Notice tone="error" title="Could not refresh access">
              {error}
            </Notice>
          )}
          {focusedAccountName !== null && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2">
              <p className="text-xs text-sky-200">
                Focused on <span className="font-semibold">{focusedAccountName}</span>
              </p>
              <button
                type="button"
                onClick={() => setFocusedAccount(null)}
                className="rounded-md border border-sky-500/40 px-2 py-1 text-[11px] font-semibold text-sky-200 transition-colors hover:bg-sky-500/10"
              >
                Show all mailboxes
              </button>
            </div>
          )}

          <Tabs
            label="Email access subjects"
            items={[
              { key: 'bots', label: 'Bots', badge: bots.length },
              { key: 'keys', label: 'API keys', badge: keys.length },
            ]}
            active={segment}
            onChange={(key) => setSegment(key as EmailAccessSegment)}
          />

          <div>
            <label htmlFor="email-access-search" className="sr-only">
              Search bots and API keys
            </label>
            <input
              id="email-access-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, slug or key prefix"
              aria-label="Search bots and API keys"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:border-sky-500/60 focus:outline-none"
            />
          </div>

          <TabPanel id="bots" active={segment === 'bots'}>
            {renderList(bots, filteredBots, 'bots')}
          </TabPanel>
          <TabPanel id="keys" active={segment === 'keys'}>
            {renderList(keys, filteredKeys, 'keys')}
          </TabPanel>
        </div>
      )}
    </Drawer>
  );
}
