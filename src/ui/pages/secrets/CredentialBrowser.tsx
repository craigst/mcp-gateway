import { useEffect, useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { useAsyncData } from '../../lib/hooks.js';
import { Card } from '../../components/Card.js';
import { Badge } from '../../components/Badge.js';
import { Table } from '../../components/Table.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorState, Notice } from '../../components/States.js';
import { SkeletonTable } from '../../components/Skeleton.js';
import { CopyButton } from '../../components/CopyButton.js';
import { Field, GhostButton, SecondaryButton, TextInput } from '../../components/Form.js';
import { useToast } from '../../components/Toasts.js';
import type { CredentialItem, CredentialProviderId } from '../../../core/types.js';

interface RevealedItem {
  value: string;
  field: string | null;
}

export interface CredentialBrowserProps {
  activeProvider: CredentialProviderId | null;
  onActiveProviderChange: (provider: CredentialProviderId) => void;
  /** Navigate to Settings → Credentials to configure a provider. */
  onNavigateSettings?: () => void;
}

/** Provider tabs + searchable item browser with audited reveal. */
export function CredentialBrowser({
  activeProvider,
  onActiveProviderChange,
  onNavigateSettings,
}: CredentialBrowserProps) {
  const toast = useToast();
  const providersState = useAsyncData(() => api.getCredentialProviders(), []);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [revealed, setRevealed] = useState<Record<string, RevealedItem>>({});
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const providers = providersState.status === 'ready' ? providersState.data.providers : [];
  const descriptors = providersState.status === 'ready' ? providersState.data.descriptors : [];
  const defaultProvider = providersState.status === 'ready' ? providersState.data.defaultProvider : null;
  const selected = activeProvider ?? defaultProvider;
  const selectedStatus = providers.find((provider) => provider.id === selected) ?? null;
  const selectedDescriptor = descriptors.find((descriptor) => descriptor.id === selected) ?? null;

  useEffect(() => {
    if (activeProvider !== null || defaultProvider === null) return;
    onActiveProviderChange(defaultProvider);
  }, [activeProvider, defaultProvider, onActiveProviderChange]);

  const itemsState = useAsyncData(
    () =>
      selected === null
        ? Promise.resolve([] as CredentialItem[])
        : api.listCredentialItems(selected, {
            ...(debounced === '' ? {} : { search: debounced }),
            limit: 50,
          }),
    [selected, debounced],
  );
  const items = itemsState.status === 'ready' ? itemsState.data : [];
  const notConfigured =
    selectedStatus !== null && !selectedStatus.configured && selectedStatus.state !== 'connected';

  const reveal = async (item: CredentialItem): Promise<void> => {
    if (selected === null) return;
    const field = item.fields.includes('password') ? 'password' : item.fields[0];
    setBusyItem(item.id);
    setActionError(null);
    try {
      const result = await api.revealCredential({
        provider: selected,
        itemId: item.id,
        ...(field === undefined ? {} : { field }),
      });
      setRevealed((previous) => ({ ...previous, [item.id]: { value: result.value, field: result.field } }));
      setExpandedItem(`${selected}:${item.id}`);
      toast('success', `Revealed ${item.name} — this access was audited.`);
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setBusyItem(null);
    }
  };

  const dismiss = (itemId: string): void => {
    setRevealed((previous) => {
      const next = { ...previous };
      delete next[itemId];
      return next;
    });
    setExpandedItem((current) => (current === itemId ? null : current));
  };

  return (
    <Card
      title="Credential items"
      subtitle={
        selectedDescriptor === null
          ? 'Items exposed by the configured credential provider'
          : `${selectedDescriptor.name} — ${selectedDescriptor.description}`
      }
      actions={
        <GhostButton
          onClick={() => {
            providersState.reload();
            itemsState.reload();
          }}
        >
          Refresh
        </GhostButton>
      }
      padded={false}
    >
      <div role="tablist" aria-label="Credential providers" className="flex flex-wrap gap-1 border-b border-slate-800 px-4 py-2">
        {descriptors.map((descriptor) => {
          const status = providers.find((provider) => provider.id === descriptor.id) ?? null;
          return (
            <button
              key={descriptor.id}
              type="button"
              role="tab"
              aria-selected={selected === descriptor.id}
              onClick={() => onActiveProviderChange(descriptor.id)}
              className={
                selected === descriptor.id
                  ? 'inline-flex items-center gap-1.5 rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-sky-300'
                  : 'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-slate-400 transition-colors hover:bg-slate-900 hover:text-slate-200'
              }
            >
              {descriptor.name}
              {status !== null && (
                <span
                  aria-hidden="true"
                  className={
                    status.state === 'connected'
                      ? 'h-1.5 w-1.5 rounded-full bg-emerald-400'
                      : status.state === 'error'
                        ? 'h-1.5 w-1.5 rounded-full bg-rose-400'
                        : 'h-1.5 w-1.5 rounded-full bg-slate-500'
                  }
                />
              )}
            </button>
          );
        })}
      </div>

      {providersState.status === 'loading' && <SkeletonTable rows={4} columns={4} label="Loading providers…" />}
      {providersState.status === 'error' && (
        <div className="p-4">
          <ErrorState message={providersState.error} onRetry={providersState.reload} />
        </div>
      )}

      {providersState.status === 'ready' && (
        <div className="space-y-3 p-4">
          {actionError !== null && (
            <Notice tone="error" title="Credential action failed" onDismiss={() => setActionError(null)}>
              {actionError}
            </Notice>
          )}

          {selectedStatus !== null && selectedStatus.state === 'error' && (
            <Notice tone="error" title={`${selectedStatus.name} error`}>
              {selectedStatus.message}
            </Notice>
          )}
          {selectedStatus !== null && selectedStatus.state === 'unavailable' && (
            <Notice tone="warning" title={`${selectedStatus.name} unavailable`}>
              {selectedStatus.message}
            </Notice>
          )}

          {notConfigured ? (
            <EmptyState
              icon="☍"
              title={`${selectedStatus?.name ?? 'Provider'} is not configured`}
              description={
                selected === 'onepassword'
                  ? 'Add a 1Password Connect host and service-account token/API key in Settings → Credentials to browse items here.'
                  : selected === 'vaultwarden'
                    ? 'Configure the Vaultwarden host URL and API token in Settings → Credentials to browse aliases and deliver credentials to agents.'
                    : 'Configure this credential provider in Settings → Credentials.'
              }
              action={
                onNavigateSettings !== undefined ? (
                  <SecondaryButton onClick={onNavigateSettings} className="px-3 py-1.5 text-xs">
                    Configure in Settings → Credentials
                  </SecondaryButton>
                ) : undefined
              }
            />
          ) : (
            <>
              <Field label="Search" hint="Provider-side item search (name, username, URL).">
                <TextInput
                  aria-label="Search credential items"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search items…"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>

              {itemsState.status === 'loading' && (
                <SkeletonTable rows={4} columns={4} label="Loading credential items…" />
              )}
              {itemsState.status === 'error' && (
                <ErrorState message={itemsState.error} onRetry={itemsState.reload} />
              )}
              {itemsState.status === 'ready' && (
                <Table<CredentialItem>
                  rows={items}
                  getRowKey={(item) => `${item.provider}:${item.id}`}
                  expandedKey={expandedItem}
                  onRowClick={() => undefined}
                  empty={
                    <EmptyState
                      icon="∅"
                      title={debounced === '' ? 'No items available' : 'No items match'}
                      description={
                        debounced === ''
                          ? 'This provider returned no items. Check the provider configuration or add items in the password manager.'
                          : 'Try a different search term, or clear the search.'
                      }
                    />
                  }
                  columns={[
                    {
                      key: 'item',
                      header: 'Item',
                      render: (item) => (
                        <div className="min-w-0 max-w-md">
                          <p className="text-xs font-medium text-slate-200">{item.name}</p>
                          <p className="font-mono text-[10px] text-slate-500">{item.id}</p>
                          {item.urls.length > 0 && (
                            <p className="truncate text-[10px] text-slate-600">{item.urls[0]}</p>
                          )}
                        </div>
                      ),
                    },
                    {
                      key: 'username',
                      header: 'Username',
                      render: (item) =>
                        item.username === null ? (
                          <span className="text-xs text-slate-500">—</span>
                        ) : (
                          <span className="font-mono text-[11px] text-slate-300">{item.username}</span>
                        ),
                    },
                    {
                      key: 'category',
                      header: 'Category',
                      render: (item) =>
                        item.category === null ? (
                          <span className="text-xs text-slate-500">—</span>
                        ) : (
                          <Badge tone="neutral">{item.category}</Badge>
                        ),
                    },
                    {
                      key: 'fields',
                      header: 'Fields',
                      render: (item) => (
                        <div className="flex max-w-[14rem] flex-wrap gap-1">
                          {item.fields.slice(0, 5).map((field) => (
                            <Badge key={field} tone="neutral">
                              {field}
                            </Badge>
                          ))}
                          {item.fields.length > 5 && <Badge tone="info">+{item.fields.length - 5}</Badge>}
                        </div>
                      ),
                    },
                    {
                      key: 'actions',
                      header: 'Actions',
                      render: (item) =>
                        revealed[item.id] === undefined ? (
                          <GhostButton
                            onClick={() => void reveal(item)}
                            disabled={busyItem !== null}
                          >
                            {busyItem === item.id ? 'Revealing…' : 'Reveal'}
                          </GhostButton>
                        ) : (
                          <GhostButton
                            onClick={() => {
                              setExpandedItem(null);
                              dismiss(item.id);
                            }}
                          >
                            Dismiss
                          </GhostButton>
                        ),
                    },
                  ]}
                  renderExpanded={(item) => {
                    const secret = revealed[item.id];
                    if (secret === undefined) return null;
                    return (
                      <div className="space-y-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                          revealed {secret.field ?? 'value'} — audited
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <TextInput
                            readOnly
                            value={secret.value}
                            aria-label={`Revealed ${item.name} value`}
                            className="min-w-0 flex-1 font-mono"
                          />
                          <CopyButton value={secret.value} label="Copy" copiedLabel="Copied" variant="secondary" />
                          <GhostButton onClick={() => dismiss(item.id)}>Dismiss</GhostButton>
                        </div>
                        <p className="text-[10px] text-slate-500">
                          Value shown once per reveal; every access is recorded in the audit log.
                        </p>
                      </div>
                    );
                  }}
                />
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}
