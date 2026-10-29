import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { useAsyncData } from '../../lib/hooks.js';
import { formatDuration, formatTimestamp } from '../../lib/format.js';
import { Drawer } from '../../components/Drawer.js';
import { Badge, badgeToneForStatus } from '../../components/Badge.js';
import { ErrorState, Notice } from '../../components/States.js';
import { SkeletonBlock } from '../../components/Skeleton.js';
import { CheckboxField, Field, GhostButton, PrimaryButton, SecondaryButton, TextInput } from '../../components/Form.js';
import { LiveLogPanel } from '../../components/LiveLogPanel.js';
import { useToast } from '../../components/Toasts.js';
import type { InstallTestResult, ServerRecord } from '../../../core/types.js';

export interface ServerDrawerProps {
  server: ServerRecord;
  onClose: () => void;
  onSaved: (server: ServerRecord) => void;
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words text-xs text-slate-300">{children}</dd>
    </div>
  );
}

function truncateMiddle(value: string, max = 52): string {
  if (value.length <= max) return value;
  const head = value.slice(0, Math.floor(max / 2) - 2);
  const tail = value.slice(-Math.floor(max / 2));
  return `${head}…${tail}`;
}

/**
 * Server detail / policy drawer: manifest + process info, per-tool
 * high-privilege and approval-required toggles, env file, activation probe
 * and logs.
 */
