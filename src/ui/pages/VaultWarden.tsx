import { useState } from 'react';
import { api, formatApiError } from '../lib/api.js';
import { useAsyncData } from '../lib/hooks.js';
import { formatDuration, formatTimestamp } from '../lib/format.js';
import { Card } from '../components/Card.js';
import { Badge, badgeToneForStatus } from '../components/Badge.js';
import { Table } from '../components/Table.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState, Notice } from '../components/States.js';
import { SkeletonBlock, SkeletonTable } from '../components/Skeleton.js';
import { JsonViewer } from '../components/JsonViewer.js';
import { DangerButton, GhostButton, PrimaryButton, SecondaryButton } from '../components/Form.js';
import { useToast } from '../components/Toasts.js';
import type { PageKey } from '../components/Layout.js';
import type { CatalogTab } from './catalog/shared.js';
import type { EscalationTicket } from '../../core/types.js';
import type { VaultWardenOverview, VaultWardenTool } from '../lib/api.js';

export interface VaultWardenPageProps {
  onNavigate?: (page: PageKey, options?: { catalogTab?: CatalogTab }) => void;
}

interface Decision {
  status: 'approved' | 'denied';
  result?: unknown;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Collapse an MCP CallToolResult into displayable text (never a raw secret). */
function resultText(result: unknown): string {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'number' || typeof result === 'boolean') return String(result);
  if (isRecord(result)) {
    const content = result.content;
    if (Array.isArray(content)) {
      const texts = content
        .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : null))
        .filter((text): text is string => text !== null);
      if (texts.length > 0) return texts.join('\n');
    }
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

function toolBareName(toolId: string | null): string {
  if (toolId === null) return '—';
  const separator = toolId.lastIndexOf(':');
  return separator >= 0 ? toolId.slice(separator + 1) : toolId;
}

function fallbackNavigate(page: PageKey, catalogTab?: CatalogTab): void {
  if (typeof window === 'undefined') return;
  window.location.hash = catalogTab === undefined ? `#/${page}` : `#/${page}?tab=${catalogTab}`;
}

