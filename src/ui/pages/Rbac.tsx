import { useState } from 'react';
import { api, formatApiError } from '../lib/api.js';
import { useAsyncData } from '../lib/hooks.js';
import {
  buildScopeMatrix,
  describeGrants,
  hasFormErrors,
  validateKeyForm,
} from '../lib/rbac.js';
import type { KeyFormErrors, ScopeRow, ScopeTool } from '../lib/rbac.js';
import { formatTimestamp } from '../lib/format.js';
import { KEY_TYPES } from '../../core/types.js';
import type { KeySummary, KeyType, ServerGrant, ServerRecord } from '../../core/types.js';
import { Card } from '../components/Card.js';
import { Badge, badgeToneForStatus } from '../components/Badge.js';
import { Table } from '../components/Table.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState, InlineNotice, LoadingState } from '../components/States.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import {
  CheckboxField,
  DangerButton,
  Field,
  GhostButton,
  PrimaryButton,
  SecondaryButton,
  Select,
  TextInput,
} from '../components/Form.js';

interface RpcToolItem {
  name: string;
  description?: string;
  server_id: string;
  tool_id?: string;
}

interface RpcToolList {
  tools?: RpcToolItem[];
  total?: number;
}

interface CreateFormState {
  name: string;
  keyType: KeyType;
  expiresHours: string;
  delegationAllowed: boolean;
  escalationAllowed: boolean;
}

interface ServerSelection {
  enabled: boolean;
  /** Explicit normal-tool choices; a missing entry means "checked" (grant all by default). */
  tools: Record<string, boolean>;
  /** High-privilege tools are opt-in only. */
  highPrivilege: Record<string, boolean>;
}

interface CreatedKey {
  key: KeySummary;
  plaintext: string;
}

const EMPTY_FORM: CreateFormState = {
  name: '',
  keyType: 'agent',
  expiresHours: '',
  delegationAllowed: false,
  escalationAllowed: true,
};

function keyStatus(key: KeySummary): string {
  if (key.revokedAt !== null) return 'revoked';
  if (key.expiresAt !== null && new Date(key.expiresAt).getTime() < Date.now()) return 'expired';
  return 'active';
}

function selectionFor(selection: Record<string, ServerSelection>, serverId: string): ServerSelection {
  return selection[serverId] ?? { enabled: false, tools: {}, highPrivilege: {} };
}

function buildGrantsFromSelection(matrix: ScopeRow[], selection: Record<string, ServerSelection>): ServerGrant[] {
  const grants: ServerGrant[] = [];
  for (const row of matrix) {
    const selected = selection[row.serverId];
    if (!selected || !selected.enabled) continue;
    const normalCells = row.cells.filter((cell) => !cell.highPrivilege);
    const chosenTools = normalCells
      .filter((cell) => selected.tools[cell.toolId] !== false)
      .map((cell) => cell.toolName);
    const highPrivilegeTools = row.cells
      .filter((cell) => cell.highPrivilege && selected.highPrivilege[cell.toolId] === true)
      .map((cell) => cell.toolName);
    grants.push({
      serverId: row.serverId,
      tools: chosenTools.length === normalCells.length ? null : chosenTools,
      highPrivilegeTools,
    });
  }
  return grants;
}

