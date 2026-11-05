import { useEffect, useMemo, useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { useAsyncData } from '../../lib/hooks.js';
import { formatTimestamp } from '../../lib/format.js';
import { cx } from '../../lib/cx.js';
import { Card } from '../../components/Card.js';
import { Badge } from '../../components/Badge.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorState, Notice } from '../../components/States.js';
import { SkeletonCards } from '../../components/Skeleton.js';
import { CheckboxField, GhostButton, PrimaryButton, SecondaryButton, TextInput } from '../../components/Form.js';
import { useToast } from '../../components/Toasts.js';
import type {
  WatcherAutoLike,
  WatcherContact,
  WatcherMode,
  WatcherOverview,
  WatcherSource,
} from '../../../core/types.js';

interface FormState {
  enabled: boolean;
  mode: WatcherMode;
  selected: string[];
  autoLike: WatcherAutoLike;
}

interface Copy {
  title: string;
  subtitle: string;
  allTitle: string;
  allDescription: string;
  searchPlaceholder: string;
  manualPlaceholder: string;
  contactKinds: string;
}

const COPY: Record<WatcherSource, Copy> = {
  whatsapp: {
    title: 'WhatsApp → Remy',
    subtitle:
      'Choose which incoming WhatsApp messages are pushed to Remy. Replies stay as drafts for your confirmation.',
    allTitle: 'All incoming messages',
    allDescription: 'Every direct message and group alert is pushed to Remy.',
    searchPlaceholder: 'Search name, phone or group…',
    manualPlaceholder: 'Add by phone, lid:<id> or group:<jid>',
    contactKinds: 'phone numbers, LIDs and groups',
  },
  instagram: {
    title: 'Instagram → Remy',
    subtitle:
      'Choose which incoming Instagram DMs are pushed to Remy. Replies stay as drafts for your confirmation.',
    allTitle: 'All incoming DMs',
    allDescription: 'Every Instagram DM and group thread is pushed to Remy.',
    searchPlaceholder: 'Search name or @username…',
    manualPlaceholder: 'Add by ig:<username>',
    contactKinds: 'usernames and DM threads',
  },
};

function formFromOverview(overview: WatcherOverview): FormState {
  return {
    enabled: overview.settings.enabled,
    mode: overview.settings.mode,
    selected: [...overview.settings.selected],
    autoLike: {
      ...overview.settings.autoLike,
      cleoAccounts: [...overview.settings.autoLike.cleoAccounts],
    },
  };
}

function contactLabel(contact: WatcherContact | undefined, key: string): string {
  if (!contact) return key;
  return contact.phone ? `${contact.name} · ${contact.phone}` : contact.name;
}

/**
 * Manage what a social watcher pushes to Remy. The watcher polls these settings
 * with its own scoped key; the console writes them through the admin API.
 * Auto-reply is intentionally absent: Remy drafts replies and waits for Craig.
 */
export function WatcherCard({ source }: { source: WatcherSource }) {
  const copy = COPY[source];
  const toast = useToast();
  const watcher = useAsyncData(() => api.getWatcher(source), [source]);
  const [form, setForm] = useState<FormState>({
    enabled: true,
    mode: 'all',
    selected: [],
    autoLike: {
      cleoPosts: true,
      cleoStories: true,
      mentions: true,
      cleoPostComments: false,
      selectedAccounts: false,
      cleoAccounts: ['livecleo', 'livecleotv'],
    },
  });
  const [search, setSearch] = useState('');
  const [manualKey, setManualKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (watcher.status === 'ready') setForm(formFromOverview(watcher.data));
  }, [watcher.status, watcher.data]);

  const contacts = watcher.status === 'ready' ? watcher.data.contacts : [];
  const contactByKey = useMemo(
    () => new Map(contacts.map((contact) => [contact.key, contact])),
    [contacts],
  );
  const selectedSet = useMemo(() => new Set(form.selected), [form.selected]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rows =
      needle === ''
        ? contacts
        : contacts.filter(
            (contact) =>
              contact.name.toLowerCase().includes(needle) ||
              (contact.phone ?? '').includes(needle) ||
              contact.key.toLowerCase().includes(needle),
          );
    return rows.slice(0, 80);
  }, [contacts, search]);
  const dirty =
    watcher.status === 'ready' &&
    (form.enabled !== watcher.data.settings.enabled ||
      form.mode !== watcher.data.settings.mode ||
      JSON.stringify(form.selected) !== JSON.stringify(watcher.data.settings.selected) ||
      JSON.stringify(form.autoLike) !== JSON.stringify(watcher.data.settings.autoLike));

  const setSelected = (next: string[]): void => {
    setForm((current) => ({ ...current, selected: [...new Set(next)] }));
  };

  const toggleContact = (key: string): void => {
    setSelected(
      selectedSet.has(key) ? form.selected.filter((value) => value !== key) : [...form.selected, key],
    );
  };

  const addManual = (): void => {
    const key = manualKey.trim();
    if (key === '') return;
    if (!/^[A-Za-z0-9+_.:@-]{1,128}$/u.test(key)) {
      setError('Use a phone number, ig:<username>, lid:<id> or group:<jid> with no spaces.');
      return;
    }
    setError(null);
    setSelected([...form.selected, key]);
    setManualKey('');
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await api.updateWatcher(source, {
        enabled: form.enabled,
        mode: form.mode,
        selected: form.selected,
        autoReply: false,
        autoLike: form.autoLike,
      });
      toast('success', `${copy.title.split(' →')[0]} watcher settings saved. The watcher picks them up within 30 seconds.`);
      watcher.reload();
    } catch (caught) {
      setError(formatApiError(caught));
    } finally {
      setSaving(false);
    }
  };

  const discard = (): void => {
    if (watcher.status === 'ready') setForm(formFromOverview(watcher.data));
    setError(null);
  };

  return (
    <Card
      title={copy.title}
      subtitle={copy.subtitle}
      actions={
        <div className="flex items-center gap-2">
          {watcher.status === 'ready' && (
            <>
              <Badge tone={watcher.data.settings.enabled ? 'success' : 'warning'}>
                {watcher.data.settings.enabled ? 'Watcher on' : 'Watcher paused'}
              </Badge>
              <Badge tone="info">Draft only</Badge>
            </>
          )}
          <GhostButton onClick={watcher.reload}>Refresh</GhostButton>
        </div>
      }
    >
      {watcher.status === 'loading' && <SkeletonCards count={2} />}
      {watcher.status === 'error' && <ErrorState message={watcher.error} onRetry={watcher.reload} />}
      {watcher.status === 'ready' && (
        <div className="space-y-4">
          {error !== null && (
            <Notice tone="error" title="Could not save the watcher settings" onDismiss={() => setError(null)}>
              {error}
            </Notice>
          )}

          <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.25fr)]">
            <div className="space-y-4">
              <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-3.5">
                <CheckboxField
                  label={
                    <span>
                      <span className="font-medium text-slate-200">Push incoming messages to Remy</span>
                      <span className="mt-0.5 block text-[11px] text-slate-500">
                        When off, the watcher keeps its cursor and sends nothing.
                      </span>
                    </span>
                  }
                  checked={form.enabled}
                  onChange={(enabled) => setForm((current) => ({ ...current, enabled }))}
                />
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-3.5">
                <p className="text-xs font-medium text-slate-200">Which messages?</p>
                <div className="mt-2 grid gap-2">
                  <button
                    type="button"
                    onClick={() => setForm((current) => ({ ...current, mode: 'all' }))}
                    className={cx(
                      'rounded-lg border px-3 py-2.5 text-left transition',
                      form.mode === 'all'
                        ? 'border-sky-600 bg-sky-950/40 shadow-inner shadow-sky-950/50'
                        : 'border-slate-800 bg-slate-900/40 hover:border-slate-700',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-100">{copy.allTitle}</span>
                      {form.mode === 'all' && <Badge tone="success">Selected</Badge>}
                    </span>
                    <span className="mt-1 block text-[11px] leading-relaxed text-slate-400">
                      {copy.allDescription}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm((current) => ({ ...current, mode: 'selected' }))}
                    className={cx(
                      'rounded-lg border px-3 py-2.5 text-left transition',
                      form.mode === 'selected'
                        ? 'border-sky-600 bg-sky-950/40 shadow-inner shadow-sky-950/50'
                        : 'border-slate-800 bg-slate-900/40 hover:border-slate-700',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-100">Selected contacts only</span>
                      {form.mode === 'selected' && <Badge tone="success">Selected</Badge>}
                    </span>
                    <span className="mt-1 block text-[11px] leading-relaxed text-slate-400">
                      Only the {copy.contactKinds} you choose below can trigger Remy.
                    </span>
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium text-slate-200">Auto-reply</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                      Off by design. Remy writes a draft and waits for your confirmation — nothing is sent
                      automatically.
                    </p>
                  </div>
                  <Badge tone="success">OFF</Badge>
                </div>
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 opacity-70">
                  <span className="relative h-5 w-9 rounded-full bg-slate-700">
                    <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-slate-400" />
                  </span>
                  <span className="text-[11px] text-slate-400">Auto-send is disabled in draft mode</span>
                </div>
              </div>
            </div>

            <div
              className={cx(
                'rounded-xl border border-slate-800 bg-slate-950/30 p-3.5 transition',
                form.mode !== 'selected' && 'opacity-60',
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-medium text-slate-200">Selected contacts</p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {form.mode === 'selected'
                      ? `${form.selected.length} selected · contacts sync from the watcher`
                      : 'Switch to “Selected contacts only” to choose.'}
                  </p>
                </div>
                {form.mode === 'selected' && form.selected.length > 0 && (
                  <GhostButton onClick={() => setSelected([])}>Clear all</GhostButton>
                )}
              </div>

              {form.mode === 'selected' && (
                <>
                  <div className="mt-3 flex gap-2">
                    <TextInput
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={copy.searchPlaceholder}
                      disabled={form.mode !== 'selected'}
                    />
                    <SecondaryButton onClick={watcher.reload} className="shrink-0 px-2 py-1 text-[11px]">
                      Refresh
                    </SecondaryButton>
                  </div>

                  {form.selected.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {form.selected.map((key) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => toggleContact(key)}
                          className="inline-flex items-center gap-1 rounded-full border border-sky-800 bg-sky-950/60 px-2 py-0.5 text-[11px] text-sky-200 hover:bg-sky-900/60"
                          title="Remove"
                        >
                          {contactLabel(contactByKey.get(key), key)}
                          <span aria-hidden>×</span>
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 max-h-72 space-y-1 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/40 p-1.5">
                    {filtered.length === 0 ? (
                      <div className="px-2 py-6 text-center text-[11px] text-slate-500">
                        {contacts.length === 0
                          ? 'No contacts synced yet. The watcher publishes them every few minutes.'
                          : 'No contacts match that search.'}
                      </div>
                    ) : (
                      filtered.map((contact) => (
                        <label
                          key={contact.key}
                          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800/60"
                        >
                          <input
                            type="checkbox"
                            checked={selectedSet.has(contact.key)}
                            onChange={() => toggleContact(contact.key)}
                            className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900 accent-sky-500"
                          />
                          <span className="min-w-0 flex-1 truncate">
                            <span className="font-medium text-slate-200">{contact.name}</span>
                            {contact.phone !== null && (
                              <span className="ml-1.5 font-mono text-[10px] text-slate-500">{contact.phone}</span>
                            )}
                          </span>
                          {contact.kind === 'group' && <Badge tone="neutral">group</Badge>}
                        </label>
                      ))
                    )}
                  </div>

                  <div className="mt-2 flex gap-2">
                    <TextInput
                      value={manualKey}
                      onChange={(event) => setManualKey(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          addManual();
                        }
                      }}
                      placeholder={copy.manualPlaceholder}
                    />
                    <SecondaryButton onClick={addManual} disabled={manualKey.trim() === ''} className="shrink-0">
                      Add
                    </SecondaryButton>
                  </div>
                  <p className="mt-1 text-[10px] text-slate-500">
                    The catalog updates from the watcher; use Add for a key that is not listed yet.
                  </p>
                </>
              )}

              {form.mode !== 'selected' && (
                <div className="mt-6">
                  <EmptyState
                    icon="◎"
                    title="All messages are currently in scope"
                    description="Switch to “Selected contacts only” to allowlist specific people or threads."
                  />
                </div>
              )}
            </div>
          </div>

          {source === 'instagram' && (
            <div className="rounded-xl border border-emerald-900/50 bg-emerald-950/10 p-3.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold text-slate-100">Auto-like (Instagram)</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">
                    Likes happen automatically only when you enable them. Remy never posts comments, replies or
                    mentions on its own — those stay as drafts for your confirmation.
                  </p>
                </div>
                <Badge tone="success">LIKES ONLY</Badge>
              </div>

              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {([
                  {
                    key: 'cleoPosts',
                    label: 'New posts from Cleo',
                    hint: 'Likes a new post from any Cleo account below.',
                  },
                  {
                    key: 'cleoStories',
                    label: 'New stories from Cleo',
                    hint: 'Likes each active story from the Cleo accounts below.',
                  },
                  {
                    key: 'mentions',
                    label: 'Comments that mention me',
                    hint: 'Likes a new comment that mentions your account.',
                  },
                  {
                    key: 'cleoPostComments',
                    label: "New comments on Cleo's posts",
                    hint: "Off by default. Likes comments from other people; never Cleo's own comments or yours.",
                  },
                  {
                    key: 'selectedAccounts',
                    label: 'New posts from selected accounts',
                    hint: 'Uses your Instagram selected-contact allowlist. Off by default.',
                  },
                ] as const).map((item) => (
                  <label
                    key={item.key}
                    className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-800 bg-slate-950/30 px-3 py-2.5 transition hover:border-slate-700"
                  >
                    <input
                      type="checkbox"
                      checked={form.autoLike[item.key]}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          autoLike: { ...current.autoLike, [item.key]: event.target.checked },
                        }))
                      }
                      className="mt-0.5 h-3.5 w-3.5 rounded border-slate-600 bg-slate-900 accent-emerald-500"
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-slate-200">{item.label}</span>
                      <span className="mt-0.5 block text-[10px] leading-relaxed text-slate-500">{item.hint}</span>
                    </span>
                  </label>
                ))}
              </div>

              {(form.autoLike.cleoPosts || form.autoLike.cleoStories || form.autoLike.cleoPostComments) && (
                <div className="mt-3">
                  <p className="mb-1 text-[11px] font-medium text-slate-300">Cleo accounts</p>
                  <TextInput
                    value={form.autoLike.cleoAccounts.join(', ')}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        autoLike: {
                          ...current.autoLike,
                          cleoAccounts: event.target.value
                            .split(',')
                            .map((handle) => handle.trim().replace(/^@/u, ''))
                            .filter((handle) => handle !== ''),
                        },
                      }))
                    }
                    placeholder="livecleo, livecleotv"
                  />
                  <p className="mt-1 text-[10px] text-slate-500">
                    Comma-separated. Instagram polling checks these accounts for new posts and comments.
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-3">
            <div className="text-[11px] text-slate-500">
              {watcher.data.settings.updatedAt !== null ? (
                <>
                  Last saved {formatTimestamp(watcher.data.settings.updatedAt)}
                  {watcher.data.settings.updatedBy ? ` by ${watcher.data.settings.updatedBy}` : ''} ·{' '}
                </>
              ) : null}
              {watcher.data.contactsUpdatedAt !== null
                ? `${contacts.length} contacts synced ${formatTimestamp(watcher.data.contactsUpdatedAt)}`
                : 'No contact catalog synced yet'}
            </div>
            <div className="flex items-center gap-2">
              <SecondaryButton onClick={discard} disabled={!dirty || saving}>
                Discard
              </SecondaryButton>
              <PrimaryButton onClick={() => void save()} disabled={!dirty || saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </PrimaryButton>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
