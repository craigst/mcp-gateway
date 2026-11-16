import { api } from '../lib/api.js';
import { useAsyncData } from '../lib/hooks.js';
import { activityAction, activityClient, activityServer } from '../lib/activity.js';
import { formatBytes, formatDuration, formatNumber, formatPercent, formatTimestamp } from '../lib/format.js';
import { Badge, badgeToneForStatus } from '../components/Badge.js';
import { ErrorState, LoadingState } from '../components/States.js';
import type { PageKey } from '../components/Layout.js';

export interface DashboardPageProps {
  onNavigate?: (page: PageKey, options?: { catalogTab?: 'installed' | 'discover' | 'sources' | 'import' }) => void;
  onOpenServer?: (id: string) => void;
}

/** A compact overview of real gateway data. More detail stays on the relevant pages. */
export function DashboardPage({ onNavigate, onOpenServer }: DashboardPageProps) {
  const metrics = useAsyncData(() => api.getMetrics(), []);
  const servers = useAsyncData(() => api.listServers(), []);
  const keys = useAsyncData(() => api.listKeys(), []);
  const computers = useAsyncData(() => api.listComputerUseComputers(), []);
  const audit = useAsyncData(() => api.queryAudit({ limit: 50 }), []);
  const serverList = servers.status === 'ready' ? servers.data : [];
  const usefulActivity = audit.status === 'ready' ? audit.data.entries.filter((entry) => entry.method === 'tools/call' || entry.status !== 'ok').slice(0, 5) : [];
  const data = metrics.status === 'ready' ? metrics.data : null;
  const brain = serverList.find((server) => server.name.toLowerCase() === 'brain');

  const openWatcher = (source?: 'whatsapp' | 'instagram') => {
    onNavigate?.('watchers');
    if (source && typeof window !== 'undefined') window.location.hash = `#/watchers?source=${source}`;
  };

  const refresh = () => {
    metrics.reload(); servers.reload(); keys.reload(); computers.reload(); audit.reload();
  };
  const cards = [
    { icon: '▱', title: 'Servers', value: servers.status === 'ready' ? String(serverList.length) : '—', detail: servers.status === 'error' ? 'Unavailable' : 'registered', page: 'catalog' as const },
    { icon: '▣', title: 'Computers', value: computers.status === 'ready' && computers.data.broker.reachable ? String(computers.data.computers.length) : '—', detail: computers.status === 'error' || (computers.status === 'ready' && !computers.data.broker.reachable) ? 'Broker unavailable' : 'reported by broker', page: 'devices' as const },
    { icon: '◇', title: 'Agent keys', value: keys.status === 'ready' ? String(keys.data.filter((key) => key.keyType === 'agent' && !key.revokedAt).length) : '—', detail: keys.status === 'error' ? 'Unavailable' : 'not revoked', page: 'rbac' as const },
    { icon: '▥', title: 'Requests', value: data ? formatNumber(data.requests.total) : '—', detail: 'in the last 5 minutes', page: 'audit' as const },
  ];

  return (
    <div className="overview-shell">
      <div className="overview-heading">
        <div><h2>Gateway overview</h2><p>Everything connected, in one place.</p></div>
        <div className="overview-actions">
          <button type="button" className="overview-subtle" onClick={refresh}>Refresh</button>
          <button type="button" className="overview-primary" onClick={() => onNavigate?.('catalog', { catalogTab: 'import' })}>+ Add server</button>
        </div>
      </div>
      {metrics.status === 'error' && <ErrorState message={metrics.error} onRetry={metrics.reload} />}
      <div className="overview-stats">
        {cards.map((card) => (
          <button className="overview-stat" key={card.title} type="button" onClick={() => onNavigate?.(card.page)}>
            <span className="overview-stat-icon" aria-hidden="true">{card.icon}</span>
            <span><span className="overview-stat-label">{card.title}</span><strong>{card.value}</strong><small>{card.detail}</small></span>
          </button>
        ))}
      </div>
      <div className="overview-grid">
        <section className="overview-panel">
          <div className="overview-panel-header"><h3><span aria-hidden="true">▱</span> Servers</h3><button type="button" onClick={() => onNavigate?.('catalog')}>View all servers →</button></div>
          {servers.status === 'loading' && <LoadingState label="Loading servers…" />}
          {servers.status === 'error' && <ErrorState message={servers.error} onRetry={servers.reload} />}
          {servers.status === 'ready' && (serverList.length === 0 ? <p className="overview-empty">No servers registered yet.</p> : (
            <div className="overview-table-wrap"><table className="overview-table"><thead><tr><th>Server</th><th>Status</th><th>Runtime</th></tr></thead><tbody>
              {serverList.slice(0, 5).map((server) => <tr key={server.id}><td><button type="button" className="overview-row-link" onClick={() => onOpenServer?.(server.id)}>{server.name}</button></td><td><Badge tone={badgeToneForStatus(server.status)}>{server.status}</Badge></td><td>{server.runtime} · {server.transport}</td></tr>)}
            </tbody></table></div>
          ))}
        </section>
        <section className="overview-panel">
          <div className="overview-panel-header"><h3><span aria-hidden="true">⌁</span> Recent activity</h3><button type="button" onClick={() => onNavigate?.('audit')}>View activity →</button></div>
          {audit.status === 'loading' && <LoadingState label="Loading activity…" />}
          {audit.status === 'error' && <ErrorState message={audit.error} onRetry={audit.reload} />}
          {audit.status === 'ready' && (audit.data.entries.length === 0 ? <p className="overview-empty">No recent activity.</p> : usefulActivity.length === 0 ? <p className="overview-empty">No recent tool calls or problems. View activity for connection and discovery events.</p> : <ul className="overview-activity">{usefulActivity.map((entry) => <li key={entry.id}><span className={entry.status === 'ok' ? 'overview-activity-dot' : 'overview-activity-dot is-problem'} aria-hidden="true">{entry.status === 'ok' ? '●' : '◦'}</span><span className="overview-activity-text">{activityClient(entry, keys.status === 'ready' ? keys.data : [])}: {activityAction(entry)}{activityServer(entry, serverList) ? ` · ${activityServer(entry, serverList)}` : ''}<small>{entry.status}</small></span><time>{formatTimestamp(entry.ts)}</time></li>)}</ul>)}
        </section>
      </div>
      <div className="overview-shortcuts">
        <section className="overview-panel overview-shortcut"><div className="overview-panel-header"><h3><span aria-hidden="true">▤</span> Knowledge</h3><button type="button" onClick={() => onNavigate?.('knowledge')}>Manage →</button></div><p>{brain ? 'Search memories and documents from your connected brain servers.' : 'Connect a brain server to search memories and documents.'}</p><button className="overview-chip" type="button" onClick={() => onNavigate?.('knowledge')}>Open knowledge →</button></section>
        <section className="overview-panel overview-shortcut"><div className="overview-panel-header"><h3><span aria-hidden="true">ϟ</span> Social watchers</h3><button type="button" onClick={() => openWatcher()}>Manage →</button></div><p>Choose what reaches your bot from social channels.</p><div className="overview-chip-row"><button className="overview-chip" type="button" onClick={() => openWatcher('whatsapp')}>WhatsApp →</button><button className="overview-chip" type="button" onClick={() => openWatcher('instagram')}>Instagram →</button></div></section>
        <section className="overview-panel overview-shortcut"><div className="overview-panel-header"><h3><span aria-hidden="true">▣</span> Devices &amp; computers</h3><button type="button" onClick={() => onNavigate?.('devices')}>View devices →</button></div><p>Manage computers, connectors and agent access.</p><button className="overview-chip" type="button" onClick={() => onNavigate?.('devices')}>Open devices →</button></section>
      </div>
      <details className="overview-panel overview-performance">
        <summary>Performance details</summary>
        {data ? <div className="overview-performance-grid">
          <span>Requests / min <strong>{formatNumber(data.requestsPerMinute, 1)}</strong></span>
          <span>Error rate <strong>{formatPercent(data.errorRate)}</strong></span>
          <span>Latency p50 / p95 / p99 <strong>{formatDuration(data.latencyMs.p50)} / {formatDuration(data.latencyMs.p95)} / {formatDuration(data.latencyMs.p99)}</strong></span>
          <span>Uptime <strong>{formatDuration(data.uptimeMs)}</strong></span>
          <span>CPU <strong>{data.process.cpuPercent.toFixed(1)}%</strong></span>
          <span>Memory <strong>{formatBytes(data.process.rssBytes)}</strong></span>
          <span>Request mix <strong>{data.requests.ok} ok · {data.requests.denied} denied · {data.requests.error} errors</strong></span>
        </div> : <p className="overview-empty">Metrics are unavailable.</p>}
      </details>
    </div>
  );
}
