import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useAsyncData } from '../../lib/hooks.js';
import { Badge, badgeToneForStatus } from '../../components/Badge.js';
import { StatTile } from '../../components/StatTile.js';
import { Table } from '../../components/Table.js';
import { JsonViewer } from '../../components/JsonViewer.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorState } from '../../components/States.js';
import { SkeletonTable } from '../../components/Skeleton.js';
import { Field, GhostButton, Select } from '../../components/Form.js';
import { formatDuration, formatNumber, formatPercent, formatTimestamp } from '../../lib/format.js';
import type { AuditEntry, KeyActivityPage, KeyUsageStats } from '../../../core/types.js';

const PAGE_SIZE = 25;

type Preset = 'all' | 'failed' | 'denied' | 'ok';

const PRESETS: readonly { value: Preset; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'failed', label: 'Failed' },
  { value: 'denied', label: 'Denied' },
  { value: 'ok', label: 'OK' },
];

export interface KeyActivityTabProps {
  keyId: string;
}

/** Per-key audit activity with status presets and server/tool filters. */
export function KeyActivityTab({ keyId }: KeyActivityTabProps) {
  const [preset, setPreset] = useState<Preset>('all');
  const [serverId, setServerId] = useState('');
  const [toolId, setToolId] = useState('');
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const activity = useAsyncData<KeyActivityPage>(async () => {
    const base = {
      serverId: serverId === '' ? undefined : serverId,
      toolId: toolId === '' ? undefined : toolId,
      limit: PAGE_SIZE,
      offset,
    };
    if (preset === 'failed') {
      const [errors, denied] = await Promise.all([
        api.getKeyActivity(keyId, { ...base, status: 'error' }),
        api.getKeyActivity(keyId, { ...base, status: 'denied' }),
      ]);
      const merged = new Map<number, AuditEntry>();
      for (const entry of [...errors.entries, ...denied.entries]) merged.set(entry.id, entry);
      return {
        key: errors.key,
        stats: errors.stats,
        entries: [...merged.values()]
          .sort((left, right) => right.ts.localeCompare(left.ts))
          .slice(0, PAGE_SIZE),
        total: errors.total + denied.total,
      };
    }
    return api.getKeyActivity(keyId, {
      ...base,
      ...(preset === 'all' ? {} : { status: preset }),
    });
  }, [keyId, preset, serverId, toolId, offset]);

  const stats: KeyUsageStats | null = activity.status === 'ready' ? activity.data.stats : null;
  const entries = activity.status === 'ready' ? activity.data.entries : [];
  const total = activity.status === 'ready' ? activity.data.total : 0;

  const resetPage = (): void => {
    setOffset(0);
    setExpandedId(null);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatTile label="Requests" value={stats === null ? '—' : formatNumber(stats.total)} hint="all statuses" tone="info" />
        <StatTile label="OK" value={stats === null ? '—' : formatNumber(stats.ok)} tone="success" />
        <StatTile
          label="Errors"
          value={stats === null ? '—' : formatNumber(stats.error)}
          tone={stats !== null && stats.error > 0 ? 'danger' : 'default'}
        />
        <StatTile
          label="Denied"
          value={stats === null ? '—' : formatNumber(stats.denied)}
          tone={stats !== null && stats.denied > 0 ? 'warning' : 'default'}
        />
        <StatTile
          label="Last used"
          value={stats === null || stats.lastUsedAt === null ? 'never' : formatTimestamp(stats.lastUsedAt)}
          hint={stats === null ? undefined : `${formatNumber(stats.distinctServers)} servers · ${formatNumber(stats.distinctTools)} tools`}
        />
        <StatTile
          label="P95 latency"
          value={stats === null ? '—' : formatDuration(stats.p95LatencyMs)}
          hint={stats === null ? undefined : `error rate ${formatPercent((stats.error + stats.denied) / Math.max(1, stats.total))}`}
        />
      </div>

      <div className="rounded-xl border border-slate-800">
        <div className="flex flex-wrap items-end gap-3 border-b border-slate-800 px-4 py-3">
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  setPreset(option.value);
                  resetPage();
                }}
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
          <Field label="Server" className="w-full sm:w-52">
            <Select
              value={serverId}
              onChange={(event) => {
                setServerId(event.target.value);
                resetPage();
              }}
            >
              <option value="">any server</option>
              {(stats?.serverUsage ?? []).map((usage) => (
                <option key={usage.serverId} value={usage.serverId}>
                  {usage.name} ({usage.count})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tool" className="w-full sm:w-64">
            <Select
              value={toolId}
              onChange={(event) => {
                setToolId(event.target.value);
                resetPage();
              }}
            >
              <option value="">any tool</option>
              {(stats?.toolUsage ?? []).map((usage) => (
                <option key={usage.toolId} value={usage.toolId}>
                  {usage.name} ({usage.count})
                </option>
              ))}
            </Select>
          </Field>
          <GhostButton
            className="ml-auto"
            onClick={() => {
              resetPage();
              activity.reload();
            }}
          >
            Refresh
          </GhostButton>
        </div>

        {activity.status === 'loading' && <SkeletonTable rows={5} columns={5} label="Loading key activity…" />}
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
                  title="No activity for this key"
                  description="The key has no recorded calls for the selected filters."
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
                  key: 'method',
                  header: 'Method / tool',
                  render: (entry) => (
                    <div className="text-[11px] text-slate-400">
                      <p className="font-mono text-slate-300">{entry.method}</p>
                      <p className="font-mono text-slate-500">{entry.toolId ?? '—'}</p>
                    </div>
                  ),
                },
                {
                  key: 'server',
                  header: 'Server',
                  render: (entry) => (
                    <span className="font-mono text-[11px] text-slate-400">{entry.serverId ?? '—'}</span>
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
                    <dt className="text-slate-500">Entry id</dt>
                    <dd className="font-mono text-slate-300">{entry.id}</dd>
                    <dt className="text-slate-500">Request id</dt>
                    <dd className="font-mono text-slate-300">{entry.requestId ?? '—'}</dd>
                    <dt className="text-slate-500">Error code</dt>
                    <dd className="font-mono text-slate-300">{entry.errorCode ?? '—'}</dd>
                    <dt className="text-slate-500">Timestamp</dt>
                    <dd className="font-mono text-slate-300">{entry.ts}</dd>
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
              {preset === 'failed' ? (
                <span className="text-[11px] text-slate-500">Merged view — refine filters for pagination</span>
              ) : (
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
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
