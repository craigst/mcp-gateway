import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useAsyncData } from '../../lib/hooks.js';
import { Card } from '../../components/Card.js';
import { Badge, badgeToneForStatus } from '../../components/Badge.js';
import { StatTile } from '../../components/StatTile.js';
import { Table } from '../../components/Table.js';
import { JsonViewer } from '../../components/JsonViewer.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorState } from '../../components/States.js';
import { SkeletonTable } from '../../components/Skeleton.js';
import { Field, GhostButton, Select } from '../../components/Form.js';
import { formatDuration, formatNumber, formatPercent, formatTimestamp } from '../../lib/format.js';
import type {
  AuditEntry,
  ServerActivityPage,
  ServerKeyUsage,
  ServerUsageStats,
  ToolDescriptor,
} from '../../../core/types.js';

const PAGE_SIZE = 25;

type Preset = 'all' | 'failed' | 'denied' | 'ok';

const PRESETS: readonly { value: Preset; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'failed', label: 'Failed' },
  { value: 'denied', label: 'Denied' },
  { value: 'ok', label: 'OK' },
];

export interface ActivityTabProps {
  serverId: string;
  initialSummary: ServerUsageStats;
  keysUsed: ServerKeyUsage[];
  tools: ToolDescriptor[];
}

/** Activity tab: paginated, filtered audit slice for one server. */
export function ActivityTab({ serverId, initialSummary, keysUsed, tools }: ActivityTabProps) {
  const [preset, setPreset] = useState<Preset>('all');
  const [keyId, setKeyId] = useState('');
  const [toolId, setToolId] = useState('');
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const activity = useAsyncData<ServerActivityPage>(async () => {
    const base = {
      keyId: keyId === '' ? undefined : keyId,
      toolId: toolId === '' ? undefined : toolId,
      limit: PAGE_SIZE,
      offset,
    };
    if (preset === 'failed') {
      const [errors, denied] = await Promise.all([
        api.getServerActivity(serverId, { ...base, status: 'error' }),
        api.getServerActivity(serverId, { ...base, status: 'denied' }),
      ]);
      const merged = new Map<number, AuditEntry>();
      for (const entry of [...errors.entries, ...denied.entries]) merged.set(entry.id, entry);
      return {
        summary: errors.summary,
        entries: [...merged.values()]
          .sort((left, right) => right.ts.localeCompare(left.ts))
          .slice(0, PAGE_SIZE),
        total: errors.total + denied.total,
      };
    }
    return api.getServerActivity(serverId, {
      ...base,
      ...(preset === 'all' ? {} : { status: preset }),
    });
  }, [serverId, preset, keyId, toolId, offset]);

  const summary = activity.status === 'ready' ? activity.data.summary : initialSummary;
  const entries: AuditEntry[] = activity.status === 'ready' ? activity.data.entries : [];
  const total = activity.status === 'ready' ? activity.data.total : 0;
  const keyNames = new Map(keysUsed.map((key) => [key.keyId, key.keyName]));

  const setPresetAndReset = (next: Preset): void => {
    setPreset(next);
    setOffset(0);
    setExpandedId(null);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Requests" value={formatNumber(summary.total)} hint="all statuses" tone="info" />
        <StatTile label="OK" value={formatNumber(summary.ok)} tone="success" />
        <StatTile label="Errors" value={formatNumber(summary.error)} tone={summary.error > 0 ? 'danger' : 'default'} />
        <StatTile label="Denied" value={formatNumber(summary.denied)} tone={summary.denied > 0 ? 'warning' : 'default'} />
        <StatTile label="Error rate" value={formatPercent(summary.errorRate)} hint="error + denied share" />
        <StatTile
          label="Last used"
          value={summary.lastUsedAt === null ? 'never' : formatTimestamp(summary.lastUsedAt)}
        />
        <StatTile label="P95 latency" value={formatDuration(summary.p95LatencyMs)} hint={`avg ${formatDuration(summary.avgLatencyMs)}`} />
        <StatTile label="Distinct keys" value={formatNumber(summary.distinctKeys)} hint={`${keysUsed.length} seen`} />
      </div>

      <Card
        title="Activity"
        subtitle="Per-server audit slice with status, key and tool filters"
        actions={
          <GhostButton
            onClick={() => {
              setOffset(0);
              activity.reload();
            }}
          >
            Refresh
          </GhostButton>
        }
        padded={false}
      >
        <div className="flex flex-wrap items-end gap-3 border-b border-slate-800 px-4 py-3">
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setPresetAndReset(option.value)}
                aria-pressed={preset === option.value}
                className={
                  preset === option.value
                    ? 'rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-sky-300'
                    : 'rounded-full px-3 py-1 text-xs font-medium text-slate-400 transition-colors hover:bg-slate-900 hover:text-slate-200'
                }
              >
                {option.label}
              </button>
            ))}
          </div>
          <Field label="Key" className="w-full sm:w-52">
            <Select
              value={keyId}
              onChange={(event) => {
                setKeyId(event.target.value);
                setOffset(0);
                setExpandedId(null);
              }}
            >
              <option value="">any key</option>
              {keysUsed.map((key) => (
                <option key={key.keyId} value={key.keyId}>
                  {key.keyName} ({key.keyType})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tool" className="w-full sm:w-64">
            <Select
              value={toolId}
              onChange={(event) => {
                setToolId(event.target.value);
                setOffset(0);
                setExpandedId(null);
              }}
            >
              <option value="">any tool</option>
              {tools.map((tool) => (
                <option key={tool.id} value={tool.id}>
                  {tool.name}
                </option>
              ))}
            </Select>
          </Field>
          <span className="ml-auto self-center text-[11px] text-slate-500">
            {activity.status === 'ready' ? `${formatNumber(total)} matching` : 'querying…'}
          </span>
        </div>

        {activity.status === 'loading' && <SkeletonTable rows={5} columns={5} label="Loading activity…" />}
        {activity.status === 'error' && (
          <div className="p-4">
            <ErrorState message={activity.error} onRetry={activity.reload} />
          </div>
        )}
        {activity.status === 'ready' && (
          <>
            <Table<AuditEntry>
              rows={entries}
              getRowKey={(entry) => String(entry.id)}
              expandedKey={expandedId}
              onRowClick={(entry) =>
                setExpandedId((current) => (current === String(entry.id) ? null : String(entry.id)))
              }
              empty={
                <EmptyState
                  title="No matching activity"
                  description="This server has no recorded calls for the selected filters."
                />
              }
              columns={[
                {
                  key: 'ts',
                  header: 'Time',
                  render: (entry) => (
                    <span className="text-[11px] text-slate-500">{formatTimestamp(entry.ts)}</span>
                  ),
                },
                {
                  key: 'key',
                  header: 'Key',
                  render: (entry) => (
                    <span className="font-mono text-[11px] text-slate-300">
                      {entry.keyId === null ? '—' : keyNames.get(entry.keyId) ?? entry.keyId}
                    </span>
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
                    <span className="tabular-nums text-[11px] text-slate-400">
                      {formatDuration(entry.latencyMs)}
                    </span>
                  ),
                },
              ]}
              renderExpanded={(entry) => (
                <div className="grid gap-3 lg:grid-cols-2">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
                    <dt className="text-slate-500">Method</dt>
                    <dd className="font-mono text-slate-300">{entry.method}</dd>
                    <dt className="text-slate-500">Request id</dt>
                    <dd className="font-mono text-slate-300">{entry.requestId ?? '—'}</dd>
                    <dt className="text-slate-500">Error code</dt>
                    <dd className="font-mono text-slate-300">{entry.errorCode ?? '—'}</dd>
                    <dt className="text-slate-500">Delegation depth</dt>
                    <dd className="text-slate-300">{entry.delegationDepth}</dd>
                  </dl>
                  <div>
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Payload</p>
                    <JsonViewer value={entry.payload} maxHeight="14rem" />
                  </div>
                </div>
              )}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 px-4 py-2.5">
              <p className="text-xs text-slate-500">
                Showing {entries.length === 0 ? 0 : offset + 1}–{offset + entries.length} of {formatNumber(total)}
              </p>
              <div className="flex gap-1">
                <GhostButton onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}>
                  Previous
                </GhostButton>
                <GhostButton
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                  disabled={offset + entries.length >= total}
                >
                  Next
                </GhostButton>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
