import { useState } from 'react';
import { api } from '../lib/api.js';
import { useAsyncData } from '../lib/hooks.js';
import { formatDuration, formatNumber, formatTimestamp } from '../lib/format.js';
import { Card } from '../components/Card.js';
import { Badge, badgeToneForStatus } from '../components/Badge.js';
import { JsonViewer } from '../components/JsonViewer.js';
import { Table } from '../components/Table.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState, LoadingState } from '../components/States.js';
import {
  Field,
  GhostButton,
  PrimaryButton,
  Select,
  TextInput,
} from '../components/Form.js';
import type { AuditEntry, AuditStatus, KeySummary, ServerRecord } from '../../core/types.js';
import type { AuditFilters } from '../lib/api.js';

type StatusPreset = 'all' | 'failed' | 'denied' | 'ok';

const PRESETS: readonly { value: StatusPreset; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'failed', label: 'Failed' },
  { value: 'denied', label: 'Denied' },
  { value: 'ok', label: 'OK' },
];

export interface AuditPageProps {
  /** Navigate to the full server inspector (`#/server/<id>`). */
  onOpenServer?: (serverId: string) => void;
}

const PAGE_SIZE = 50;
const STATUS_OPTIONS: readonly AuditStatus[] = ['ok', 'error', 'denied'];

interface FilterDraft {
  keyId: string;
  serverId: string;
  toolId: string;
  method: string;
  status: '' | AuditStatus;
  search: string;
  since: string;
  until: string;
}

const EMPTY_DRAFT: FilterDraft = {
  keyId: '',
  serverId: '',
  toolId: '',
  method: '',
  status: '',
  search: '',
  since: '',
  until: '',
};