/** Vault Warden: credential-delivery tool protection, approvals and access log. */
export function VaultWardenPage({ onNavigate }: VaultWardenPageProps) {
  const toast = useToast();
  const overview = useAsyncData(() => api.getVaultWarden(), []);
  const [busyTicket, setBusyTicket] = useState<string | null>(null);
  const [protectBusy, setProtectBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const go = (page: PageKey, catalogTab?: CatalogTab): void => {
    if (onNavigate) onNavigate(page, catalogTab === undefined ? undefined : { catalogTab });
    else fallbackNavigate(page, catalogTab);
  };

  const data: VaultWardenOverview | null = overview.status === 'ready' ? overview.data : null;
  const installed = data?.installed === true;
  const serverId = data?.serverId ?? null;
  const tools: VaultWardenTool[] = data?.tools ?? [];
  const pending: EscalationTicket[] = data?.pendingApprovals ?? [];
  const accessLog = data?.accessLog ?? [];
  const pendingCount = pending.filter((ticket) => decisions[ticket.ticketId] === undefined).length;

  const protect = async (): Promise<void> => {
    if (!serverId) return;
    setProtectBusy(true);
    setActionError(null);
    try {
      await api.protectVaultWarden(serverId);
      toast('success', 'Vault Warden protection defaults applied.');
      overview.reload();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setProtectBusy(false);
    }
  };

  const resolve = async (ticket: EscalationTicket, status: 'approved' | 'denied'): Promise<void> => {
    setBusyTicket(ticket.ticketId);
    setActionError(null);
    try {
      const response = await api.resolveEscalation(ticket.ticketId, status);
      setDecisions((previous) => ({
        ...previous,
        [ticket.ticketId]: { status, result: response.result },
      }));
      toast(
        status === 'approved' ? 'success' : 'info',
        status === 'approved'
          ? `Approved “${toolBareName(ticket.toolId)}”. The stored credential delivery executes once.`
          : `Denied “${toolBareName(ticket.toolId)}”.`,
      );
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setBusyTicket(null);
    }
  };

  return (
    <div className="space-y-5">
      {actionError !== null && (
        <Notice tone="error" title="Vault Warden request failed" onDismiss={() => setActionError(null)}>
          {actionError}
        </Notice>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-100">Vault Warden</h2>
          <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-slate-400">
            Human-in-the-loop credential delivery for agents. Approval-gated tools pause until an operator
            authorises them here; every vault access is recorded below.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={installed ? 'success' : 'neutral'}>{installed ? 'installed' : 'not installed'}</Badge>
          <Badge tone={pendingCount > 0 ? 'warning' : 'neutral'}>{pendingCount} pending</Badge>
          <Badge tone="neutral">{accessLog.length} access events</Badge>
        </div>
      </div>

      {overview.status === 'loading' && (
        <div role="status" aria-label="Loading Vault Warden" className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
          <SkeletonBlock className="h-4 w-1/3" />
          <SkeletonBlock className="h-3 w-2/3" />
          <SkeletonBlock className="h-9 w-48" />
        </div>
      )}
      {overview.status === 'error' && <ErrorState message={overview.error} onRetry={overview.reload} />}

      {data !== null && !installed && (
        <Card title="Vault Warden is not installed" subtitle="GET /mcp/v1/admin/vaultwarden">
          <div className="space-y-4">
            <Notice tone="warning" title="Install the vaultwarden-mcp server to get started">
              Vault Warden gates credential delivery tools so agents never hold secrets directly. Import{' '}
              <code className="font-mono text-amber-100">vaultwarden-mcp</code> from your connected catalog or from
              a local harness, then return here to approve credential requests.
            </Notice>
            <div className="flex flex-wrap gap-2">
              <PrimaryButton onClick={() => go('catalog', 'discover')} className="px-3 py-1.5 text-xs">
                Browse catalog
              </PrimaryButton>
              <SecondaryButton onClick={() => go('catalog', 'import')} className="px-3 py-1.5 text-xs">
                Import from harness
              </SecondaryButton>
              <SecondaryButton onClick={() => go('catalog', 'sources')} className="px-3 py-1.5 text-xs">
                Connect a catalog source
              </SecondaryButton>
            </div>
            <div>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Default protection sets
              </h3>
              <p className="mb-2 text-[11px] text-slate-500">
                Applying protection marks these tools high-privilege and approval-required on the vaultwarden-mcp
                server.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(data.defaults.highPrivilegeTools ?? []).map((tool) => (
                  <Badge key={`hp-${tool}`} tone="warning">
                    {tool}
                  </Badge>
                ))}
                {(data.defaults.approvalTools ?? []).map((tool) => (
                  <Badge key={`ap-${tool}`} tone="danger">
                    {tool}
                  </Badge>
                ))}
                {(data.defaults.highPrivilegeTools ?? []).length === 0 &&
                  (data.defaults.approvalTools ?? []).length === 0 && (
                    <span className="text-xs text-slate-500">No default tool sets configured.</span>
                  )}
              </div>
            </div>
          </div>
        </Card>
      )}

      {data !== null && installed && (
        <Card
          title="Vault Warden status"
          subtitle="Credential delivery is human-approved and file-based."
          actions={
            <>
              <SecondaryButton onClick={() => go('catalog')} className="px-2 py-1 text-xs">
                Open in Catalog
              </SecondaryButton>
              <PrimaryButton
                onClick={() => void protect()}
                disabled={protectBusy || serverId === null}
                className="px-3 py-1.5 text-xs"
              >
                {protectBusy ? 'Protecting…' : 'Protect defaults'}
              </PrimaryButton>
            </>
          }
        >
          <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Status</dt>
              <dd className="mt-1">
                <Badge tone={badgeToneForStatus(data.status ?? null)}>{data.status ?? 'unknown'}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Server</dt>
              <dd className="mt-1 text-sm font-medium text-slate-200">
                {data.serverName ?? 'vaultwarden'}
                <span className="ml-2 font-mono text-[10px] text-slate-500">{serverId ?? '—'}</span>
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Approval tools</dt>
              <dd className="mt-1 text-xs text-slate-300">
                {data.defaults.approvalTools.length} default · {tools.filter((tool) => tool.approvalRequired).length} active
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">High-privilege tools</dt>
              <dd className="mt-1 text-xs text-slate-300">
                {data.defaults.highPrivilegeTools.length} default · {tools.filter((tool) => tool.highPrivilege).length} active
              </dd>
            </div>
          </dl>
        </Card>
      )}

      <Notice tone="info" title="Secrets never enter the model context">
        Values never enter the model context — approvals execute once and return a short-lived file path.
      </Notice>

      <Card
        title="Tools & protection"
        subtitle={installed ? `${tools.length} tools reported by the vaultwarden-mcp server` : 'Tools appear once vaultwarden-mcp is installed'}
        actions={
          installed ? (
            <GhostButton onClick={() => void protect()} disabled={protectBusy}>
              {protectBusy ? 'Applying…' : 'Apply default protection'}
            </GhostButton>
          ) : undefined
        }
        padded={false}
      >
        {overview.status === 'loading' && <SkeletonTable rows={3} columns={3} label="Loading Vault Warden tools…" />}
        {overview.status === 'ready' &&
          (tools.length === 0 ? (
            <EmptyState
              icon="⛨"
              title={installed ? 'No tools reported yet' : 'Vault Warden is not installed'}
              description={
                installed
                  ? 'Start the vaultwarden-mcp server, then refresh to load its tool list and apply protection.'
                  : 'Import vaultwarden-mcp from the catalog to see its credential-delivery tools and apply default protection.'
              }
              action={
                installed ? undefined : (
                  <SecondaryButton onClick={() => go('catalog', 'import')} className="px-3 py-1.5 text-xs">
                    Import from harness
                  </SecondaryButton>
                )
              }
            />
          ) : (
            <Table<VaultWardenTool>
              rows={tools}
              getRowKey={(tool) => tool.name}
              columns={[
                {
                  key: 'tool',
                  header: 'Tool',
                  render: (tool) => <span className="font-mono text-xs text-slate-200">{tool.name}</span>,
                },
                {
                  key: 'description',
                  header: 'Description',
                  render: (tool) => (
                    <span className="block max-w-xl text-xs text-slate-400">{tool.description || '—'}</span>
                  ),
                },
                {
                  key: 'flags',
                  header: 'Protection',
                  render: (tool) => (
                    <div className="flex flex-wrap gap-1">
                      {tool.highPrivilege ? <Badge tone="warning">High-privilege</Badge> : null}
                      {tool.approvalRequired ? <Badge tone="danger">Approval required</Badge> : null}
                      {!tool.highPrivilege && !tool.approvalRequired ? (
                        <Badge tone="neutral">unprotected</Badge>
                      ) : null}
                    </div>
                  ),
                },
                {
                  key: 'actions',
                  header: 'Action',
                  render: () => (
                    <GhostButton onClick={() => void protect()} disabled={protectBusy || serverId === null}>
                      Protect
                    </GhostButton>
                  ),
                },
              ]}
            />
          ))}
      </Card>

      <Card
        title="Pending credential requests"
        subtitle={`${pending.length} ticket${pending.length === 1 ? '' : 's'} awaiting a human decision`}
        actions={<GhostButton onClick={overview.reload}>Refresh</GhostButton>}
        padded={false}
      >
        {overview.status === 'loading' && <SkeletonTable rows={2} columns={2} label="Loading approvals…" />}
        {overview.status === 'ready' &&
          (pending.length === 0 ? (
            <EmptyState
              icon="✓"
              title="No pending credential requests"
              description="When an agent calls an approval-gated tool (for example vault_deliver_credential), it waits here until a supervisor approves or denies it. Approvals execute the stored call exactly once."
            />
          ) : (
            <ul className="divide-y divide-slate-800/70">
              {pending.map((ticket) => {
                const decision = decisions[ticket.ticketId];
                const isExpanded = expanded[ticket.ticketId] === true;
                const busy = busyTicket === ticket.ticketId;
                return (
                  <li key={ticket.ticketId} className="space-y-3 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-mono text-sm font-medium text-slate-100">
                          {toolBareName(ticket.toolId)}
                        </p>
                        <p className="mt-0.5 font-mono text-[10px] text-slate-500">
                          {ticket.ticketId} · server {ticket.serverId ?? '—'}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone="warning">credential request</Badge>
                        <Badge tone={decision ? (decision.status === 'approved' ? 'success' : 'danger') : 'warning'}>
                          {decision?.status ?? ticket.status}
                        </Badge>
                        <span className="text-[11px] text-slate-500">{formatTimestamp(ticket.createdAt)}</span>
                      </div>
                    </div>

                    <div className="grid gap-3 text-[11px] sm:grid-cols-3">
                      <div>
                        <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                          Requesting key
                        </span>
                        <span className="font-mono text-slate-300">{ticket.keyId}</span>
                      </div>
                      <div>
                        <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                          Reason
                        </span>
                        <Badge tone="neutral">{ticket.reason}</Badge>
                      </div>
                      <div>
                        <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                          Tool id
                        </span>
                        <span className="block truncate font-mono text-slate-300" title={ticket.toolId ?? ''}>
                          {ticket.toolId ?? '—'}
                        </span>
                      </div>
                    </div>

                    <div>
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded((previous) => ({
                            ...previous,
                            [ticket.ticketId]: !previous[ticket.ticketId],
                          }))
                        }
                        aria-expanded={isExpanded}
                        className="text-[11px] font-semibold uppercase tracking-wide text-sky-300 transition-colors hover:text-sky-200"
                      >
                        {isExpanded ? 'Hide arguments' : 'Show arguments'}
                      </button>
                      {isExpanded && (
                        <div className="mt-2">
                          <JsonViewer
                            value={ticket.toolArguments ?? ticket.requestPayload}
                            emptyLabel="No arguments captured"
                            maxHeight="14rem"
                          />
                        </div>
                      )}
                    </div>

                    {decision !== undefined ? (
                      <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                        {decision.status === 'approved' ? (
                          <div className="space-y-2">
                            <p className="text-xs font-semibold text-emerald-300">
                              Approved — stored result (delivered once)
                            </p>
                            <pre className="terminal-scroll max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-800 bg-slate-950/80 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
                              {resultText(decision.result) || 'Approved. The agent can collect the stored result once.'}
                            </pre>
                            <p className="text-[10px] text-slate-500">
                              The ticket is consumed after the agent retries with it; values are never returned in
                              the model context.
                            </p>
                          </div>
                        ) : (
                          <p className="text-xs font-semibold text-rose-300">
                            Denied — the agent cannot execute this tool call.
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        <PrimaryButton
                          onClick={() => void resolve(ticket, 'approved')}
                          disabled={busyTicket !== null}
                          className="px-3 py-1.5 text-xs"
                        >
                          {busy ? 'Approving…' : 'Approve'}
                        </PrimaryButton>
                        <DangerButton
                          onClick={() => void resolve(ticket, 'denied')}
                          disabled={busyTicket !== null}
                          className="px-3 py-1.5 text-xs"
                        >
                          Deny
                        </DangerButton>
                      </div>
                    )}
                    {decision !== undefined && (
                      <p className="text-[10px] text-slate-500">
                        Resolution recorded for {ticket.ticketId}. Refresh to reload the pending queue.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          ))}
      </Card>

      <Card
        title="Vault access log"
        subtitle="Recent vault_* tool calls recorded by the gateway audit trail"
        padded={false}
      >
        {overview.status === 'loading' && <SkeletonTable rows={3} columns={5} label="Loading vault access…" />}
        {overview.status === 'ready' && (
          <Table
            rows={accessLog}
            getRowKey={(entry, index) => `${entry.id}-${index}`}
            empty={
              <EmptyState
                icon="≡"
                title="No vault access recorded"
                description="Approved credential deliveries and other vault_* tool calls are recorded here with key, status and latency."
              />
            }
            columns={[
              {
                key: 'time',
                header: 'Time',
                render: (entry) => (
                  <span className="text-[11px] text-slate-500">{formatTimestamp(entry.ts)}</span>
                ),
              },
              {
                key: 'key',
                header: 'Key',
                render: (entry) => (
                  <span className="font-mono text-[11px] text-slate-300">{entry.keyId ?? '—'}</span>
                ),
              },
              {
                key: 'tool',
                header: 'Tool',
                render: (entry) => (
                  <span className="font-mono text-[11px] text-slate-300">{entry.toolId ?? entry.method}</span>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                render: (entry) => <Badge tone={badgeToneForStatus(entry.status)}>{entry.status}</Badge>,
              },
              {
                key: 'latency',
                header: 'Latency',
                render: (entry) => (
                  <span className="tabular-nums text-[11px] text-slate-400">{formatDuration(entry.latencyMs)}</span>
                ),
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
