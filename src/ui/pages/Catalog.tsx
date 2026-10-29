import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAsyncData } from '../lib/hooks.js';
import { Badge } from '../components/Badge.js';
import { Tabs, TabPanel } from '../components/Tabs.js';
import { CATALOG_TABS } from './catalog/shared.js';
import type { CatalogTab, ServersState, SourcesState } from './catalog/shared.js';
import { InstalledTab } from './catalog/InstalledTab.js';
import { DiscoverTab } from './catalog/DiscoverTab.js';
import { SourcesTab } from './catalog/SourcesTab.js';
import { ImportTab } from './catalog/ImportTab.js';

export type { CatalogTab } from './catalog/shared.js';

export interface CatalogPageProps {
  /** Deep-link target when arriving from another page (e.g. Vault Warden CTAs). */
  initialTab?: CatalogTab;
  onTabChange?: (tab: CatalogTab) => void;
  /** Open the full server inspector (`#/server/<id>`). */
  onOpenServer?: (serverId: string) => void;
}

/**
 * Catalog workspace: installed servers, remote catalog discovery, source
 * management and local harness import — all in one page with tabs.
 */
export function CatalogPage({ initialTab = 'installed', onTabChange, onOpenServer }: CatalogPageProps) {
  const [tab, setTabState] = useState<CatalogTab>(initialTab);
  const [openServerId, setOpenServerId] = useState<string | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);

  // Keep the active tab in sync with deep links (`#/catalog?tab=import`).
  useEffect(() => {
    setTabState(initialTab);
  }, [initialTab]);

  const servers = useAsyncData(() => api.listServers(), []);
  const sources = useAsyncData(() => api.listCatalogSources(), []);
  const reloadServers = servers.reload;

  const setTab = useCallback(
    (next: CatalogTab) => {
      setTabState(next);
      onTabChange?.(next);
    },
    [onTabChange],
  );

  const selectSource = useCallback((sourceId: string | null) => setSelectedSourceId(sourceId), []);

  const viewServer = useCallback(
    (serverId: string) => {
      setOpenServerId(serverId);
      setTab('installed');
      reloadServers();
    },
    [reloadServers, setTab],
  );

  const openSource = useCallback(
    (sourceId: string) => {
      selectSource(sourceId);
      setTab('discover');
    },
    [selectSource, setTab],
  );

  const items = CATALOG_TABS.map((entry) => ({
    ...entry,
    badge:
      entry.key === 'installed'
        ? servers.status === 'ready'
          ? servers.data.length
          : undefined
        : entry.key === 'sources'
          ? sources.status === 'ready'
            ? sources.data.length
            : undefined
          : undefined,
  }));

  const serverCount = servers.status === 'ready' ? servers.data.length : 0;
  const runningCount = servers.status === 'ready'
    ? servers.data.filter((server) => server.status === 'running').length
    : 0;
  const sourceCount = sources.status === 'ready' ? sources.data.length : 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-100">MCP catalog workspace</h2>
          <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-slate-400">
            Connect a private GitHub catalog, install servers and bundles with environment variables and an
            activation test, or import the MCP servers your local agents already run.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="success">
            {runningCount}/{serverCount} running
          </Badge>
          <Badge tone="accent">{sourceCount} catalog source{sourceCount === 1 ? '' : 's'}</Badge>
        </div>
      </div>

      <Tabs
        label="Catalog sections"
        items={items}
        active={tab}
        onChange={setTab}
        className="sticky top-[72px] z-10 bg-slate-950/95 backdrop-blur"
      />

      <TabPanel id="installed" active={tab === 'installed'}>
        <InstalledTab
          servers={servers as ServersState}
          openServerId={openServerId}
          onOpenServer={setOpenServerId}
          onDiscover={() => setTab('discover')}
          onImport={() => setTab('import')}
          onOpenInspector={onOpenServer ?? (() => {})}
        />
      </TabPanel>

      <TabPanel id="discover" active={tab === 'discover'}>
        <DiscoverTab
          sources={sources as SourcesState}
          selectedSourceId={selectedSourceId}
          onSelectSource={selectSource}
          onGoSources={() => setTab('sources')}
          onViewServer={viewServer}
        />
      </TabPanel>

      <TabPanel id="sources" active={tab === 'sources'}>
        <SourcesTab sources={sources as SourcesState} onDiscoverSource={openSource} />
      </TabPanel>

      <TabPanel id="import" active={tab === 'import'}>
        <ImportTab onViewServer={viewServer} onServersChanged={reloadServers} />
      </TabPanel>
    </div>
  );
}
