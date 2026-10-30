import type { ReactNode } from 'react';
import { Badge } from '../../components/Badge.js';
import { Card } from '../../components/Card.js';
import { ErrorState, LoadingState, Notice } from '../../components/States.js';
import { formatTimestamp } from '../../lib/format.js';
import { cx } from '../../lib/cx.js';
import type { ComputerUseConnectorsResponse } from '../../../core/types.js';
import { safeExternalUrl } from './shared.js';

export interface BrokerStatusCardProps {
  data: ComputerUseConnectorsResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

function StatusRow({
  label,
  children,
  title,
}: {
  label: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words text-[12px] text-slate-300" title={title}>
        {children}
      </dd>
    </div>
  );
}

/**
 * Broker connectivity summary for pairing: whether it is configured and
 * reachable, its version/TLS mode and the device + pending counts. Nothing
 * here mutates broker state; an unreachable broker just explains itself.
 */
export function BrokerStatusCard({ data, loading, error, onRetry }: BrokerStatusCardProps) {
  let body: ReactNode;
  if (data === null) {
    body = loading ? (
      <LoadingState label="Checking the Computer Broker…" />
    ) : error !== null ? (
      <ErrorState message={error} onRetry={onRetry} />
    ) : null;
  } else {
    const broker = data.broker;
    const publicUrl = safeExternalUrl(data.publicBrokerUrl);
    const counts = data.counts;
    body = (
      <div className="space-y-3">
        {!broker.reachable && (
          <Notice tone="error" title="Broker unreachable">
            {broker.error !== null && broker.error.trim() !== ''
              ? broker.error
              : 'The gateway cannot reach the Computer Broker. Pairing commands and terminal access are unavailable until it reconnects.'}
          </Notice>
        )}
        <dl className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
          <StatusRow label="Configured">
            <Badge tone={broker.configured ? 'success' : 'neutral'}>
              {broker.configured ? 'yes' : 'no'}
            </Badge>
          </StatusRow>
          <StatusRow label="Reachable">
            <Badge tone={broker.reachable ? 'success' : 'danger'}>
              {broker.reachable ? 'connected' : 'offline'}
            </Badge>
          </StatusRow>
          <StatusRow label="Version">{broker.version ?? '—'}</StatusRow>
          <StatusRow label="TLS">
            <Badge tone={broker.tls ? 'success' : 'warning'}>{broker.tls ? 'https' : 'plain http'}</Badge>
          </StatusRow>
          <StatusRow label="Devices">
            {counts.devices} <span className="text-slate-500">· {counts.online} online</span>
          </StatusRow>
          <StatusRow label="Pending pairings">{counts.pendingEnrollments}</StatusRow>
          <StatusRow label="Broker URL" title={broker.url ?? undefined}>
            <span className="font-mono text-[11px]">{broker.url ?? 'not configured'}</span>
          </StatusRow>
          <StatusRow label="Public broker URL" title={data.publicBrokerUrl ?? undefined}>
            {publicUrl !== null ? (
              <a
                href={publicUrl}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[11px] text-sky-300 underline decoration-sky-800 underline-offset-2 hover:text-sky-200"
              >
                {data.publicBrokerUrl}
              </a>
            ) : (
              <span className="text-amber-300/90">not set — pairing is blocked</span>
            )}
          </StatusRow>
        </dl>
        <p className="text-[11px] text-slate-500">
          {broker.checkedAt !== null
            ? `Last checked ${formatTimestamp(broker.checkedAt)}.`
            : 'Health has not been checked yet.'}{' '}
          Device connectors connect out to the broker; the console never dials a PC directly.
        </p>
        {error !== null && (
          <Notice tone="warning" title="Broker status may be stale">
            <span className={cx('text-[11px]')}>{error}</span>
          </Notice>
        )}
      </div>
    );
  }

  return (
    <Card
      title="Broker status"
      subtitle="Linux PCs connect out to the Computer Broker; this console only talks to the broker."
    >
      {body}
    </Card>
  );
}
