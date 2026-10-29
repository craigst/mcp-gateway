import { useEffect, useState } from 'react';
import { api, formatApiError } from '../lib/api.js';
import { useAsyncData } from '../lib/hooks.js';
import { Badge, badgeToneForStatus } from '../components/Badge.js';
import { ErrorState, Notice } from '../components/States.js';
import { SkeletonBlock } from '../components/Skeleton.js';
import { Tabs } from '../components/Tabs.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { DangerButton, GhostButton, PrimaryButton, SecondaryButton } from '../components/Form.js';
import { useToast } from '../components/Toasts.js';
import { UpdateDialog } from './catalog/UpdateDialog.js';
import { statusAllows } from './catalog/shared.js';
import { OverviewTab } from './server/OverviewTab.js';
import { ToolsTab } from './server/ToolsTab.js';
import { PromptsResourcesTab } from './server/PromptsResourcesTab.js';
import { ConfigurationTab } from './server/ConfigurationTab.js';
import { ActivityTab } from './server/ActivityTab.js';
import type { InspectorTab } from './server/shared.js';
import type { UpdateCheckResult } from '../../core/types.js';

export interface ServerInspectorPageProps {
  serverId: string;
  /** Return to the catalog (the inspector lives at `#/server/<id>`). */
  onBack: () => void;
}

