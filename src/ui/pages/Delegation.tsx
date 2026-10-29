import { useState } from 'react';
import { api, formatApiError } from '../lib/api.js';
import { useAsyncData } from '../lib/hooks.js';
import { formatDuration, formatNumber, formatTimestamp } from '../lib/format.js';
import { Card } from '../components/Card.js';
import { Badge, badgeToneForStatus } from '../components/Badge.js';
import { Table } from '../components/Table.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState, LoadingState } from '../components/States.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import {
  DangerButton,
  Field,
  GhostButton,
  PrimaryButton,
  Select,
  TextArea,
} from '../components/Form.js';
import type { DelegationTrace } from '../../core/ports.js';
import type { EscalationStatus, EscalationTicket } from '../../core/types.js';

type ResolveStatus = 'approved' | 'denied';

interface ResolveTarget {
  ticket: EscalationTicket;
  status: ResolveStatus;
}

const STATUS_TABS: ReadonlyArray<{ label: string; value: '' | EscalationStatus }> = [
  { label: 'Pending', value: 'pending' },
  { label: 'Approved', value: 'approved' },
  { label: 'Denied', value: 'denied' },
  { label: 'Expired', value: 'expired' },
  { label: 'All', value: '' },
];

/** Delegation observer: trace table + escalation approval queue. */
export function DelegationPage() {
  const [limit, setLimit] = useState(100);
  const [statusFilter, setStatusFilter] = useState<'' | EscalationStatus>('pending');
  const [resolveTarget, setResolveTarget] = useState<ResolveTarget | null>(null);
  const [note, setNote] = useState('');
  const [resolveBusy, setResolveBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const traces = useAsyncData(() => api.listDelegations(limit), [limit]);
  const escalations = useAsyncData(
    () => api.listEscalations(statusFilter === '' ? undefined : statusFilter),
    [statusFilter],
  );

  const traceList: DelegationTrace[] = traces.status === 'ready' ? traces.data : [];
  const ticketList: EscalationTicket[] = escalations.status === 'ready' ? escalations.data : [];

  const openResolve = (ticket: EscalationTicket, status: ResolveStatus): void => {
    setResolveTarget({ ticket, status });
    setNote('');
    setActionError(null);
  };

  const confirmResolve = async (): Promise<void> => {
    if (!resolveTarget) return;
    setResolveBusy(true);
    setActionError(null);
    try {
      await api.resolveEscalation(
        resolveTarget.ticket.ticketId,
        resolveTarget.status,
        note.trim() === '' ? undefined : note.trim(),
      );
      setResolveTarget(null);
      escalations.reload();
      traces.reload();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setResolveBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {actionError !== null && (
        <div className="flex items-start gap-2">
          <div className="flex-1">
            <ErrorState message={actionError} />
          </div>
          <GhostButton onClick={() => setActionError(null)}>Dismiss</GhostButton>
        </div>
      )}

      <Card
        title="Delegation traces"
        subtitle="Parent → child sub-agent calls, observer verdicts and depth"
        actions={
          <>
            <Select
              value={String(limit)}
              onChange={(event) => setLimit(Number(event.target.value))}
              className="w-auto px-2 py-1 text-xs"
            >
              {[25, 50, 100, 200].map((value) => (
                <option key={value} value={value}>
                  last {value}
                </option>
              ))}
            </Select>
            <GhostButton onClick={traces.reload}>Refresh</GhostButton>
          </>
        }
        padded={false}
      >
        {traces.status === 'loading' && <LoadingState label="Loading traces…" />}
        {traces.status === 'error' && (
          <div className="p-4">
            <ErrorState message={traces.error} onRetry={traces.reload} />
          </div>
        )}
        {traces.status === 'ready' && (
          <Table<DelegationTrace>
            rows={traceList}
            getRowKey={(trace) => trace.id}
            empty={
              <EmptyState
                title="No delegation traces"
                description="Agents/callers using agents/delegate will appear here with parent-child linkage."
              />
            }
            columns={[
              {
                key: 'trace',
                header: 'Trace',
                render: (trace) => (
                  <div>
                    <p className="font-mono text-xs text-slate-200">{trace.traceId}</p>
                    <p className="font-mono text-[10px] text-slate-500">
                      parent {trace.parentRequestId ?? '—'} → child {trace.childRequestId ?? '—'}
                    </p>
                  </div>
                ),
              },
              {
                key: 'target',
                header: 'Target',
                render: (trace) => <span className="text-xs text-slate-300">{trace.target}</span>,
              },
              {
                key: 'depth',
                header: 'Depth',
                render: (trace) => <span className="tabular-nums text-xs text-slate-400">{trace.depth}</span>,
              },
              {
                key: 'status',
                header: 'Status',
                render: (trace) => <Badge tone={badgeToneForStatus(trace.status)}>{trace.status}</Badge>,
              },
              {
                key: 'verdict',
                header: 'Observer verdict',
                render: (trace) => (
                  <span className="block max-w-[18rem] truncate text-xs text-slate-400" title={trace.verdict ?? ''}>
                    {trace.verdict ?? '—'}
                  </span>
                ),
              },
              {
                key: 'latency',
                header: 'Latency',
                render: (trace) => (
                  <span className="tabular-nums text-xs text-slate-400">{formatDuration(trace.latencyMs)}</span>
                ),
              },
              {
                key: 'created',
                header: 'Created',
                render: (trace) => (
                  <span className="text-xs text-slate-500">{formatTimestamp(trace.createdAt)}</span>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Card
        title="Escalation queue"
        subtitle="Transient scope requests raised when a call is denied"
        actions={<GhostButton onClick={escalations.reload}>Refresh</GhostButton>}
        padded={false}
      >
        <div className="flex flex-wrap gap-1 border-b border-slate-800 px-4 py-2">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value === '' ? 'all' : tab.value}
              type="button"
              onClick={() => setStatusFilter(tab.value)}
              aria-pressed={statusFilter === tab.value}
              className={
                statusFilter === tab.value
                  ? 'rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-sky-300'
                  : 'rounded-full px-3 py-1 text-xs font-medium text-slate-400 transition-colors hover:bg-slate-900 hover:text-slate-200'
              }
            >
              {tab.label}
            </button>
          ))}
          {escalations.status === 'ready' && (
            <span className="ml-auto self-center text-[11px] text-slate-500">
              {formatNumber(ticketList.length)} ticket{ticketList.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        {escalations.status === 'loading' && <LoadingState label="Loading escalations…" />}
        {escalations.status === 'error' && (
          <div className="p-4">
            <ErrorState message={escalations.error} onRetry={escalations.reload} />
          </div>
        )}
        {escalations.status === 'ready' && (
          <Table<EscalationTicket>
            rows={ticketList}
            getRowKey={(ticket) => ticket.id}
            empty={<EmptyState title="Queue is empty" description="No escalation tickets match this status." />}
            columns={[
              {
                key: 'ticket',
                header: 'Ticket',
                render: (ticket) => (
                  <div>
                    <p className="font-mono text-xs text-slate-200">{ticket.ticketId}</p>
                    <p className="font-mono text-[10px] text-slate-500">{ticket.keyId}</p>
                  </div>
                ),
              },
              {
                key: 'tool',
                header: 'Requested tool',
                render: (ticket) => (
                  <div className="text-[11px] text-slate-400">
                    <p className="font-mono text-slate-300">{ticket.toolId ?? '—'}</p>
                    <p>{ticket.serverId ?? ''}</p>
                  </div>
                ),
              },
              {
                key: 'reason',
                header: 'Reason',
                render: (ticket) => <Badge tone="warning">{ticket.reason}</Badge>,
              },
              {
                key: 'status',
                header: 'Status',
                render: (ticket) => <Badge tone={badgeToneForStatus(ticket.status)}>{ticket.status}</Badge>,
              },
              {
                key: 'created',
                header: 'Created',
                render: (ticket) => (
                  <span className="text-xs text-slate-500">{formatTimestamp(ticket.createdAt)}</span>
                ),
              },
              {
                key: 'actions',
                header: 'Actions',
                render: (ticket) =>
                  ticket.status === 'pending' ? (
                    <div className="flex flex-wrap gap-1">
                      <PrimaryButton
                        onClick={() => openResolve(ticket, 'approved')}
                        className="px-2 py-1 text-[11px]"
                      >
                        Approve
                      </PrimaryButton>
                      <DangerButton
                        onClick={() => openResolve(ticket, 'denied')}
                        className="px-2 py-1 text-[11px]"
                      >
                        Deny
                      </DangerButton>
                    </div>
                  ) : (
                    <span className="text-[11px] text-slate-500">{ticket.note ?? '—'}</span>
                  ),
              },
            ]}
          />
        )}
      </Card>

      <ConfirmDialog
        open={resolveTarget !== null}
        title={resolveTarget?.status === 'approved' ? 'Approve escalation' : 'Deny escalation'}
        tone={resolveTarget?.status === 'denied' ? 'danger' : 'default'}
        confirmLabel={resolveTarget?.status === 'approved' ? 'Approve' : 'Deny'}
        busy={resolveBusy}
        onConfirm={() => void confirmResolve()}
        onCancel={() => setResolveTarget(null)}
        description={
          resolveTarget !== null
            ? `Ticket ${resolveTarget.ticket.ticketId} for tool ${resolveTarget.ticket.toolId ?? '—'}. The decision is recorded in the audit log.`
            : undefined
        }
      >
        <Field label="Resolution note (optional)">
          <TextArea
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Reviewed by on-call operator"
          />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