export function ServerDrawer({ server, onClose, onSaved }: ServerDrawerProps) {
  const toast = useToast();
  const toolsState = useAsyncData(() => api.serverTools(server.id), [server.id]);
  const logsState = useAsyncData(() => api.serverLogs(server.id, 200), [server.id]);

  const [highPrivilegeTools, setHighPrivilegeTools] = useState<string[]>([]);
  const [approvalRequiredTools, setApprovalRequiredTools] = useState<string[]>([]);
  const [envFile, setEnvFile] = useState(server.envFile ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<InstallTestResult | null>(null);

  useEffect(() => {
    if (toolsState.status !== 'ready') return;
    setHighPrivilegeTools(toolsState.data.highPrivilegeTools);
    setApprovalRequiredTools(toolsState.data.approvalRequiredTools);
    setEnvFile(server.envFile ?? '');
  }, [toolsState.status, toolsState.data, server.envFile]);

  const toggle = (list: string[], setList: (next: string[]) => void, name: string): void => {
    setList(list.includes(name) ? list.filter((entry) => entry !== name) : [...list, name]);
  };

  const savePolicy = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.updateServerPolicy(server.id, {
        highPrivilegeTools,
        approvalRequiredTools,
        envFile: envFile.trim() === '' ? null : envFile.trim(),
      });
      toast('success', `Policy saved for “${updated.name}”.`);
      onSaved(updated);
      toolsState.reload();
    } catch (error) {
      setSaveError(formatApiError(error));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setTestError(null);
    try {
      setTestResult(await api.testServer(server.id));
    } catch (error) {
      setTestError(formatApiError(error));
    } finally {
      setTesting(false);
    }
  };

  const tools = toolsState.status === 'ready' ? toolsState.data.tools : [];

  return (
    <Drawer
      open
      title={server.name}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-slate-500">{server.id}</span>
          <Badge tone={badgeToneForStatus(server.status)}>{server.status}</Badge>
          {server.envFile ? <Badge tone="info">env file</Badge> : null}
        </span>
      }
      onClose={onClose}
      size="xl"
      footer={
        <>
          <SecondaryButton onClick={onClose}>Close</SecondaryButton>
          <PrimaryButton onClick={() => void savePolicy()} disabled={saving || toolsState.status !== 'ready'}>
            {saving ? 'Saving policy…' : 'Save policy'}
          </PrimaryButton>
        </>
      }
    >
      <div className="space-y-6">
        {saveError !== null && <Notice tone="error" title="Policy update failed" onDismiss={() => setSaveError(null)}>{saveError}</Notice>}

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Server info</h3>
          <dl className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4 sm:grid-cols-2">
            <InfoRow label="Runtime">{server.runtime} · {server.transport}</InfoRow>
            <InfoRow label="PID">{server.pid ?? '—'}</InfoRow>
            <InfoRow label="Command">
              <span className="font-mono text-[11px]">
                {server.command ? `${server.command} ${server.args.join(' ')}`.trim() : '—'}
              </span>
            </InfoRow>
            <InfoRow label="Remote URL">{server.url ?? '—'}</InfoRow>
            <InfoRow label="Source">
              <span title={server.sourceUrl ?? undefined}>{server.sourceUrl ? truncateMiddle(server.sourceUrl) : '—'}</span>
            </InfoRow>
            <InfoRow label="Work dir">{server.workDir ?? '—'}</InfoRow>
            <InfoRow label="Env keys">
              {Object.keys(server.env).length === 0 ? (
                '—'
              ) : (
                <span className="flex flex-wrap gap-1">
                  {Object.keys(server.env).map((key) => (
                    <Badge key={key} tone="neutral">
                      {key}
                    </Badge>
                  ))}
                </span>
              )}
            </InfoRow>
            <InfoRow label="Updated">{formatTimestamp(server.updatedAt)}</InfoRow>
            {server.lastError !== null && (
              <div className="sm:col-span-2">
                <InfoRow label="Last error">
                  <span className="text-rose-300">{server.lastError}</span>
                </InfoRow>
              </div>
            )}
          </dl>
        </section>

        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Tools &amp; approval policy
            </h3>
            <span className="text-[11px] text-slate-500">
              {highPrivilegeTools.length} high-privilege · {approvalRequiredTools.length} approval-required
            </span>
          </div>
          <div className="rounded-xl border border-slate-800">
            {toolsState.status === 'loading' && (
              <div role="status" aria-label="Loading tools" className="space-y-2 p-4">
                {[0, 1, 2].map((index) => (
                  <SkeletonBlock key={index} className="h-8 w-full" />
                ))}
              </div>
            )}
            {toolsState.status === 'error' && (
              <div className="p-3">
                <ErrorState message={toolsState.error} onRetry={toolsState.reload} />
              </div>
            )}
            {toolsState.status === 'ready' &&
              (tools.length === 0 ? (
                <p className="px-4 py-5 text-xs text-slate-500">
                  No discovered tools yet — start the server or run the activation probe to populate its tool list.
                </p>
              ) : (
                <ul className="divide-y divide-slate-800/70">
                  {tools.map((tool) => {
                    const highPrivilege = highPrivilegeTools.includes(tool.name) || highPrivilegeTools.includes(tool.id);
                    const approvalRequired =
                      approvalRequiredTools.includes(tool.name) || approvalRequiredTools.includes(tool.id);
                    return (
                      <li key={tool.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="font-mono text-xs font-medium text-slate-200">{tool.name}</p>
                          <p className="mt-0.5 max-w-xl text-[11px] text-slate-500">{tool.description || 'No description'}</p>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <CheckboxField
                            label="High-privilege"
                            checked={highPrivilege}
                            onChange={() => toggle(highPrivilegeTools, setHighPrivilegeTools, tool.name)}
                          />
                          <CheckboxField
                            label="Approval required"
                            checked={approvalRequired}
                            onChange={() => toggle(approvalRequiredTools, setApprovalRequiredTools, tool.name)}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ))}
          </div>
          <div className="mt-3">
            <Field
              label="Env file"
              hint="Optional KEY=VALUE file read at start (for example ~/.config/example/mcp.env). Values stay on disk and are never persisted."
            >
              <TextInput
                value={envFile}
                onChange={(event) => setEnvFile(event.target.value)}
                placeholder="~/.config/example/mcp.env"
                spellCheck={false}
              />
            </Field>
          </div>
        </section>

        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Activation probe</h3>
            <GhostButton onClick={() => void runTest()} disabled={testing}>
              {testing ? 'Testing…' : 'Test server'}
            </GhostButton>
          </div>
          {testError !== null && <Notice tone="error">{testError}</Notice>}
          {testResult !== null && (
            <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={testResult.ok ? 'success' : 'danger'}>{testResult.ok ? 'probe ok' : 'probe failed'}</Badge>
                <span className="text-xs text-slate-400">
                  {testResult.toolCount} tool{testResult.toolCount === 1 ? '' : 's'} · {formatDuration(testResult.latencyMs)}
                </span>
              </div>
              {testResult.error !== null && <p className="text-[11px] text-rose-300">{testResult.error}</p>}
              {testResult.tools.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {testResult.tools.map((tool) => (
                    <Badge key={tool} tone="neutral">
                      {tool}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Logs</h3>
            <GhostButton onClick={logsState.reload}>Refresh snapshot</GhostButton>
          </div>
          <div className="terminal-scroll mb-3 h-40 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/80 p-3 font-mono text-[11.5px] leading-relaxed text-slate-300">
            {logsState.status === 'loading' && <p className="text-slate-500">Loading snapshot…</p>}
            {logsState.status === 'error' && <p className="text-rose-300">{logsState.error}</p>}
            {logsState.status === 'ready' &&
              (logsState.data.length === 0 ? (
                <p className="text-slate-600">No buffered log lines yet.</p>
              ) : (
                logsState.data.map((line, index) => (
                  <div key={`${line.ts}-${index}`} className="whitespace-pre-wrap break-words">
                    <span className="mr-2 text-slate-600">{formatTimestamp(line.ts)}</span>
                    <span className="mr-1.5 text-slate-500">[{line.stream}]</span>
                    {line.line}
                  </div>
                ))
              ))}
          </div>
          <LiveLogPanel serverId={server.id} maxLines={300} />
        </section>
      </div>
    </Drawer>
  );
}
