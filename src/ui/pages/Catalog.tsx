import { useState } from 'react';
import { api, formatApiError } from '../lib/api.js';
import { useAsyncData } from '../lib/hooks.js';
import { formatTimestamp } from '../lib/format.js';
import { Card } from '../components/Card.js';
import { Badge, badgeToneForStatus } from '../components/Badge.js';
import { Table } from '../components/Table.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState, InlineNotice, LoadingState } from '../components/States.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { LiveLogPanel } from '../components/LiveLogPanel.js';
import {
  CheckboxField,
  DangerButton,
  Field,
  GhostButton,
  PrimaryButton,
  SecondaryButton,
  Select,
  TextArea,
  TextInput,
} from '../components/Form.js';
import type { RuntimeKind, ServerRecord, TransportKind } from '../../core/types.js';

type ServerAction = 'start' | 'stop' | 'restart';

interface RegisterFormState {
  name: string;
  runtime: RuntimeKind;
  transport: TransportKind;
  command: string;
  args: string;
  url: string;
  env: string;
  highPrivilegeTools: string;
  delegationSupported: boolean;
}

interface ImportFormState {
  url: string;
  name: string;
  startAfterBuild: boolean;
}

const EMPTY_REGISTER: RegisterFormState = {
  name: '',
  runtime: 'node',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  env: '',
  highPrivilegeTools: '',
  delegationSupported: false,
};

const EMPTY_IMPORT: ImportFormState = { url: '', name: '', startAfterBuild: true };

const RUNTIMES: readonly RuntimeKind[] = ['node', 'python', 'binary', 'remote-agent'];
const TRANSPORTS: readonly TransportKind[] = ['stdio', 'http', 'sse', 'websocket'];

function splitList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseEnv(value: string): Record<string, string> {
  const trimmed = value.trim();
  if (trimmed === '') return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('env must be a JSON object');
  }
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) env[key] = String(entry);
  return env;
}

function statusAllows(status: string, action: ServerAction): boolean {
  switch (action) {
    case 'start':
      return status === 'stopped' || status === 'failed';
    case 'stop':
      return status === 'running' || status === 'degraded' || status === 'starting';
    case 'restart':
      return status === 'running' || status === 'degraded';
    default:
      return false;
  }
}

function callServerAction(action: ServerAction, id: string): Promise<ServerRecord> {
  if (action === 'start') return api.startServer(id);
  if (action === 'stop') return api.stopServer(id);
  return api.restartServer(id);
}

interface ServerLogsProps {
  serverId: string;
}

function ServerLogs({ serverId }: ServerLogsProps) {
  const snapshot = useAsyncData(() => api.serverLogs(serverId, 200), [serverId]);
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Ring buffer snapshot (last 200 lines)
          </h3>
          <SecondaryButton onClick={snapshot.reload} className="px-2 py-1 text-xs">
            Refresh snapshot
          </SecondaryButton>
        </div>
        <div className="terminal-scroll h-44 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/80 p-3 font-mono text-[11.5px] leading-relaxed text-slate-300">
          {snapshot.status === 'loading' && <p className="text-slate-500">Loading snapshot…</p>}
          {snapshot.status === 'error' && <p className="text-rose-300">{snapshot.error}</p>}
          {snapshot.status === 'ready' &&
            (snapshot.data.length === 0 ? (
              <p className="text-slate-600">No buffered log lines yet.</p>
            ) : (
              snapshot.data.map((line, index) => (
                <div key={`${line.ts}-${index}`} className="whitespace-pre-wrap break-words">
                  <span className="mr-2 text-slate-600">{formatTimestamp(line.ts)}</span>
                  <span className="mr-1.5 text-slate-500">[{line.stream}]</span>
                  {line.line}
                </div>
              ))
            ))}
        </div>
      </div>
      <LiveLogPanel serverId={serverId} maxLines={300} />
    </div>
  );
}

