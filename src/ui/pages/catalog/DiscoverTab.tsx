import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useAsyncData } from '../../lib/hooks.js';
import { Card } from '../../components/Card.js';
import { Badge } from '../../components/Badge.js';
import { Table } from '../../components/Table.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorState } from '../../components/States.js';
import { SkeletonTable } from '../../components/Skeleton.js';
import { Field, GhostButton, PrimaryButton, SecondaryButton, Select } from '../../components/Form.js';
import { InstallDialog } from './InstallDialog.js';
import type { InstallAction } from './InstallDialog.js';
import { sourceKindLabel, sourceTokenLabel, type SourcesState } from './shared.js';
import type { CatalogEntriesResult } from '../../lib/api.js';
import type { CatalogEntry } from '../../../core/types.js';

export interface DiscoverTabProps {
  sources: SourcesState;
  selectedSourceId: string | null;
  onSelectSource: (sourceId: string | null) => void;
  onGoSources: () => void;
  onViewServer: (serverId: string) => void;
}

/** Discover tab: browse catalog entries from a source and install them. */
export function DiscoverTab({
  sources,
  selectedSourceId,
  onSelectSource,
  onGoSources,
  onViewServer,
}: DiscoverTabProps) {
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [installAction, setInstallAction] = useState<InstallAction | null>(null);

  const selectedSource =
    sources.status === 'ready' ? sources.data.find((source) => source.id === selectedSourceId) ?? null : null;

  useEffect(() => {
    if (sources.status !== 'ready') return;
    const ids = sources.data.map((source) => source.id);
    if (selectedSourceId !== null && ids.includes(selectedSourceId)) return;
    onSelectSource(ids[0] ?? null);
  }, [sources.status, sources.data, selectedSourceId, onSelectSource]);

  const entriesState = useAsyncData<CatalogEntriesResult | null>(
    () =>
      selectedSourceId === null
        ? Promise.resolve(null)
        : api.listCatalogEntries(selectedSourceId, refreshNonce > 0),
    [selectedSourceId, refreshNonce],
  );

  const entries = entriesState.status === 'ready' ? entriesState.data?.entries ?? [] : [];
  const refreshEntries = (): void => setRefreshNonce((current) => current + 1);

  const installButton = (entry: CatalogEntry) => {
    const disabled = !entry.supported || entry.installedServerId !== null;
    return (
      <PrimaryButton
        onClick={() => setInstallAction({ type: 'entry', sourceId: entry.sourceId, entry })}
        disabled={disabled}
        className="px-2 py-1 text-[11px]"
        title={
          !entry.supported
            ? entry.unsupportedReason ?? 'This entry is not supported by the gateway importer.'
            : entry.installedServerId
              ? `Already installed as ${entry.installedServerId}`
              : `Install ${entry.name}`
        }
      >
        {entry.installedServerId ? 'Installed' : 'Install'}
      </PrimaryButton>
    );
  };

  return (
    <div className="space-y-4">
      <Card
        title="Discover catalog servers"
        subtitle={
          selectedSource
            ? `${selectedSource.label} · ${selectedSource.kind === 'catalog-json' ? selectedSource.repoUrl : `${selectedSource.repoUrl}${selectedSource.ref ? ` @ ${selectedSource.ref}` : ''}`}`
            : 'Browse MCP servers and bundles published in a connected catalog'
        }
        actions={
          <>
            <GhostButton onClick={refreshEntries} disabled={selectedSourceId === null}>
              Refresh
            </GhostButton>
            <SecondaryButton onClick={() => setInstallAction({ type: 'url' })} className="px-2 py-1 text-xs">
              Import from URL
            </SecondaryButton>
          </>
        }
        padded={false}
      >
        {sources.status === 'loading' && <SkeletonTable rows={3} columns={4} label="Loading catalog sources…" />}

        {sources.status === 'error' && (
          <div className="p-4">
            <ErrorState message={sources.error} onRetry={sources.reload} />
          </div>
        )}

        {sources.status === 'ready' &&
          (sources.data.length === 0 ? (
            <EmptyState
              icon="▤"
              title="No catalog sources connected"
              description="Connect a private GitHub catalog (umbrella repo, single MCP server repo or a catalog JSON URL) to browse and install its servers and bundles. Clone tokens are stored encrypted in the AES-256 vault."
              action={
                <PrimaryButton onClick={onGoSources} className="px-3 py-1.5 text-xs">
                  Connect a catalog source
                </PrimaryButton>
              }
            />
          ) : (
            <div>
              <div className="flex flex-wrap items-end gap-3 border-b border-slate-800 px-4 py-3">
                <Field label="Catalog source" className="w-full sm:w-72">
                  <Select
                    value={selectedSourceId ?? ''}
                    onChange={(event) => onSelectSource(event.target.value === '' ? null : event.target.value)}
                  >
                    {sources.data.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.label} · {sourceKindLabel(source.kind)}
                      </option>
                    ))}
                  </Select>
                </Field>
                {selectedSource && (
                  <div className="flex flex-wrap items-center gap-1.5 pb-2">
                    <Badge tone="info">{sourceKindLabel(selectedSource.kind)}</Badge>
                    <Badge tone={selectedSource.tokenSecretName ? 'accent' : 'neutral'}>
                      {sourceTokenLabel(selectedSource)}
                    </Badge>
                    {entriesState.status === 'ready' && (
                      <Badge tone="neutral">
                        {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
                      </Badge>
                    )}
                  </div>
                )}
              </div>

              {entriesState.status === 'loading' && (
                <SkeletonTable rows={4} columns={5} label="Loading catalog entries…" />
              )}
              {entriesState.status === 'error' && (
                <div className="p-4">
                  <ErrorState message={entriesState.error} onRetry={entriesState.reload} />
                </div>
              )}
              {entriesState.status === 'ready' &&
                (entries.length === 0 ? (
                  <EmptyState
                    icon="∅"
                    title="No entries found in this catalog"
                    description="Neither pinned catalog metadata nor auto-manifest detection produced an installable entry. Refresh to re-fetch the repository."
                    action={
                      <SecondaryButton onClick={refreshEntries} className="px-3 py-1.5 text-xs">
                        Refresh catalog
                      </SecondaryButton>
                    }
                  />
                ) : (
                  <Table<CatalogEntry>
                    rows={entries}
                    getRowKey={(entry) => `${entry.sourceId}:${entry.id}`}
                    columns={[
                      {
                        key: 'entry',
                        header: 'Entry',
                        render: (entry) => (
                          <div className="min-w-0 max-w-md">
                            <p className="font-medium text-slate-200">{entry.name}</p>
                            <p className="mt-0.5 text-[11px] text-slate-500">
                              {entry.description ?? entry.serverName ?? 'No description'}
                            </p>
                            {entry.installCommand !== null && (
                              <p className="mt-1 truncate font-mono text-[10px] text-slate-600" title={entry.installCommand}>
                                {entry.installCommand}
                              </p>
                            )}
                          </div>
                        ),
                      },
                      {
                        key: 'ref',
                        header: 'Ref',
                        render: (entry) => (
                          <div className="space-y-1">
                            <Badge tone="neutral">{entry.ref ?? 'default'}</Badge>
                            {entry.entry !== null && (
                              <p className="font-mono text-[10px] text-slate-500">{entry.entry}</p>
                            )}
                          </div>
                        ),
                      },
                      {
                        key: 'kind',
                        header: 'Kind',
                        render: (entry) => (
                          <Badge tone={entry.kind === 'bundle' ? 'accent' : 'info'}>
                            {entry.kind === 'bundle' ? 'bundle' : 'mcp'}
                          </Badge>
                        ),
                      },
                      {
                        key: 'supported',
                        header: 'Compatibility',
                        render: (entry) =>
                          entry.supported ? (
                            <Badge tone="success">supported</Badge>
                          ) : (
                            <div className="max-w-[14rem] space-y-1">
                              <Badge tone="warning">unsupported</Badge>
                              <p className="text-[10px] text-amber-300/80">
                                {entry.unsupportedReason ?? 'No installable manifest could be detected.'}
                              </p>
                            </div>
                          ),
                      },
                      {
                        key: 'installed',
                        header: 'Installed',
                        render: (entry) =>
                          entry.installedServerId ? (
                            <div className="space-y-1">
                              <Badge tone="success">installed</Badge>
                              <p className="font-mono text-[10px] text-slate-500">{entry.installedServerId}</p>
                            </div>
                          ) : (
                            <span className="text-xs text-slate-500">—</span>
                          ),
                      },
                      {
                        key: 'actions',
                        header: 'Actions',
                        render: (entry) => installButton(entry),
                      },
                    ]}
                  />
                ))}
            </div>
          ))}
      </Card>

      {installAction !== null && (
        <InstallDialog
          action={installAction}
          onClose={() => setInstallAction(null)}
          onInstalled={() => entriesState.reload()}
          onViewServer={onViewServer}
        />
      )}
    </div>
  );
}
