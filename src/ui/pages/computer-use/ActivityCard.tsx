import { Card } from '../../components/Card.js';
import { Badge, badgeToneForStatus } from '../../components/Badge.js';
import { Table } from '../../components/Table.js';
import type { Column } from '../../components/Table.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorState, LoadingState } from '../../components/States.js';
import { GhostButton } from '../../components/Form.js';
import { formatDuration, formatTimestamp } from '../../lib/format.js';
import type { AuditEntry } from '../../../core/types.js';

export interface ActivityCardProps {
  entries: readonly AuditEntry[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

/** Recent audit rows for the managed computer-use server. */
export function ActivityCard({ entries, loading, error, onRefresh }: ActivityCardProps) {
  const columns: ReadonlyArray<Column<AuditEntry>> = [
    {
      key: 'ts',
      header: 'Time',
      render: (entry) => (
        <span className="whitespace-nowrap text-[11px] tabular-nums text-slate-400">
          {formatTimestamp(entry.ts)}
        </span>
      ),
      headerClassName: 'w-44',
    },
    {
      key: 'status',
      header: 'Status',
      render: (entry) => (
        <span className="flex flex-col gap-0.5">
          <Badge tone={badgeToneForStatus(entry.status)}>{entry.status}</Badge>
          {entry.errorCode !== null && (
            <span className="font-mono text-[10px] text-rose-400/80">{entry.errorCode}</span>
          )}
        </span>
      ),
      headerClassName: 'w-24',
    },
    {
      key: 'tool',
      header: 'Tool',
      render: (entry) => (
        <span className="block min-w-0">
          <span className="block truncate font-mono text-[11px] text-slate-200">
            {entry.toolId ?? entry.method}
          </span>
          {entry.toolId !== null && (
            <span className="mt-0.5 block truncate font-mono text-[10px] text-slate-500">{entry.method}</span>
          )}
        </span>
      ),
    },
    {
      key: 'key',
      header: 'Key',
      render: (entry) => (
        <span className="block max-w-[10rem] truncate font-mono text-[11px] text-slate-400" title={entry.keyId ?? ''}>
          {entry.keyId ?? '—'}
        </span>
      ),
      headerClassName: 'w-40',
    },
    {
      key: 'latency',
      header: 'Latency',
      render: (entry) => (
        <span className="whitespace-nowrap text-[11px] tabular-nums text-slate-400">
          {formatDuration(entry.latencyMs)}
        </span>
      ),
      headerClassName: 'w-24',
    },
  ];

  return (
    <Card
      title="Recent activity"
      subtitle="Computer-use calls recorded in the audit log"
      padded={false}
      actions={
        <>
          <GhostButton onClick={onRefresh} disabled={loading}>
            Refresh
          </GhostButton>
          <a
            href="#/audit"
            className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:bg-slate-800"
          >
            Full audit →
          </a>
        </>
      }
    >
      {loading && <LoadingState label="Loading activity…" />}
      {!loading && error !== null && (
        <div className="p-4">
          <ErrorState message={error} onRetry={onRefresh} />
        </div>
      )}
      {!loading && error === null && (
        <Table
          columns={columns}
          rows={entries}
          getRowKey={(entry) => String(entry.id)}
          loading={false}
          empty={
            <EmptyState
              icon="≡"
              title="No computer-use activity yet"
              description="Calls made through the managed computer-use server will appear here with status, tool, key and latency."
            />
          }
        />
      )}
    </Card>
  );
}
