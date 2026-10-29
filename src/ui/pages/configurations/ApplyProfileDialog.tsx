import { useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { formatDuration, formatTimestamp } from '../../lib/format.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Badge } from '../../components/Badge.js';
import { Notice } from '../../components/States.js';
import { CheckboxField } from '../../components/Form.js';
import { useToast } from '../../components/Toasts.js';
import type {
  ConfigProfileApplyResult,
  ConfigProfileSummary,
  ServerRecord,
} from '../../../core/types.js';

export interface ApplyProfileDialogProps {
  profile: ConfigProfileSummary;
  servers: readonly ServerRecord[];
  onClose: () => void;
  onApplied: (results: ConfigProfileApplyResult[]) => void;
}

/**
 * Attach a configuration profile to one or more servers, optionally restarting
 * and probe-testing each one. Shows a per-server result list.
 */
export function ApplyProfileDialog({ profile, servers, onClose, onApplied }: ApplyProfileDialogProps) {
  const toast = useToast();
  const [selected, setSelected] = useState<string[]>(() =>
    servers.filter((server) => profile.attachedServerIds.includes(server.id)).map((server) => server.id),
  );
  const [restart, setRestart] = useState(true);
  const [test, setTest] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ConfigProfileApplyResult[] | null>(null);

  const toggleServer = (serverId: string): void => {
    setSelected((previous) =>
      previous.includes(serverId) ? previous.filter((id) => id !== serverId) : [...previous, serverId],
    );
  };

  const submit = async (): Promise<void> => {
    setError(null);
    if (selected.length === 0) {
      setError('Select at least one server.');
      return;
    }
    setBusy(true);
    try {
      const applied = await api.applyConfigProfile(profile.id, { serverIds: selected, restart, test });
      setResults(applied);
      onApplied(applied);
      const ok = applied.filter((result) => result.applied).length;
      toast('success', `Attached “${profile.name}” to ${ok} server${ok === 1 ? '' : 's'}.`);
    } catch (applyError) {
      setError(formatApiError(applyError));
    } finally {
      setBusy(false);
    }
  };

  const done = results !== null;

  return (
    <ConfirmDialog
      open
      title={`Apply “${profile.name}”`}
      description="Attach this encrypted profile to MCP servers. Values are resolved from the gateway vault at start."
      size="lg"
      confirmLabel={done ? 'Done' : 'Apply profile'}
      busy={busy}
      confirmDisabled={!done && selected.length === 0}
      onConfirm={() => {
        if (done) onClose();
        else void submit();
      }}
      onCancel={onClose}
    >
      {done ? (
        <div className="space-y-3">
          <Notice tone="success" title="Profile applied">
            Each server re-read the profile on its next start. Results below show what the gateway did.
          </Notice>
          <ul className="space-y-2">
            {results.map((result) => (
              <li
                key={result.serverId}
                className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-200">{result.serverName}</p>
                    <p className="font-mono text-[10px] text-slate-500">{result.serverId}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={result.applied ? 'success' : 'danger'}>
                      {result.applied ? 'attached' : 'failed'}
                    </Badge>
                    {result.restarted && <Badge tone="info">restarted</Badge>}
                    {result.test !== null && (
                      <Badge tone={result.test.ok ? 'success' : 'danger'}>
                        {result.test.ok ? `${result.test.toolCount} tools` : 'probe failed'}
                      </Badge>
                    )}
                  </div>
                </div>
                {result.test !== null && result.test.ok && (
                  <p className="mt-1 text-[11px] text-slate-500">
                    probe {formatDuration(result.test.latencyMs)} ·{' '}
                    {result.test.tools.slice(0, 4).join(', ')}
                    {result.test.tools.length > 4 ? '…' : ''}
                  </p>
                )}
                {result.test?.error !== null && result.test?.error !== undefined && (
                  <p className="mt-1 text-[11px] text-rose-300">{result.test.error}</p>
                )}
                {result.error !== null && <p className="mt-1 text-[11px] text-rose-300">{result.error}</p>}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Target servers</p>
            {servers.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-800 px-3 py-2.5 text-[11px] text-slate-500">
                No MCP servers are registered yet.
              </p>
            ) : (
              <ul className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/40 p-2">
                {servers.map((server) => (
                  <li key={server.id} className="rounded-md px-1.5 py-1 hover:bg-slate-900/60">
                    <CheckboxField
                      label={
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium text-slate-200">{server.name}</span>
                          <span className="font-mono text-[10px] text-slate-500">{server.id}</span>
                          <Badge tone={server.status === 'running' ? 'success' : 'neutral'}>{server.status}</Badge>
                          {profile.attachedServerIds.includes(server.id) && (
                            <Badge tone="info">attached</Badge>
                          )}
                        </span>
                      }
                      checked={selected.includes(server.id)}
                      onChange={() => toggleServer(server.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-1.5">
            <CheckboxField
              label="Restart attached servers so the profile takes effect immediately"
              checked={restart}
              onChange={setRestart}
            />
            <CheckboxField
              label="Run an activation test and report tool counts"
              checked={test}
              onChange={setTest}
            />
          </div>

          <p className="text-[11px] text-slate-500">
            Values are injected into the sub-process environment/headers at start; they never appear in API
            responses.
          </p>

          {error !== null && (
            <Notice tone="error" title="Apply failed" onDismiss={() => setError(null)}>
              {error}
            </Notice>
          )}
        </div>
      )}
      {done && (
        <p className="mt-3 text-[11px] text-slate-500">Applied {formatTimestamp(new Date().toISOString())}</p>
      )}
    </ConfirmDialog>
  );
}