/** RBAC scope grid: key inventory, one-click provisioning with per-tool grants, revocation. */
export function RbacPage() {
  const keys = useAsyncData(() => api.listKeys(), []);
  const servers = useAsyncData(() => api.listServers(), []);
  const tools = useAsyncData(() => api.rpc<RpcToolList>('tools/list', {}), []);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateFormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<KeyFormErrors>({});
  const [selection, setSelection] = useState<Record<string, ServerSelection>>({});
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [copied, setCopied] = useState(false);

  const [revokeTarget, setRevokeTarget] = useState<KeySummary | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const serverList: ServerRecord[] = servers.status === 'ready' ? servers.data : [];
  const scopeTools: ScopeTool[] =
    tools.status === 'ready'
      ? (tools.data.tools ?? []).map((tool) => ({
          id: tool.tool_id ?? `${tool.server_id}:${tool.name}`,
          name: tool.name,
          serverId: tool.server_id,
        }))
      : [];
  const matrix = buildScopeMatrix(serverList, scopeTools, []);

  const toggleServer = (serverId: string): void => {
    setSelection((previous) => {
      const current = selectionFor(previous, serverId);
      return { ...previous, [serverId]: { ...current, enabled: !current.enabled } };
    });
  };

  const toggleTool = (serverId: string, toolId: string, checked: boolean, highPrivilege: boolean): void => {
    setSelection((previous) => {
      const current = selectionFor(previous, serverId);
      const bucket = highPrivilege ? current.highPrivilege : current.tools;
      return {
        ...previous,
        [serverId]: {
          ...current,
          ...(highPrivilege
            ? { highPrivilege: { ...bucket, [toolId]: checked } }
            : { tools: { ...bucket, [toolId]: checked } }),
        },
      };
    });
  };

  const openCreate = (): void => {
    setForm(EMPTY_FORM);
    setSelection({});
    setErrors({});
    setCreateError(null);
    setCreateOpen(true);
    if (servers.status !== 'ready') servers.reload();
    if (tools.status !== 'ready') tools.reload();
  };

  const submitCreate = async (): Promise<void> => {
    setCreateError(null);
    const grants = buildGrantsFromSelection(matrix, selection);
    const expiresInSeconds =
      form.expiresHours.trim() === '' ? null : Math.round(Number(form.expiresHours) * 3600);
    const nextErrors = validateKeyForm({
      name: form.name,
      keyType: form.keyType,
      serverGrants: grants,
      delegationAllowed: form.delegationAllowed,
      escalationAllowed: form.escalationAllowed,
      expiresInSeconds,
    });
    setErrors(nextErrors);
    if (hasFormErrors(nextErrors)) return;

    setCreateBusy(true);
    try {
      const response = await api.createKey({
        name: form.name.trim(),
        keyType: form.keyType,
        serverGrants: grants,
        delegationAllowed: form.delegationAllowed,
        escalationAllowed: form.escalationAllowed,
        expiresInSeconds,
      });
      setCreated(response);
      setCreateOpen(false);
      setCopied(false);
      keys.reload();
    } catch (error) {
      setCreateError(formatApiError(error));
    } finally {
      setCreateBusy(false);
    }
  };

  const confirmRevoke = async (): Promise<void> => {
    if (!revokeTarget) return;
    setRevokeBusy(true);
    setActionError(null);
    try {
      await api.revokeKey(revokeTarget.id);
      setRevokeTarget(null);
      keys.reload();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setRevokeBusy(false);
    }
  };

  const copyPlaintext = (): void => {
    if (!created) return;
    void navigator.clipboard?.writeText(created.plaintext).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <div className="space-y-5">
      <InlineNotice>
        Key and server provisioning requires a <code>master</code> key (audit and escalations also accept{' '}
        <code>sup</code>). Plaintext keys are shown exactly once — store the key in this console via “Set API key”.
      </InlineNotice>

      {actionError !== null && (
        <div className="flex items-start gap-2">
          <div className="flex-1">
            <ErrorState message={actionError} />
          </div>
          <GhostButton onClick={() => setActionError(null)}>Dismiss</GhostButton>
        </div>
      )}

      <Card
        title="API keys"
        subtitle={`${keys.status === 'ready' ? keys.data.length : '…'} issued · scoped per server and tool`}
        actions={
          <>
            <SecondaryButton onClick={keys.reload} className="px-2 py-1 text-xs">
              Refresh
            </SecondaryButton>
            <PrimaryButton onClick={openCreate} className="px-3 py-1.5 text-xs">
              New key
            </PrimaryButton>
          </>
        }
        padded={false}
      >
        {keys.status === 'loading' && <LoadingState label="Loading keys…" />}
        {keys.status === 'error' && (
          <div className="p-4">
            <ErrorState message={keys.error} onRetry={keys.reload} />
          </div>
        )}
        {keys.status === 'ready' &&
          (keys.data.length === 0 ? (
            <EmptyState
              title="No API keys issued"
              description="Create a scoped key for an agent, developer or supervisor."
              action={
                <PrimaryButton onClick={openCreate} className="px-3 py-1.5 text-xs">
                  Create key
                </PrimaryButton>
              }
            />
          ) : (
            <Table<KeySummary>
              rows={keys.data}
              getRowKey={(key) => key.id}
              columns={[
                {
                  key: 'name',
                  header: 'Key',
                  render: (key) => (
                    <div>
                      <p className="font-medium text-slate-200">{key.name}</p>
                      <p className="font-mono text-[11px] text-slate-500">{key.id}</p>
                    </div>
                  ),
                },
                {
                  key: 'type',
                  header: 'Type',
                  render: (key) => <Badge tone={key.keyType === 'master' ? 'danger' : 'info'}>{key.keyType}</Badge>,
                },
                {
                  key: 'prefix',
                  header: 'Prefix',
                  render: (key) => <span className="font-mono text-xs text-slate-400">{key.keyPrefix}…</span>,
                },
                {
                  key: 'grants',
                  header: 'Grants',
                  render: (key) => (
                    <span className="block max-w-[18rem] text-xs text-slate-400" title={describeGrants(key.serverGrants)}>
                      {describeGrants(key.serverGrants)}
                    </span>
                  ),
                },
                {
                  key: 'flags',
                  header: 'Flags',
                  render: (key) => (
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={key.delegationAllowed ? 'success' : 'neutral'}>
                        delegate {key.delegationAllowed ? 'on' : 'off'}
                      </Badge>
                      <Badge tone={key.escalationAllowed ? 'info' : 'neutral'}>
                        escalate {key.escalationAllowed ? 'on' : 'off'}
                      </Badge>
                    </div>
                  ),
                },
                {
                  key: 'expiry',
                  header: 'Expiry',
                  render: (key) => (
                    <span className="text-xs text-slate-500">
                      {key.expiresAt === null ? 'never' : formatTimestamp(key.expiresAt)}
                    </span>
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (key) => {
                    const status = keyStatus(key);
                    return <Badge tone={badgeToneForStatus(status)}>{status}</Badge>;
                  },
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  render: (key) => (
                    <DangerButton
                      onClick={() => setRevokeTarget(key)}
                      disabled={key.revokedAt !== null}
                      className="px-2 py-1 text-[11px]"
                    >
                      Revoke
                    </DangerButton>
                  ),
                },
              ]}
            />
          ))}
      </Card>

      <ConfirmDialog
        open={createOpen}
        title="Create API key"
        size="xl"
        confirmLabel="Issue key"
        busy={createBusy}
        onConfirm={() => void submitCreate()}
        onCancel={() => setCreateOpen(false)}
        description="Select server grants and tool whitelists. High-privilege tools are opt-in and hidden from search/list unless explicitly granted."
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name" error={errors.name}>
              <TextInput
                value={form.name}
                onChange={(event) => setForm((previous) => ({ ...previous, name: event.target.value }))}
                placeholder="sales-agent"
                autoFocus
              />
            </Field>
            <Field label="Key type" error={errors.keyType}>
              <Select
                value={form.keyType}
                onChange={(event) => setForm((previous) => ({ ...previous, keyType: event.target.value as KeyType }))}
              >
                {KEY_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Expires in hours" hint="blank = never expires" error={errors.expiresInSeconds}>
              <TextInput
                type="number"
                min={1}
                step={1}
                value={form.expiresHours}
                onChange={(event) => setForm((previous) => ({ ...previous, expiresHours: event.target.value }))}
                placeholder="24"
              />
            </Field>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Server &amp; tool grants</p>
            {servers.status === 'loading' && <LoadingState label="Loading servers…" />}
            {servers.status === 'error' && <ErrorState message={servers.error} onRetry={servers.reload} />}
            {servers.status === 'ready' && matrix.length === 0 && (
              <EmptyState title="No sub-servers registered" description="Register a server first to scope this key." />
            )}
            {matrix.map((row) => {
              const selected = selectionFor(selection, row.serverId);
              return (
                <div key={row.serverId} className="mb-2 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                  <CheckboxField
                    checked={selected.enabled}
                    onChange={() => toggleServer(row.serverId)}
                    label={
                      <span>
                        <span className="font-medium text-slate-200">{row.serverName}</span>{' '}
                        <span className="font-mono text-[10px] text-slate-500">{row.serverId}</span>
                        <span className="ml-2 text-[10px] text-slate-500">
                          {row.cells.length} tool{row.cells.length === 1 ? '' : 's'}
                        </span>
                      </span>
                    }
                  />
                  {selected.enabled && row.cells.length > 0 && (
                    <div className="mt-2 grid gap-1.5 border-t border-slate-800/70 pt-2 sm:grid-cols-2">
                      {row.cells.map((cell) => (
                        <CheckboxField
                          key={cell.toolId}
                          checked={
                            cell.highPrivilege
                              ? selected.highPrivilege[cell.toolId] === true
                              : selected.tools[cell.toolId] !== false
                          }
                          onChange={(checked) =>
                            toggleTool(row.serverId, cell.toolId, checked, cell.highPrivilege)
                          }
                          label={
                            <span className="flex items-center gap-1.5">
                              <span className="font-mono text-[11px] text-slate-300">{cell.toolName}</span>
                              {cell.highPrivilege && <Badge tone="danger">high-priv</Badge>}
                            </span>
                          }
                        />
                      ))}
                    </div>
                  )}
                  {selected.enabled && row.cells.length === 0 && (
                    <p className="mt-2 border-t border-slate-800/70 pt-2 text-[11px] text-slate-500">
                      No tools discovered for this server yet.
                    </p>
                  )}
                </div>
              );
            })}
            {errors.serverGrants !== undefined && <p className="text-[11px] text-rose-400">{errors.serverGrants}</p>}
          </div>

          <div className="flex flex-wrap gap-4">
            <CheckboxField
              label="Allow sub-agent delegation"
              checked={form.delegationAllowed}
              onChange={(checked) => setForm((previous) => ({ ...previous, delegationAllowed: checked }))}
            />
            <CheckboxField
              label="Allow transient scope escalation"
              checked={form.escalationAllowed}
              onChange={(checked) => setForm((previous) => ({ ...previous, escalationAllowed: checked }))}
            />
          </div>

          {createError !== null && (
            <p className="rounded-lg border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
              {createError}
            </p>
          )}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={created !== null}
        title="API key created"
        confirmLabel="Done"
        cancelLabel="Close"
        onConfirm={() => setCreated(null)}
        onCancel={() => setCreated(null)}
        description="Copy the plaintext key now — the gateway never shows it again."
      >
        {created !== null && (
          <div className="space-y-3">
            <p className="text-xs text-slate-400">
              <span className="font-semibold text-slate-200">{created.key.name}</span> · {created.key.keyType} ·{' '}
              {created.key.keyPrefix}…
            </p>
            <pre className="overflow-x-auto rounded-lg border border-emerald-900/60 bg-slate-950 p-3 font-mono text-xs text-emerald-300">
              {created.plaintext}
            </pre>
            <div className="flex gap-2">
              <PrimaryButton onClick={copyPlaintext} className="px-3 py-1.5 text-xs">
                {copied ? 'Copied' : 'Copy key'}
              </PrimaryButton>
              <SecondaryButton
                onClick={() => {
                  api.setApiKey(created.plaintext);
                  setCreated(null);
                }}
                className="px-3 py-1.5 text-xs"
              >
                Use in this console
              </SecondaryButton>
            </div>
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revoke API key"
        tone="danger"
        confirmLabel="Revoke key"
        busy={revokeBusy}
        onConfirm={() => void confirmRevoke()}
        onCancel={() => setRevokeTarget(null)}
        description={
          revokeTarget !== null
            ? `Instantly lock out “${revokeTarget.name}” (${revokeTarget.keyPrefix}…)? This cannot be undone.`
            : undefined
        }
      />
    </div>
  );
}