/** Full-page per-server inspector: overview, tools, prompts/resources, config and activity. */
export function ServerInspectorPage({ serverId, onBack }: ServerInspectorPageProps) {
  const toast = useToast();
  const inspector = useAsyncData(() => api.getServerInspector(serverId), [serverId]);

  const [tab, setTab] = useState<InspectorTab>('overview');
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<UpdateCheckResult | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    setCheckResult(null);
    setActionError(null);
  }, [serverId]);

  const data = inspector.status === 'ready' ? inspector.data : null;
  const server = data?.server ?? null;
  const updateAvailable =
    checkResult !== null ? checkResult.updateAvailable : data?.source?.updateAvailable === true;

  const runAction = async (action: 'start' | 'stop' | 'restart'): Promise<void> => {
    if (server === null) return;
    setPending(action);
    setActionError(null);
    try {
      if (action === 'start') await api.startServer(server.id);
      else if (action === 'stop') await api.stopServer(server.id);
      else await api.restartServer(server.id);
      toast(
        'success',
        `“${server.name}” ${action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted'}.`,
      );
      inspector.reload();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setPending(null);
    }
  };

  const runTest = async (): Promise<void> => {
    if (server === null) return;
    setTesting(true);
    setActionError(null);
    try {
      const result = await api.testServer(server.id);
      if (result.ok) toast('success', `Probe ok — ${result.toolCount} tool${result.toolCount === 1 ? '' : 's'}.`);
      else toast('error', `Probe failed: ${result.error ?? 'unknown error'}`);
      inspector.reload();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setTesting(false);
    }
  };

  const checkNow = async (): Promise<void> => {
    if (server === null) return;
    setChecking(true);
    setActionError(null);
    try {
      const result = await api.checkServerUpdate(server.id);
      setCheckResult(result);
      if (result.error !== null) toast('error', `Update check failed: ${result.error}`);
      else if (result.updateAvailable) toast('info', `Update available: v${result.toVersion ?? '?'}`);
      else toast('success', 'This server is up to date.');
      inspector.reload();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setChecking(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (server === null) return;
    setDeleteBusy(true);
    setActionError(null);
    try {
      await api.deleteServer(server.id);
      toast('success', `Deleted “${server.name}”.`);
      setDeleteOpen(false);
      onBack();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setDeleteBusy(false);
    }
  };

  if (inspector.status === 'loading') {
    return (
      <div className="space-y-4" role="status" aria-label="Loading server inspector">
        <SkeletonBlock className="h-8 w-1/3" />
        <SkeletonBlock className="h-4 w-1/2" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <SkeletonBlock key={index} className="h-20 w-full" />
          ))}
        </div>
        <SkeletonBlock className="h-64 w-full" />
      </div>
    );
  }

  if (inspector.status === 'error' || data === null || server === null) {
    return (
      <div className="space-y-4">
        <GhostButton onClick={onBack}>← Back to catalog</GhostButton>
        <ErrorState
          message={inspector.status === 'error' ? inspector.error : 'Server not found.'}
          onRetry={inspector.reload}
        />
      </div>
    );
  }

  const tabItems = [
    { key: 'overview' as const, label: 'Overview' },
    { key: 'tools' as const, label: 'Tools', badge: data.tools.length },
    {
      key: 'prompts' as const,
      label: 'Prompts & Resources',
      badge: data.prompts.length + data.resources.length,
    },
    {
      key: 'configuration' as const,
      label: 'Configuration',
      badge: data.config.env.length + data.config.headers.length,
    },
    { key: 'activity' as const, label: 'Activity', badge: data.stats.total },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-slate-400 transition-colors hover:bg-slate-900 hover:text-slate-200"
        >
          ← Back to catalog
        </button>
        <SecondaryButton onClick={inspector.reload} className="px-2 py-1 text-xs">
          Refresh
        </SecondaryButton>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-slate-100">{server.name}</h2>
            <Badge tone={badgeToneForStatus(server.status)}>{server.status}</Badge>
            <Badge tone="neutral">
              {server.runtime} · {server.transport}
            </Badge>
            {updateAvailable && <Badge tone="warning">update available</Badge>}
          </div>
          <p className="mt-1 font-mono text-[11px] text-slate-500">{server.id}</p>
          {server.lastError !== null && <p className="mt-1 text-[11px] text-rose-400">{server.lastError}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <GhostButton
            onClick={() => void runAction('start')}
            disabled={pending !== null || !statusAllows(server.status, 'start')}
          >
            Start
          </GhostButton>
          <GhostButton
            onClick={() => void runAction('stop')}
            disabled={pending !== null || !statusAllows(server.status, 'stop')}
          >
            Stop
          </GhostButton>
          <GhostButton
            onClick={() => void runAction('restart')}
            disabled={pending !== null || !statusAllows(server.status, 'restart')}
          >
            Restart
          </GhostButton>
          <GhostButton onClick={() => void runTest()} disabled={testing || pending !== null}>
            {testing ? 'Testing…' : 'Test'}
          </GhostButton>
          <PrimaryButton
            onClick={() => setUpdateOpen(true)}
            disabled={!updateAvailable}
            className="px-3 py-1.5 text-xs"
          >
            Update
          </PrimaryButton>
          <DangerButton onClick={() => setDeleteOpen(true)} className="px-2 py-1 text-[11px]">
            Delete
          </DangerButton>
        </div>
      </div>

      {actionError !== null && (
        <Notice tone="error" title="Action failed" onDismiss={() => setActionError(null)}>
          {actionError}
        </Notice>
      )}

      <Tabs label="Server inspector sections" items={tabItems} active={tab} onChange={setTab} />

      {tab === 'overview' && (
        <OverviewTab
          data={data}
          checking={checking}
          checkResult={checkResult}
          onCheck={() => void checkNow()}
          onUpdate={() => setUpdateOpen(true)}
        />
      )}
      {tab === 'tools' && (
        <ToolsTab
          serverId={server.id}
          tools={data.tools}
          approvalRequiredTools={server.approvalRequiredTools ?? []}
          stats={data.stats}
          onUsed={inspector.reload}
        />
      )}
      {tab === 'prompts' && (
        <PromptsResourcesTab serverId={server.id} prompts={data.prompts} resources={data.resources} />
      )}
      {tab === 'configuration' && (
        <ConfigurationTab
          serverId={server.id}
          server={server}
          config={data.config}
          onChanged={inspector.reload}
        />
      )}
      {tab === 'activity' && (
        <ActivityTab
          serverId={server.id}
          initialSummary={data.stats}
          keysUsed={data.keysUsed}
          tools={data.tools}
        />
      )}

      {updateOpen && (
        <UpdateDialog
          server={server}
          source={data.source}
          onClose={() => setUpdateOpen(false)}
          onUpdated={() => {
            setCheckResult(null);
            inspector.reload();
          }}
        />
      )}

      <ConfirmDialog
        open={deleteOpen}
        title="Delete sub-server"
        tone="danger"
        confirmLabel="Delete server"
        busy={deleteBusy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteOpen(false)}
        description={`Remove “${server.name}” (${server.id}) from the catalog? Running processes are stopped first.`}
      />
    </div>
  );
}
