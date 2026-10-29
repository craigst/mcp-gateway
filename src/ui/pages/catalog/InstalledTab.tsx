import { useEffect, useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { useAsyncData } from '../../lib/hooks.js';
import { Card } from '../../components/Card.js';
import { Badge, badgeToneForStatus } from '../../components/Badge.js';
import { Table } from '../../components/Table.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorState, Notice } from '../../components/States.js';
import { SkeletonTable } from '../../components/Skeleton.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { DangerButton, GhostButton, PrimaryButton, SecondaryButton } from '../../components/Form.js';
import { useToast } from '../../components/Toasts.js';
import { RegisterServerCard } from './RegisterServerCard.js';
import { ServerDrawer } from './ServerDrawer.js';
import { UpdateDialog } from './UpdateDialog.js';
import {
  callServerAction,
  describeTestResult,
  statusAllows,
  type ServerAction,
  type ServersState,
} from './shared.js';
import type {
  InstallTestResult,
  ServerRecord,
  ServerSourceInfo,
  UpdateCheckResult,
} from '../../../core/types.js';

function formatRelativeTime(timestamp: string): string {
  const then = new Date(timestamp).getTime();
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export interface InstalledTabProps {
  servers: ServersState;
  openServerId: string | null;
  onOpenServer: (id: string | null) => void;
  onDiscover: () => void;
  onImport: () => void;
  /** Navigate to the full `#/server/<id>` inspector page. */
  onOpenInspector: (serverId: string) => void;
}

/** Installed tab: lifecycle controls, activation probes, policy drawer, logs. */
export function InstalledTab({
  servers,
  openServerId,
  onOpenServer,
  onDiscover,
  onImport,
  onOpenInspector,
}: InstalledTabProps) {
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, InstallTestResult>>({});
  const [deleteTarget, setDeleteTarget] = useState<ServerRecord | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const updates = useAsyncData(() => api.listServerUpdates(), []);
  const [checkingAll, setCheckingAll] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [checkResults, setCheckResults] = useState<Record<string, UpdateCheckResult>>({});
  const [updateTarget, setUpdateTarget] = useState<ServerRecord | null>(null);
  const [drawerServer, setDrawerServer] = useState<ServerRecord | null>(null);

  const serverList = servers.status === 'ready' ? servers.data : [];
  const runningCount = serverList.filter((server) => server.status === 'running').length;

  // Keep the drawer mounted across list refreshes (which briefly have no data).
  useEffect(() => {
    if (openServerId === null) {
      setDrawerServer(null);
      return;
    }
    const found = (servers.status === 'ready' ? servers.data : []).find((server) => server.id === openServerId);
    if (found !== undefined) setDrawerServer(found);
  }, [openServerId, servers.status, servers.data]);
  const updateMap = new Map<string, ServerSourceInfo>(
    (updates.status === 'ready' ? updates.data : []).map((source) => [source.serverId, source]),
  );
  const updatesAvailable = serverList.filter((server) => {
    const check = checkResults[server.id];
    if (check !== undefined) return check.updateAvailable;
    return updateMap.get(server.id)?.updateAvailable === true;
  }).length;

  const runAction = async (action: ServerAction, server: ServerRecord): Promise<void> => {
    setPending(`${action}:${server.id}`);
    setActionError(null);
    try {
      await callServerAction(action, server.id);
      toast('success', `“${server.name}” ${action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted'}.`);
      servers.reload();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setPending(null);
    }
  };

  const runTest = async (server: ServerRecord): Promise<void> => {
    setTestingId(server.id);
    setActionError(null);
    try {
      const result = await api.testServer(server.id);
      setTestResults((previous) => ({ ...previous, [server.id]: result }));
      if (result.ok) toast('success', `“${server.name}”: ${describeTestResult(result)}.`);
      else toast('error', `“${server.name}” probe failed: ${result.error ?? 'unknown error'}`);
      servers.reload();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setTestingId(null);
    }
  };

  const checkAll = async (): Promise<void> => {
    setCheckingAll(true);
    setActionError(null);
    try {
      const results = await api.checkUpdates();
      setCheckResults((previous) => {
        const next = { ...previous };
        for (const result of results) next[result.serverId] = result;
        return next;
      });
      const available = results.filter((result) => result.updateAvailable).length;
      toast(
        available > 0 ? 'info' : 'success',
        available > 0
          ? `${available} update${available === 1 ? '' : 's'} available.`
          : 'All tracked servers are up to date.',
      );
      updates.reload();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setCheckingAll(false);
    }
  };

  const checkServer = async (server: ServerRecord): Promise<void> => {
    setCheckingId(server.id);
    setActionError(null);
    try {
      const result = await api.checkServerUpdate(server.id);
      setCheckResults((previous) => ({ ...previous, [server.id]: result }));
      if (result.error !== null) {
        toast('error', `“${server.name}” update check failed: ${result.error}`);
      } else if (result.updateAvailable) {
        toast(
          'info',
          `Update available for “${server.name}”: v${result.fromVersion ?? '?'} → v${result.toVersion ?? '?'}`,
        );
      } else {
        toast('success', `“${server.name}” is up to date.`);
      }
      updates.reload();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setCheckingId(null);
    }
  };

  const renderUpdateCell = (server: ServerRecord) => {
    const source = updateMap.get(server.id) ?? null;
    const check = checkResults[server.id] ?? null;
    const latestVersion = check?.toVersion ?? source?.latestVersion ?? null;
    const latest = latestVersion !== null ? `v${latestVersion}` : latestVersion ?? source?.latestRef ?? 'available';
    const updateAvailable = check !== null ? check.updateAvailable : source?.updateAvailable === true;

    if (checkingId === server.id) {
      return <span className="text-[11px] text-slate-400">Checking…</span>;
    }
    if (updates.status === 'loading') {
      return <Badge tone="neutral">checking…</Badge>;
    }
    if (updates.status === 'error' && source === null) {
      return <Badge tone="neutral">unavailable</Badge>;
    }
    if (check?.error !== null && check?.error !== undefined) {
      return (
        <div className="space-y-1">
          <Badge tone="danger">error</Badge>
          <p className="max-w-[12rem] truncate text-[10px] text-rose-300" title={check.error}>
            {check.error}
          </p>
        </div>
      );
    }
    if (source?.checkError !== null && source?.checkError !== undefined) {
      return (
        <div className="space-y-1">
          <Badge tone="danger">error</Badge>
          <p className="max-w-[12rem] truncate text-[10px] text-rose-300" title={source.checkError}>
            {source.checkError}
          </p>
        </div>
      );
    }
    if (source === null) {
      return <Badge tone="neutral">local</Badge>;
    }
    return (
      <div className="space-y-1">
        <Badge tone={updateAvailable ? 'warning' : 'success'}>
          {updateAvailable ? `update → ${latest ?? 'available'}` : 'up to date'}
        </Badge>
        {source.checkedAt !== null && (
          <p className="text-[10px] text-slate-500">checked {formatRelativeTime(source.checkedAt)}</p>
        )}
      </div>
    );
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setActionError(null);
    try {
      await api.deleteServer(deleteTarget.id);
      toast('success', `Deleted “${deleteTarget.name}”.`);
      if (openServerId === deleteTarget.id) onOpenServer(null);
      setDeleteTarget(null);
      servers.reload();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {actionError !== null && (
        <Notice tone="error" title="Action failed" onDismiss={() => setActionError(null)}>
          {actionError}
        </Notice>
      )}

      {updates.status === 'error' && (
        <Notice tone="warning" title="Update tracking unavailable">
          {updates.error}{' '}
          <button
            type="button"
            onClick={updates.reload}
            className="font-semibold underline underline-offset-2"
          >
            Retry
          </button>
        </Notice>
      )}

      <Card
        title="Installed sub-servers"
        subtitle={`${serverList.length} registered · ${runningCount} running · ${updatesAvailable} update${updatesAvailable === 1 ? '' : 's'} available`}
        actions={
          <>
            <SecondaryButton onClick={() => void checkAll()} disabled={checkingAll} className="px-2 py-1 text-xs">
              {checkingAll ? 'Checking all…' : 'Check all'}
            </SecondaryButton>
            <SecondaryButton onClick={onDiscover} className="px-2 py-1 text-xs">
              Discover catalog
            </SecondaryButton>
            <SecondaryButton onClick={onImport} className="px-2 py-1 text-xs">
              Import local servers
            </SecondaryButton>
            <GhostButton
              onClick={() => {
                servers.reload();
                updates.reload();
              }}
            >
              Refresh
            </GhostButton>
          </>
        }
        padded={false}
      >
        {servers.status === 'loading' && <SkeletonTable rows={4} columns={5} label="Loading sub-servers…" />}
        {servers.status === 'error' && (
          <div className="p-4">
            <ErrorState message={servers.error} onRetry={servers.reload} />
          </div>
        )}
        {servers.status === 'ready' &&
          (serverList.length === 0 ? (
            <EmptyState
              icon="▤"
              title="No servers installed yet"
              description="Install an MCP server from a connected private catalog, import one your local agents already use, or register a command manually below."
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <PrimaryButton onClick={onDiscover} className="px-3 py-1.5 text-xs">
                    Discover catalog
                  </PrimaryButton>
                  <SecondaryButton onClick={onImport} className="px-3 py-1.5 text-xs">
                    Import from harness
                  </SecondaryButton>
                </div>
              }
            />
          ) : (
            <Table<ServerRecord>
              rows={serverList}
              getRowKey={(server) => server.id}
              columns={[
                {
                  key: 'name',
                  header: 'Server',
                  render: (server) => (
                    <div className="min-w-0">
                      <button
                        type="button"
                        onClick={() => onOpenInspector(server.id)}
                        className="text-left font-medium text-slate-200 underline-offset-2 transition-colors hover:text-sky-300 hover:underline"
                        title={`Open the ${server.name} inspector`}
                      >
                        {server.name}
                      </button>
                      <p className="font-mono text-[11px] text-slate-500">{server.id}</p>
                      {server.envFile ? (
                        <p className="mt-0.5 truncate font-mono text-[10px] text-slate-500" title={server.envFile}>
                          env file: {server.envFile}
                        </p>
                      ) : null}
                    </div>
                  ),
                },
                {
                  key: 'runtime',
                  header: 'Runtime',
                  render: (server) => (
                    <span className="text-xs text-slate-400">
                      {server.runtime} · {server.transport}
                    </span>
                  ),
                },
                {
                  key: 'version',
                  header: 'Version',
                  render: (server) => {
                    const source = updateMap.get(server.id) ?? null;
                    const version = source?.installedVersion ?? server.manifest?.version ?? null;
                    return version === null ? (
                      <span className="text-xs text-slate-500">—</span>
                    ) : (
                      <span className="font-mono text-xs text-slate-300">v{version}</span>
                    );
                  },
                },
                {
                  key: 'update',
                  header: 'Update',
                  render: (server) => {
                    const source = updateMap.get(server.id) ?? null;
                    const check = checkResults[server.id] ?? null;
                    const updateAvailable =
                      check !== null ? check.updateAvailable : source?.updateAvailable === true;
                    return (
                      <div className="space-y-1.5">
                        {renderUpdateCell(server)}
                        <div className="flex flex-wrap items-center gap-1">
                          <GhostButton
                            onClick={() => void checkServer(server)}
                            disabled={checkingId !== null || checkingAll}
                          >
                            Check
                          </GhostButton>
                          {updateAvailable && (
                            <PrimaryButton
                              onClick={() => setUpdateTarget(server)}
                              disabled={checkingId !== null || checkingAll}
                              className="px-2 py-1 text-[11px]"
                            >
                              Update
                            </PrimaryButton>
                          )}
                        </div>
                      </div>
                    );
                  },
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (server) => (
                    <div className="space-y-1">
                      <Badge tone={badgeToneForStatus(server.status)}>{server.status}</Badge>
                      {server.lastError !== null && (
                        <p className="max-w-[16rem] truncate text-[11px] text-rose-400" title={server.lastError}>
                          {server.lastError}
                        </p>
                      )}
                    </div>
                  ),
                },
                {
                  key: 'policy',
                  header: 'Policy',
                  render: (server) => {
                    const high = server.highPrivilegeTools.length;
                    const approval = server.approvalRequiredTools?.length ?? 0;
                    if (high === 0 && approval === 0) return <span className="text-xs text-slate-500">—</span>;
                    return (
                      <div className="flex flex-wrap gap-1">
                        {high > 0 && <Badge tone="warning">{high} high-priv</Badge>}
                        {approval > 0 && <Badge tone="danger">{approval} approval</Badge>}
                      </div>
                    );
                  },
                },
                {
                  key: 'probe',
                  header: 'Probe',
                  render: (server) => {
                    if (testingId === server.id) {
                      return <span className="text-[11px] text-slate-400">Testing…</span>;
                    }
                    const result = testResults[server.id];
                    if (!result) return <span className="text-xs text-slate-500">—</span>;
                    return (
                      <div className="space-y-1">
                        <Badge tone={result.ok ? 'success' : 'danger'}>{result.ok ? 'ok' : 'failed'}</Badge>
                        <p className="text-[10px] text-slate-500">{describeTestResult(result)}</p>
                      </div>
                    );
                  },
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  render: (server) => (
                    <div className="flex flex-wrap items-center gap-1">
                      <GhostButton
                        onClick={() => void runAction('start', server)}
                        disabled={pending !== null || !statusAllows(server.status, 'start')}
                      >
                        Start
                      </GhostButton>
                      <GhostButton
                        onClick={() => void runAction('stop', server)}
                        disabled={pending !== null || !statusAllows(server.status, 'stop')}
                      >
                        Stop
                      </GhostButton>
                      <GhostButton
                        onClick={() => void runAction('restart', server)}
                        disabled={pending !== null || !statusAllows(server.status, 'restart')}
                      >
                        Restart
                      </GhostButton>
                      <GhostButton onClick={() => void runTest(server)} disabled={testingId !== null || pending !== null}>
                        Test
                      </GhostButton>
                      <GhostButton onClick={() => onOpenServer(server.id)}>Details</GhostButton>
                      <GhostButton onClick={() => onOpenInspector(server.id)}>Open</GhostButton>
                      <DangerButton
                        onClick={() => setDeleteTarget(server)}
                        disabled={pending !== null}
                        className="px-2 py-1 text-[11px]"
                      >
                        Delete
                      </DangerButton>
                    </div>
                  ),
                },
              ]}
            />
          ))}
      </Card>

      <RegisterServerCard onRegistered={servers.reload} />

      {openServerId !== null && drawerServer !== null && (
        <ServerDrawer
          key={drawerServer.id}
          server={drawerServer}
          onClose={() => onOpenServer(null)}
          onOpenInspector={onOpenInspector}
          onSaved={(updated) => {
            setDrawerServer(updated);
            servers.reload();
            updates.reload();
          }}
          onUpdated={() => {
            servers.reload();
            updates.reload();
          }}
        />
      )}

      {updateTarget !== null && (
        <UpdateDialog
          server={updateTarget}
          source={updateMap.get(updateTarget.id) ?? null}
          onClose={() => setUpdateTarget(null)}
          onUpdated={() => {
            setCheckResults((previous) => {
              const next = { ...previous };
              delete next[updateTarget.id];
              return next;
            });
            servers.reload();
            updates.reload();
          }}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete sub-server"
        description={
          deleteTarget !== null
            ? `Remove “${deleteTarget.name}” (${deleteTarget.id}) from the catalog? Running processes are stopped first.`
            : undefined
        }
        tone="danger"
        confirmLabel="Delete server"
        busy={deleteBusy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