function toIso(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function draftToQuery(draft: FilterDraft, offset: number): AuditFilters {
  return {
    limit: PAGE_SIZE,
    offset,
    keyId: draft.keyId.trim() === '' ? undefined : draft.keyId,
    serverId: draft.serverId.trim() === '' ? undefined : draft.serverId,
    toolId: draft.toolId.trim() === '' ? undefined : draft.toolId,
    method: draft.method.trim() === '' ? undefined : draft.method.trim(),
    status: draft.status === '' ? undefined : draft.status,
    search: draft.search.trim() === '' ? undefined : draft.search.trim(),
    since: toIso(draft.since),
    until: toIso(draft.until),
  };
}

/** Audit log explorer: server-side filtered search with expandable payloads. */
export function AuditPage({ onOpenServer }: AuditPageProps) {
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_DRAFT);
  const [query, setQuery] = useState<AuditFilters>({ limit: PAGE_SIZE, offset: 0 });
  const [preset, setPreset] = useState<StatusPreset>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const audit = useAsyncData(async () => {
    if (preset === 'failed') {
      // "Failed" = denials + errors; the audit API accepts a single status, so
      // merge the two latest slices and report the combined total.
      const [errors, denied] = await Promise.all([
        api.queryAudit({ ...query, status: 'error', offset: 0 }),
        api.queryAudit({ ...query, status: 'denied', offset: 0 }),
      ]);
      const merged = new Map<number, AuditEntry>();
      for (const entry of [...errors.entries, ...denied.entries]) merged.set(entry.id, entry);
      return {
        entries: [...merged.values()]
          .sort((left, right) => right.ts.localeCompare(left.ts))
          .slice(0, PAGE_SIZE),
        total: errors.total + denied.total,
      };
    }
    return api.queryAudit({ ...query, ...(preset === 'all' ? {} : { status: preset }) });
  }, [query, preset]);
  const keys = useAsyncData(() => api.listKeys(), []);
  const servers = useAsyncData(() => api.listServers(), []);

  const entries: AuditEntry[] = audit.status === 'ready' ? audit.data.entries : [];
  const total = audit.status === 'ready' ? audit.data.total : 0;
  const offset = query.offset ?? 0;
  const keyList: KeySummary[] = keys.status === 'ready' ? keys.data : [];
  const serverList: ServerRecord[] = servers.status === 'ready' ? servers.data : [];

  const applyFilters = (): void => {
    setExpandedId(null);
    setPreset('all');
    setQuery(draftToQuery(draft, 0));
  };

  const resetFilters = (): void => {
    setDraft(EMPTY_DRAFT);
    setPreset('all');
    setExpandedId(null);
    setQuery({ limit: PAGE_SIZE, offset: 0 });
  };

  const selectPreset = (next: StatusPreset): void => {
    setPreset(next);
    setExpandedId(null);
    setQuery((previous) => ({ ...previous, offset: 0 }));
  };

  const goToOffset = (nextOffset: number): void => {
    setExpandedId(null);
    setQuery((previous) => ({ ...previous, offset: nextOffset }));
  };

  const updateDraft = <K extends keyof FilterDraft>(key: K, value: FilterDraft[K]): void => {
    setDraft((previous) => ({ ...previous, [key]: value }));
  };

  return (
    <div className="space-y-4">
      <Card title="Filters" subtitle="GET /mcp/v1/admin/audit — key, server, tool, method, status, full-text search">
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Quick status
          </span>
          {PRESETS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => selectPreset(option.value)}
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
          {preset === 'failed' && (
            <span className="text-[11px] text-slate-500">denied + errors, newest first</span>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Key">
            <Select value={draft.keyId} onChange={(event) => updateDraft('keyId', event.target.value)}>
              <option value="">any key</option>
              {keyList.map((key) => (
                <option key={key.id} value={key.id}>
                  {key.name} ({key.keyType})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Server">
            <Select value={draft.serverId} onChange={(event) => updateDraft('serverId', event.target.value)}>
              <option value="">any server</option>
              {serverList.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tool id">
            <TextInput
              value={draft.toolId}
              onChange={(event) => updateDraft('toolId', event.target.value)}
              placeholder="postgres-mcp-v1:postgres_read_query"
            />
          </Field>
          <Field label="Method">
            <TextInput
              value={draft.method}
              onChange={(event) => updateDraft('method', event.target.value)}
              placeholder="tools/call"
            />
          </Field>
          <Field label="Status">
            <Select
              value={draft.status}
              onChange={(event) => updateDraft('status', event.target.value as '' | AuditStatus)}
            >
              <option value="">any status</option>
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Search" hint="matches JSON-RPC payloads and messages">
            <TextInput
              value={draft.search}
              onChange={(event) => updateDraft('search', event.target.value)}
              placeholder="DROP TABLE"
            />
          </Field>
          <Field label="Since">
            <TextInput
              type="datetime-local"
              value={draft.since}
              onChange={(event) => updateDraft('since', event.target.value)}
            />
          </Field>
          <Field label="Until">
            <TextInput
              type="datetime-local"
              value={draft.until}
              onChange={(event) => updateDraft('until', event.target.value)}
            />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <PrimaryButton onClick={applyFilters}>Apply filters</PrimaryButton>
          <GhostButton onClick={resetFilters}>Reset</GhostButton>
          {draft.serverId !== '' && onOpenServer !== undefined && (
            <GhostButton onClick={() => onOpenServer(draft.serverId)}>Open server inspector →</GhostButton>
          )}
          <span className="text-xs text-slate-500">
            {audit.status === 'ready' ? `${formatNumber(total)} matching entries` : 'Querying…'}
          </span>
        </div>
      </Card>

      <Card
        title="Audit entries"
        subtitle="Click a row to inspect the recorded payload"
        actions={
          <GhostButton onClick={audit.reload}>Refresh</GhostButton>
        }
        padded={false}
      >
        {audit.status === 'loading' && <LoadingState label="Querying audit log…" />}
        {audit.status === 'error' && (
          <div className="p-4">
            <ErrorState message={audit.error} onRetry={audit.reload} />
          </div>
        )}
        {audit.status === 'ready' && (
          <>
            <Table<AuditEntry>
              rows={entries}
              getRowKey={(entry) => String(entry.id)}
              expandedKey={expandedId}
              onRowClick={(entry) => setExpandedId((current) => (current === String(entry.id) ? null : String(entry.id)))}
              empty={<EmptyState title="No audit entries match" description="Loosen the filters or reset them." />}
              columns={[
                {
                  key: 'ts',
                  header: 'Timestamp',
                  render: (entry) => <span className="text-xs text-slate-400">{formatTimestamp(entry.ts)}</span>,
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (entry) => <Badge tone={badgeToneForStatus(entry.status)}>{entry.status}</Badge>,
                },
                {
                  key: 'method',
                  header: 'Method',
                  render: (entry) => <span className="font-mono text-xs text-slate-200">{entry.method}</span>,
                },
                {
                  key: 'key',
                  header: 'Key',
                  render: (entry) => (
                    <span className="font-mono text-[11px] text-slate-400">{entry.keyId ?? '—'}</span>
                  ),
                },
                {
                  key: 'server',
                  header: 'Server / tool',
                  render: (entry) => (
                    <div className="text-[11px] text-slate-400">
                      {entry.serverId === null ? (
                        <p>—</p>
                      ) : onOpenServer === undefined ? (
                        <p>{entry.serverId}</p>
                      ) : (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenServer(entry.serverId as string);
                          }}
                          className="underline-offset-2 transition-colors hover:text-sky-300 hover:underline"
                          title="Open this server's inspector"
                        >
                          {entry.serverId}
                        </button>
                      )}
                      <p className="font-mono text-slate-500">{entry.toolId ?? ''}</p>
                    </div>
                  ),
                },
                {
                  key: 'latency',
                  header: 'Latency',
                  render: (entry) => (
                    <span className="tabular-nums text-xs text-slate-400">{formatDuration(entry.latencyMs)}</span>
                  ),
                },
                {
                  key: 'error',
                  header: 'Error',
                  render: (entry) => (
                    <span className="font-mono text-xs text-rose-400">{entry.errorCode ?? '—'}</span>
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
                    <dt className="text-slate-500">Delegation depth</dt>
                    <dd className="text-slate-300">{entry.delegationDepth}</dd>
                    <dt className="text-slate-500">Parent id</dt>
                    <dd className="font-mono text-slate-300">{entry.parentId ?? '—'}</dd>
                    <dt className="text-slate-500">Error code</dt>
                    <dd className="font-mono text-slate-300">{entry.errorCode ?? '—'}</dd>
                    <dt className="text-slate-500">Timestamp</dt>
                    <dd className="font-mono text-slate-300">{entry.ts}</dd>
                  </dl>
                  <div>
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      Payload
                    </p>
                    <JsonViewer value={entry.payload} maxHeight="16rem" />
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
                  <GhostButton
                    onClick={() => goToOffset(Math.max(0, offset - PAGE_SIZE))}
                    disabled={offset === 0}
                  >
                    Previous
                  </GhostButton>
                  <GhostButton
                    onClick={() => goToOffset(offset + PAGE_SIZE)}
                    disabled={offset + entries.length >= total}
                  >
                    Next
                  </GhostButton>
                </div>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
