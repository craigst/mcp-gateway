import { useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
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
import {
  callServerAction,
  describeTestResult,
  statusAllows,
  type ServerAction,
  type ServersState,
} from './shared.js';
import type { InstallTestResult, ServerRecord } from '../../../core/types.js';

export interface InstalledTabProps {
  servers: ServersState;
  openServerId: string | null;
  onOpenServer: (id: string | null) => void;
  onDiscover: () => void;
  onImport: () => void;
}

/** Installed tab: lifecycle controls, activation probes, policy drawer, logs. */
export function InstalledTab({ servers, openServerId, onOpenServer, onDiscover, onImport }: InstalledTabProps) {
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, InstallTestResult>>({});
  const [deleteTarget, setDeleteTarget] = useState<ServerRecord | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const serverList = servers.status === 'ready' ? servers.data : [];
  const runningCount = serverList.filter((server) => server.status === 'running').length;
  const selected = serverList.find((server) => server.id === openServerId) ?? null;

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

      <Card
        title="Installed sub-servers"
        subtitle={`${serverList.length} registered · ${runningCount} running`}
        actions={
          <>
            <SecondaryButton onClick={onDiscover} className="px-2 py-1 text-xs">
              Discover catalog
            </SecondaryButton>
            <SecondaryButton onClick={onImport} className="px-2 py-1 text-xs">
              Import local servers
            </SecondaryButton>
            <GhostButton onClick={servers.reload}>Refresh</GhostButton>
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
                      <p className="font-medium text-slate-200">{server.name}</p>
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

      {selected !== null && (
        <ServerDrawer
          key={selected.id}
          server={selected}
          onClose={() => onOpenServer(null)}
          onSaved={() => servers.reload()}
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
