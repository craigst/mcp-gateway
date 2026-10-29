import type { ReactNode } from 'react';
import { Card } from '../../components/Card.js';
import { Badge, badgeToneForStatus } from '../../components/Badge.js';
import { ErrorState, LoadingState, Notice } from '../../components/States.js';
import { PrimaryButton, SecondaryButton } from '../../components/Form.js';
import { formatNumber, formatTimestamp } from '../../lib/format.js';
import { safeExternalUrl } from '../server/shared.js';
import type { ComputerUseOverview } from '../../../core/types.js';

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words text-xs text-slate-300">{children}</dd>
    </div>
  );
}

function mono(value: string | null): ReactNode {
  if (value === null || value.trim() === '') return '—';
  return <span className="break-all font-mono text-[11px]">{value}</span>;
}

export interface BrokerCardProps {
  overview: ComputerUseOverview | null;
  loading: boolean;
  error: string | null;
  onOpenSettings: () => void;
  onRetry: () => void;
}

/** Connection health for the external Computer Broker service. */
export function BrokerCard({ overview, loading, error, onOpenSettings, onRetry }: BrokerCardProps) {
  if (overview === null) {
    return (
      <Card title="Computer Broker" subtitle="External broker that hosts the agent desktops">
        {loading && <LoadingState label="Checking the broker…" />}
        {!loading && error !== null && <ErrorState message={error} onRetry={onRetry} />}
      </Card>
    );
  }

  const { broker, settings } = overview;
  const status = !broker.configured
    ? { tone: 'neutral' as const, label: 'not configured' }
    : broker.reachable
      ? { tone: 'success' as const, label: 'online' }
      : { tone: 'danger' as const, label: 'offline' };
  const dashboardUrl = safeExternalUrl(settings.publicBrokerUrl);

  return (
    <Card
      title="Computer Broker"
      subtitle="External broker that hosts the agent desktops"
      className={broker.configured && !broker.reachable ? 'border-rose-900/70 bg-rose-950/10' : undefined}
      actions={
        broker.configured ? (
          <SecondaryButton onClick={onOpenSettings} className="px-3 py-1.5 text-xs">
            Settings
          </SecondaryButton>
        ) : undefined
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={status.tone}>{status.label}</Badge>
          {broker.version !== null && <Badge tone="info">v{broker.version}</Badge>}
          <Badge tone={broker.tls ? 'success' : 'neutral'}>{broker.tls ? 'TLS' : 'plain HTTP'}</Badge>
          <Badge tone={settings.enabled ? 'success' : 'warning'}>
            integration {settings.enabled ? 'enabled' : 'disabled'}
          </Badge>
        </div>

        {!broker.configured ? (
          <div className="space-y-3">
            <Notice tone="warning" title="Computer Broker not configured">
              Set your self-hosted broker URL below to register the managed <code>computer-use</code> MCP
              server. The gateway proxies its desktop tools and keeps the broker token server-side.
            </Notice>
            <PrimaryButton onClick={onOpenSettings} className="px-3 py-1.5 text-xs">
              Configure broker
            </PrimaryButton>
            <p className="text-[11px] text-slate-500">
              You can also set <code className="font-mono">MCP_COMPUTER_BROKER_URL</code> on the gateway
              container and restart it.
            </p>
          </div>
        ) : (
          <>
            <dl className="grid gap-3 sm:grid-cols-2">
              <InfoRow label="Endpoint">{mono(broker.url)}</InfoRow>
              <InfoRow label="Last checked">
                {broker.checkedAt === null ? 'not yet' : formatTimestamp(broker.checkedAt)}
              </InfoRow>
              <InfoRow label="Computers">{broker.computers ?? '—'}</InfoRow>
              <InfoRow label="Devices">{broker.devices ?? '—'}</InfoRow>
              <InfoRow label="Connectors online">{broker.connectorsOnline ?? '—'}</InfoRow>
              <InfoRow label="Broker token">
                <Badge tone={settings.tokenConfigured ? 'success' : 'warning'}>
                  {settings.tokenConfigured
                    ? `configured${settings.tokenSource === null ? '' : ` (${settings.tokenSource})`}`
                    : 'not set'}
                </Badge>
              </InfoRow>
            </dl>
            {broker.error !== null && (
              <Notice tone="error" title="Broker unreachable">
                {broker.error}
              </Notice>
            )}
            {dashboardUrl !== null && (
              <a
                href={dashboardUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-[11px] font-semibold text-sky-300 underline-offset-2 hover:underline"
              >
                Open the broker UI in a new tab ↗
              </a>
            )}
          </>
        )}

        {error !== null && (
          <Notice tone="warning" title="Broker status may be stale">
            {error}
          </Notice>
        )}
      </div>
    </Card>
  );
}

export interface ManagedServerCardProps {
  overview: ComputerUseOverview | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

/** The managed `computer-use` MCP server the gateway registers for the broker. */
export function ManagedServerCard({ overview, loading, error, onRetry }: ManagedServerCardProps) {
  if (overview === null) {
    return (
      <Card title="Managed MCP server" subtitle="computer-use server exposed to agents">
        {loading && <LoadingState label="Loading the managed server…" />}
        {!loading && error !== null && <ErrorState message={error} onRetry={onRetry} />}
      </Card>
    );
  }

  const { server } = overview;

  return (
    <Card
      title="Managed MCP server"
      subtitle="computer-use server exposed to agents through JSON-RPC"
      actions={
        server.id !== null ? (
          <a
            href={`#/server/${encodeURIComponent(server.id)}`}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800"
          >
            Open server inspector →
          </a>
        ) : undefined
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={badgeToneForStatus(server.status === 'absent' ? 'stopped' : server.status)}>
            {server.status}
          </Badge>
          <Badge tone="neutral">{formatNumber(server.toolCount)} tool{server.toolCount === 1 ? '' : 's'}</Badge>
          <span className="font-mono text-[11px] text-slate-500">{server.name}</span>
        </div>

        {server.id === null || server.status === 'absent' ? (
          <Notice tone="info" title="Managed server not registered">
            The gateway registers <code className="font-mono">computer-use</code> once a broker URL is
            configured. Sync the broker after saving settings to create it.
          </Notice>
        ) : (
          <p className="text-[11px] text-slate-500">
            Server id <span className="font-mono text-slate-400">{server.id}</span>. Paused availability is
            enforced by the gateway router before any broker call is forwarded.
          </p>
        )}

        {server.status === 'failed' && (
          <Notice tone="error" title="Managed server failed to start">
            {server.lastError ?? 'No error detail was recorded.'}
          </Notice>
        )}

        {server.status !== 'failed' && server.lastError !== null && (
          <Notice tone="warning" title="Last server error">
            {server.lastError}
          </Notice>
        )}

        {server.status === 'running' && (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
            <Badge tone="success">ready for agent calls</Badge>
          </div>
        )}

        {error !== null && (
          <Notice tone="warning" title="Server status may be stale">
            {error}
          </Notice>
        )}
      </div>
    </Card>
  );
}
