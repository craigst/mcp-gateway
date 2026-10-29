import { useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Badge } from '../../components/Badge.js';
import { Notice } from '../../components/States.js';
import { CheckboxField } from '../../components/Form.js';
import { useToast } from '../../components/Toasts.js';
import { formatLatency } from './shared.js';
import type { ServerRecord, ServerSourceInfo, ServerUpdateResult } from '../../../core/types.js';

function shortCommit(commit: string | null | undefined): string {
  if (commit === null || commit === undefined || commit.trim() === '') return '—';
  return commit.slice(0, 7);
}

function safeUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export interface UpdateDialogProps {
  server: ServerRecord;
  source: ServerSourceInfo | null;
  onClose: () => void;
  onUpdated: (result: ServerUpdateResult) => void;
}

/**
 * Confirm + progress dialog for rebuilding one tracked server from upstream.
 * Shared by the Installed table and the server Details drawer.
 */
export function UpdateDialog({ server, source, onClose, onUpdated }: UpdateDialogProps) {
  const toast = useToast();
  const [phase, setPhase] = useState<'form' | 'running' | 'done'>('form');
  const [restart, setRestart] = useState(true);
  const [test, setTest] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ServerUpdateResult | null>(null);

  const fromVersion = source?.installedVersion ?? server.manifest?.version ?? null;
  const toVersion = source?.latestVersion ?? source?.latestRef ?? null;
  const changelog = safeUrl(source?.changelogUrl);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setPhase('running');
    try {
      const updated = await api.updateServer(server.id, { restart, test });
      setResult(updated);
      setPhase('done');
      onUpdated(updated);
      toast(
        'success',
        updated.changed
          ? `“${server.name}” updated${updated.after.version ? ` to v${updated.after.version}` : ''}.`
          : `“${server.name}” is already up to date.`,
      );
    } catch (updateError) {
      setError(formatApiError(updateError));
      setPhase('form');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open
      title={`Update “${server.name}”`}
      description="Rebuild this sub-server from its tracked upstream repository and re-register it."
      size="lg"
      confirmLabel={phase === 'done' ? 'Done' : 'Update now'}
      busy={busy}
      onConfirm={() => {
        if (phase === 'done') onClose();
        else void submit();
      }}
      onCancel={onClose}
    >
      {phase === 'done' && result !== null ? (
        <div className="space-y-3">
          <Notice
            tone={result.changed ? 'success' : 'info'}
            title={result.changed ? 'Update complete' : 'Already up to date'}
          >
            {result.changed
              ? `Rebuilt and re-registered “${result.server.name}”.`
              : 'The upstream repository has no new commits since the last build.'}
          </Notice>
          <dl className="grid gap-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4 sm:grid-cols-2">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Version</dt>
              <dd className="mt-0.5 text-xs text-slate-300">
                v{result.before.version ?? '—'} → v{result.after.version ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Commit</dt>
              <dd className="mt-0.5 font-mono text-[11px] text-slate-400">
                {shortCommit(result.before.commit)} → {shortCommit(result.after.commit)}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Status</dt>
              <dd className="mt-0.5">
                <Badge tone={result.changed ? 'success' : 'neutral'}>{result.changed ? 'updated' : 'unchanged'}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Activation test</dt>
              <dd className="mt-0.5">
                {result.test === null ? (
                  <span className="text-xs text-slate-500">not run</span>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={result.test.ok ? 'success' : 'danger'}>{result.test.ok ? 'ok' : 'failed'}</Badge>
                    <span className="text-[11px] text-slate-400">
                      {result.test.toolCount} tool{result.test.toolCount === 1 ? '' : 's'} ·{' '}
                      {formatLatency(result.test.latencyMs)}
                    </span>
                    {result.test.error !== null && (
                      <span className="text-[11px] text-rose-300">{result.test.error}</span>
                    )}
                  </div>
                )}
              </dd>
            </div>
          </dl>
        </div>
      ) : phase === 'running' ? (
        <Notice tone="info" title={`Updating “${server.name}”…`}>
          Cloning the latest upstream ref, rebuilding and re-registering the sub-server. This can take a minute or
          two.
        </Notice>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <p className="text-sm font-medium text-slate-200">
              v{fromVersion ?? '—'} <span className="text-slate-500">→</span>{' '}
              <span className="text-sky-300">v{toVersion ?? 'latest'}</span>
            </p>
            <p className="mt-1 font-mono text-[11px] text-slate-500">
              commits {shortCommit(source?.installedCommit)} → {shortCommit(source?.latestCommit)}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {source?.requestedRef !== null && source?.requestedRef !== undefined && (
                <Badge tone="neutral">ref {source.requestedRef}</Badge>
              )}
              {source?.latestRef !== null && source?.latestRef !== undefined && (
                <Badge tone="info">latest {source.latestRef}</Badge>
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
            </div>
          </div>

          <Notice tone="warning">
            The current build is replaced. Keep the restart and probe toggles on unless you plan to restart the
            server manually.
          </Notice>

          <div className="space-y-1.5">
            <CheckboxField label="Restart the server after the rebuild" checked={restart} onChange={setRestart} />
            <CheckboxField
              label="Run an activation test and list tools afterwards"
              checked={test}
              onChange={setTest}
            />
          </div>

          {error !== null && (
            <Notice tone="error" title="Update failed" onDismiss={() => setError(null)}>
              {error}
            </Notice>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}
