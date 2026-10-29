import { api } from '../lib/api.js';
import { useAsyncData } from '../lib/hooks.js';
import { formatBytes, formatDuration, formatNumber, formatPercent, formatTimestamp } from '../lib/format.js';
import { Card } from '../components/Card.js';
import { StatTile } from '../components/StatTile.js';
import { Badge, badgeToneForStatus } from '../components/Badge.js';
import { Table } from '../components/Table.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState, LoadingState } from '../components/States.js';
import { buttonSecondary } from '../components/Form.js';
import type { PageKey } from '../components/Layout.js';
import type { MetricsSnapshot } from '../../core/ports.js';
import type { ServerRecord } from '../../core/types.js';

export interface DashboardPageProps {
  onNavigate?: (page: PageKey) => void;
}

interface RequestBar {
  label: string;
  value: number;
  className: string;
}

/** Overview: live telemetry tiles, request mix, latency percentiles, sub-server status. */
export function DashboardPage({ onNavigate }: DashboardPageProps) {
  const metrics = useAsyncData(() => api.getMetrics(), []);
  const servers = useAsyncData(() => api.listServers(), []);

  const data: MetricsSnapshot | null = metrics.status === 'ready' ? metrics.data : null;
  const serverList: ServerRecord[] = servers.status === 'ready' ? servers.data : [];
  const runningCount = serverList.filter((server) => server.status === 'running').length;

  const refresh = (): void => {
    metrics.reload();
    servers.reload();
  };

  const totalRequests = data?.requests.total ?? 0;
  const requestBars: RequestBar[] = data
    ? [
        { label: 'ok', value: data.requests.ok, className: 'bg-emerald-500' },
        { label: 'denied', value: data.requests.denied, className: 'bg-amber-500' },
        { label: 'error', value: data.requests.error, className: 'bg-rose-500' },
      ]
    : [];

  const latencyBars = data
    ? [
        { label: 'p50', value: data.latencyMs.p50 },
        { label: 'p95', value: data.latencyMs.p95 },
        { label: 'p99', value: data.latencyMs.p99 },
      ]
    : [];
  const maxLatency = Math.max(1, ...latencyBars.map((bar) => bar.value));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-400">
          Live snapshot from <code className="text-slate-300">/mcp/v1/metrics</code>
          {data ? ` · bound ${formatTimestamp(new Date())}` : ''}
        </p>
        <button type="button" onClick={refresh} className={buttonSecondary}>
          Refresh
        </button>
      </div>

      {metrics.status === 'error' && <ErrorState message={metrics.error} onRetry={metrics.reload} />}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Requests / min"
          value={data ? formatNumber(data.requestsPerMinute, 1) : '—'}
          hint={data ? `${formatNumber(data.requests.total)} total requests` : 'Awaiting metrics'}
          tone="info"
        />
        <StatTile
          label="Error rate"
          value={data ? formatPercent(data.errorRate) : '—'}
          hint={data ? `${formatNumber(data.requests.error)} errors · ${formatNumber(data.requests.denied)} denials` : undefined}
          tone={data ? (data.errorRate > 0.05 ? 'danger' : data.errorRate > 0.01 ? 'warning' : 'success') : 'default'}
        />
        <StatTile
          label="P50 latency"
          value={data ? formatDuration(data.latencyMs.p50) : '—'}
          hint={data ? `p95 ${formatDuration(data.latencyMs.p95)} · p99 ${formatDuration(data.latencyMs.p99)}` : undefined}
        />
        <StatTile
          label="Sub-servers"
          value={data ? `${data.servers.running} / ${data.servers.total}` : '—'}
          hint="running / registered"
          tone={data && data.servers.running > 0 ? 'success' : 'warning'}
        />
        <StatTile label="Uptime" value={data ? formatDuration(data.uptimeMs) : '—'} />
        <StatTile
          label="CPU"
          value={data ? `${data.process.cpuPercent.toFixed(1)}%` : '—'}
          hint="gateway process"
        />
        <StatTile
          label="Memory (RSS)"
          value={data ? formatBytes(data.process.rssBytes) : '—'}
          hint={data ? `heap ${formatBytes(data.process.heapUsedBytes)}` : undefined}
        />
        <StatTile
          label="Delegations"
          value={data ? formatNumber(data.delegations.total) : '—'}
          hint={data ? `${data.delegations.approved} approved · ${data.delegations.denied} denied` : undefined}
          tone={data && data.delegations.denied > 0 ? 'warning' : 'default'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Request mix"
          subtitle={data ? `${formatNumber(totalRequests)} JSON-RPC requests processed` : 'Awaiting metrics'}
        >
          {metrics.status === 'loading' && <LoadingState label="Loading metrics…" />}
          {metrics.status === 'error' && <ErrorState message={metrics.error} onRetry={metrics.reload} />}
          {data && (
            <div className="space-y-3">
              {requestBars.map((bar) => {
                const percent = totalRequests > 0 ? (bar.value / totalRequests) * 100 : 0;
                return (
                  <div key={bar.label}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-300">{bar.label}</span>
                      <span className="tabular-nums text-slate-400">
                        {formatNumber(bar.value)} · {percent.toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                      <div className={`h-full rounded-full ${bar.className}`} style={{ width: `${percent}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card title="Latency percentiles" subtitle="Gateway + sub-server round trip">
          {data ? (
            <div className="space-y-3">
              {latencyBars.map((bar) => (
                <div key={bar.label}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-300">{bar.label}</span>
                    <span className="tabular-nums text-slate-400">{formatDuration(bar.value)}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full rounded-full bg-sky-500"
                      style={{ width: `${(bar.value / maxLatency) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <LoadingState label="Loading latency…" />
          )}
        </Card>
      </div>

      <Card
        title="Sub-server status"
        subtitle={`${runningCount} running · ${serverList.length} registered`}
        actions={
          onNavigate !== undefined ? (
            <button type="button" onClick={() => onNavigate('catalog')} className={buttonSecondary}>
              Manage catalog
            </button>
          ) : undefined
        }
        padded={false}
      >
        {servers.status === 'loading' && <LoadingState label="Loading servers…" />}
        {servers.status === 'error' && (
          <div className="p-4">
            <ErrorState message={servers.error} onRetry={servers.reload} />
          </div>
        )}
        {servers.status === 'ready' &&
          (serverList.length === 0 ? (
            <EmptyState
              title="No sub-servers registered"
              description="Register a stdio command or import a repository from the Catalog view."
              action={
                onNavigate !== undefined ? (
                  <button type="button" onClick={() => onNavigate('catalog')} className={buttonSecondary}>
                    Open catalog
                  </button>
                ) : undefined
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
                  render: (server) => <Badge tone={badgeToneForStatus(server.status)}>{server.status}</Badge>,
                },
                {
                  key: 'pid',
                  header: 'PID',
                  render: (server) => <span className="font-mono text-xs text-slate-400">{server.pid ?? '—'}</span>,
                },
                {
                  key: 'updated',
                  header: 'Updated',
                  render: (server) => (
                    <span className="text-xs text-slate-500">{formatTimestamp(server.updatedAt)}</span>
                  ),
                },
              ]}
            />
          ))}
      </Card>
    </div>
  );
}