/** Catalog manager: register/import sub-servers, lifecycle controls, log viewer. */
export function CatalogPage() {
  const servers = useAsyncData(() => api.listServers(), []);
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ServerRecord | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const [registerForm, setRegisterForm] = useState<RegisterFormState>(EMPTY_REGISTER);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerNotice, setRegisterNotice] = useState<string | null>(null);
  const [registerBusy, setRegisterBusy] = useState(false);

  const [importForm, setImportForm] = useState<ImportFormState>(EMPTY_IMPORT);
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const serverList = servers.status === 'ready' ? servers.data : [];

  const runAction = async (action: ServerAction, server: ServerRecord): Promise<void> => {
    setPending(`${action}:${server.id}`);
    setActionError(null);
    try {
      await callServerAction(action, server.id);
      servers.reload();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setPending(null);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setActionError(null);
    try {
      await api.deleteServer(deleteTarget.id);
      setDeleteTarget(null);
      if (logsFor === deleteTarget.id) setLogsFor(null);
      servers.reload();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setDeleteBusy(false);
    }
  };

  const submitRegister = async (): Promise<void> => {
    setRegisterError(null);
    setRegisterNotice(null);
    const name = registerForm.name.trim();
    if (name.length === 0) {
      setRegisterError('Name is required');
      return;
    }
    if (registerForm.transport === 'stdio' && registerForm.command.trim().length === 0) {
      setRegisterError('Command is required for stdio transport');
      return;
    }
    if (registerForm.transport !== 'stdio' && registerForm.url.trim().length === 0) {
      setRegisterError('URL is required for http/sse/websocket transports');
      return;
    }
    let env: Record<string, string>;
    try {
      env = parseEnv(registerForm.env);
    } catch (error) {
      setRegisterError(`Invalid env JSON: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    setRegisterBusy(true);
    try {
      await api.registerServer({
        name,
        runtime: registerForm.runtime,
        transport: registerForm.transport,
        command: registerForm.command.trim() === '' ? null : registerForm.command.trim(),
        args: splitList(registerForm.args),
        url: registerForm.url.trim() === '' ? null : registerForm.url.trim(),
        env,
        highPrivilegeTools: splitList(registerForm.highPrivilegeTools),
        delegationSupported: registerForm.delegationSupported,
      });
      setRegisterForm(EMPTY_REGISTER);
      setRegisterNotice(`Registered sub-server “${name}”.`);
      servers.reload();
    } catch (error) {
      setRegisterError(formatApiError(error));
    } finally {
      setRegisterBusy(false);
    }
  };

  const submitImport = async (): Promise<void> => {
    setImportError(null);
    setImportNotice(null);
    if (importForm.url.trim().length === 0) {
      setImportError('Repository clone URL is required');
      return;
    }
    setImportBusy(true);
    try {
      const imported = await api.importServer({
        url: importForm.url.trim(),
        ...(importForm.name.trim() === '' ? {} : { name: importForm.name.trim() }),
        startAfterBuild: importForm.startAfterBuild,
      });
      setImportForm(EMPTY_IMPORT);
      setImportNotice(`Imported and registered “${imported.name}”.`);
      servers.reload();
    } catch (error) {
      setImportError(formatApiError(error));
    } finally {
      setImportBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {actionError !== null && (
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1">
            <ErrorState message={actionError} />
          </div>
          <GhostButton onClick={() => setActionError(null)}>Dismiss</GhostButton>
        </div>
      )}

      <Card
        title="Registered sub-servers"
        subtitle={`${serverList.length} registered · ${serverList.filter((server) => server.status === 'running').length} running`}
        actions={
          <SecondaryButton onClick={servers.reload} className="px-2 py-1 text-xs">
            Refresh
          </SecondaryButton>
        }
        padded={false}
      >
        {servers.status === 'loading' && <LoadingState label="Loading sub-servers…" />}
        {servers.status === 'error' && (
          <div className="p-4">
            <ErrorState message={servers.error} onRetry={servers.reload} />
          </div>
        )}
        {servers.status === 'ready' &&
          (serverList.length === 0 ? (
            <EmptyState
              title="Catalog is empty"
              description="Register a stdio command below or import a repository with an mcp-manifest.json."
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
                    <div>
                      <p className="font-medium text-slate-200">{server.name}</p>
                      <p className="font-mono text-[11px] text-slate-500">{server.id}</p>
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
                  key: 'pid',
                  header: 'PID',
                  render: (server) => (
                    <span className="font-mono text-xs text-slate-400">{server.pid ?? '—'}</span>
                  ),
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
                      <GhostButton onClick={() => setLogsFor(logsFor === server.id ? null : server.id)}>
                        Logs
                      </GhostButton>
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

      {logsFor !== null && (
        <Card
          title={`Logs · ${serverList.find((server) => server.id === logsFor)?.name ?? logsFor}`}
          subtitle="stdout/stderr ring buffer plus live WebSocket stream"
          actions={<GhostButton onClick={() => setLogsFor(null)}>Close</GhostButton>}
        >
          <ServerLogs serverId={logsFor} />
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Register sub-server" subtitle="POST /mcp/v1/admin/servers">
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <TextInput
                  value={registerForm.name}
                  onChange={(event) => setRegisterForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="postgres"
                />
              </Field>
              <Field label="High-privilege tools" hint="comma or space separated">
                <TextInput
                  value={registerForm.highPrivilegeTools}
                  onChange={(event) =>
                    setRegisterForm((prev) => ({ ...prev, highPrivilegeTools: event.target.value }))
                  }
                  placeholder="danger_delete drop_table"
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Runtime">
                <Select
                  value={registerForm.runtime}
                  onChange={(event) =>
                    setRegisterForm((prev) => ({ ...prev, runtime: event.target.value as RuntimeKind }))
                  }
                >
                  {RUNTIMES.map((runtime) => (
                    <option key={runtime} value={runtime}>
                      {runtime}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Transport">
                <Select
                  value={registerForm.transport}
                  onChange={(event) =>
                    setRegisterForm((prev) => ({ ...prev, transport: event.target.value as TransportKind }))
                  }
                >
                  {TRANSPORTS.map((transport) => (
                    <option key={transport} value={transport}>
                      {transport}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Command" hint="required for stdio">
                <TextInput
                  value={registerForm.command}
                  onChange={(event) => setRegisterForm((prev) => ({ ...prev, command: event.target.value }))}
                  placeholder="node"
                />
              </Field>
              <Field label="Arguments" hint="space separated">
                <TextInput
                  value={registerForm.args}
                  onChange={(event) => setRegisterForm((prev) => ({ ...prev, args: event.target.value }))}
                  placeholder="./server.mjs --port 9000"
                />
              </Field>
            </div>
            <Field label="Remote URL" hint="http / sse / websocket transports">
              <TextInput
                value={registerForm.url}
                onChange={(event) => setRegisterForm((prev) => ({ ...prev, url: event.target.value }))}
                placeholder="https://mcp.example.dev/sse"
              />
            </Field>
            <Field label="Environment (JSON object)" hint="values may reference vault secret names">
              <TextArea
                rows={3}
                value={registerForm.env}
                onChange={(event) => setRegisterForm((prev) => ({ ...prev, env: event.target.value }))}
                placeholder='{"GITHUB_PAT_TOKEN": "GITHUB_PAT"}'
              />
            </Field>
            <CheckboxField
              label="Delegation supported (expose this sub-server to sub-agent delegation)"
              checked={registerForm.delegationSupported}
              onChange={(checked) => setRegisterForm((prev) => ({ ...prev, delegationSupported: checked }))}
            />
            {registerError !== null && (
              <p className="rounded-lg border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
                {registerError}
              </p>
            )}
            {registerNotice !== null && (
              <p className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
                {registerNotice}
              </p>
            )}
            <PrimaryButton onClick={() => void submitRegister()} disabled={registerBusy}>
              {registerBusy ? 'Registering…' : 'Register server'}
            </PrimaryButton>
          </div>
        </Card>

        <Card title="Import from Git" subtitle="POST /mcp/v1/admin/servers/import">
          <div className="space-y-3">
            <InlineNotice>
              Clone URLs must match the gateway allowlist. The manifest&apos;s build command runs with a timeout
              before the sub-server is registered.
            </InlineNotice>
            <Field label="Repository URL">
              <TextInput
                value={importForm.url}
                onChange={(event) => setImportForm((prev) => ({ ...prev, url: event.target.value }))}
                placeholder="https://github.com/org/mcp-server"
              />
            </Field>
            <Field label="Name override" hint="optional — defaults to the manifest name">
              <TextInput
                value={importForm.name}
                onChange={(event) => setImportForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="custom-name"
              />
            </Field>
            <CheckboxField
              label="Start the sub-server after a successful build"
              checked={importForm.startAfterBuild}
              onChange={(checked) => setImportForm((prev) => ({ ...prev, startAfterBuild: checked }))}
            />
            {importError !== null && (
              <p className="rounded-lg border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
                {importError}
              </p>
            )}
            {importNotice !== null && (
              <p className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
                {importNotice}
              </p>
            )}
            <PrimaryButton onClick={() => void submitImport()} disabled={importBusy}>
              {importBusy ? 'Clone · build · register…' : 'Import repository'}
            </PrimaryButton>
          </div>
        </Card>
      </div>

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
