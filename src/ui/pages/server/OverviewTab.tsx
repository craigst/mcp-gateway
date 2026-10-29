import type { ReactNode } from 'react';
import { Card } from '../../components/Card.js';
import { Badge, badgeToneForStatus } from '../../components/Badge.js';
import { StatTile } from '../../components/StatTile.js';
import { JsonViewer } from '../../components/JsonViewer.js';
import { Notice } from '../../components/States.js';
import { GhostButton, PrimaryButton } from '../../components/Form.js';
import { formatDuration, formatTimestamp } from '../../lib/format.js';
import { safeExternalUrl, shortCommit } from './shared.js';
import type { ServerInspectorOverview, UpdateCheckResult } from '../../../core/types.js';

export interface OverviewTabProps {
  data: ServerInspectorOverview;
  checking: boolean;
  checkResult: UpdateCheckResult | null;
  onCheck: () => void;
  onUpdate: () => void;
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words text-xs text-slate-300">{children}</dd>
    </div>
  );
}

/** Overview tab: server/process facts, usage counts, update source and manifest data. */
export function OverviewTab({ data, checking, checkResult, onCheck, onUpdate }: OverviewTabProps) {
  const { server, source, stats } = data;
  const updateAvailable = checkResult !== null ? checkResult.updateAvailable : source?.updateAvailable === true;
  const changelog = safeExternalUrl(source?.changelogUrl ?? null);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Status"
          value={<Badge tone={badgeToneForStatus(server.status)}>{server.status}</Badge>}
          hint={`${server.runtime} · ${server.transport}`}
        />
        <StatTile
          label="Tools / prompts / resources"
          value={`${data.tools.length} / ${data.prompts.length} / ${data.resources.length}`}
          hint="advertised by the sub-server"
          tone="info"
        />
        <StatTile
          label="Requests recorded"
          value={stats.total}
          hint={`${stats.ok} ok · ${stats.error} error · ${stats.denied} denied`}
          tone={stats.error > 0 || stats.denied > 0 ? 'warning' : 'success'}
        />
        <StatTile
          label="Latency"
          value={formatDuration(stats.avgLatencyMs)}
          hint={`p50 ${formatDuration(stats.p50LatencyMs)} · p95 ${formatDuration(stats.p95LatencyMs)}`}
        />
        <StatTile
          label="Last used"
          value={stats.lastUsedAt === null ? 'never' : formatTimestamp(stats.lastUsedAt)}
          hint={`${stats.distinctKeys} distinct key${stats.distinctKeys === 1 ? '' : 's'}`}
        />
        <StatTile label="Registered" value={formatTimestamp(server.createdAt)} />
        <StatTile label="Updated" value={formatTimestamp(server.updatedAt)} />
        <StatTile
          label="PID"
          value={server.pid ?? '—'}
          hint={server.workDir ?? 'no work dir'}
        />
      </div>

      <Card
        title="Source & updates"
        subtitle={
          source === null
            ? 'No tracked upstream repository (locally registered or harness-imported).'
            : source.repoUrl ?? 'tracked upstream'
        }
        actions={
          <>
            <GhostButton onClick={onCheck} disabled={checking || source === null}>
              {checking ? 'Checking…' : 'Check now'}
            </GhostButton>
            <PrimaryButton
              onClick={onUpdate}
              disabled={!updateAvailable}
              className="px-3 py-1.5 text-xs"
            >
              Update now
            </PrimaryButton>
          </>
        }
      >
        {source === null ? (
          <p className="text-xs text-slate-500">
            Install this server from a catalog or Git URL to enable version tracking and one-click updates.
          </p>
        ) : (
          <div className="space-y-3">
            <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <InfoRow label="Repository">
                <span className="break-all font-mono text-[11px]" title={source.repoUrl ?? ''}>
                  {source.repoUrl ?? '—'}
                </span>
              </InfoRow>
              <InfoRow label="Requested ref">{source.requestedRef ?? '—'}</InfoRow>
              <InfoRow label="Update status">
                <span className="flex flex-wrap items-center gap-1.5">
                  {source.checkError !== null ? (
                    <Badge tone="danger">error</Badge>
                  ) : updateAvailable ? (
                    <Badge tone="warning">update available</Badge>
                  ) : (
                    <Badge tone="success">up to date</Badge>
                  )}
                  {changelog !== null && (
                    <a
                      href={changelog}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] font-semibold text-sky-300 underline-offset-2 hover:underline"
                    >
                      Changelog ↗
                    </a>
                  )}
                </span>
              </InfoRow>
              <InfoRow label="Installed version">
                {source.installedVersion === null ? '—' : `v${source.installedVersion}`}
              </InfoRow>
              <InfoRow label="Latest version">
                {source.latestVersion === null ? '—' : `v${source.latestVersion}`}
              </InfoRow>
              <InfoRow label="Last checked">
                {source.checkedAt === null ? 'never' : formatTimestamp(source.checkedAt)}
              </InfoRow>
              <InfoRow label="Installed commit">
                <span className="font-mono text-[11px]">{shortCommit(source.installedCommit)}</span>
              </InfoRow>
              <InfoRow label="Latest commit">
                <span className="font-mono text-[11px]">{shortCommit(source.latestCommit)}</span>
              </InfoRow>
              <InfoRow label="Latest ref">{source.latestRef ?? '—'}</InfoRow>
            </dl>
            {source.checkError !== null && (
              <Notice tone="error" title="Last update check failed">
                {source.checkError}
              </Notice>
            )}
            {checkResult !== null && (
              <p className="text-[11px] text-slate-500">
                Latest check: <span className="font-mono text-slate-300">{checkResult.status}</span> · v
                {checkResult.fromVersion ?? '—'} → v{checkResult.toVersion ?? '—'} · commits{' '}
                {shortCommit(checkResult.fromCommit)} → {shortCommit(checkResult.toCommit)}
                {checkResult.error !== null ? ` · ${checkResult.error}` : ''}
              </p>
            )}
            {server.envFile !== null && server.envFile !== undefined && (
              <Notice tone="warning" title="Legacy env file">
                This server still reads <code className="font-mono">{server.envFile}</code>. Migrate it to an
                encrypted configuration profile from the Configuration tab.
              </Notice>
            )}
          </div>
        )}
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Manifest" subtitle="mcp-manifest.json as registered by the gateway">
          <JsonViewer value={server.manifest} emptyLabel="No manifest (locally registered)" maxHeight="18rem" />
        </Card>
        <Card title="Capabilities" subtitle="MCP capabilities advertised during initialize">
          <JsonViewer
            value={server.capabilities ?? {}}
            emptyLabel="No capabilities recorded"
            maxHeight="18rem"
          />
        </Card>
      </div>

      <Card title="Instructions" subtitle="Optional guidance returned by the sub-server during initialize">
        {server.instructions === null || server.instructions === undefined || server.instructions.trim() === '' ? (
          <p className="text-xs text-slate-500">This server does not advertise any instructions.</p>
        ) : (
          <pre className="whitespace-pre-wrap break-words rounded-lg border border-slate-800 bg-slate-950/80 p-3 font-mono text-[11.5px] leading-relaxed text-slate-300">
            {server.instructions}
          </pre>
        )}
      </Card>
    </div>
  );
}
