import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { useAsyncData } from '../../lib/hooks.js';
import { formatDuration, formatTimestamp } from '../../lib/format.js';
import { Drawer } from '../../components/Drawer.js';
import { Badge, badgeToneForStatus } from '../../components/Badge.js';
import { ErrorState, Notice } from '../../components/States.js';
import { SkeletonBlock } from '../../components/Skeleton.js';
import { CheckboxField, GhostButton, PrimaryButton, SecondaryButton, Select } from '../../components/Form.js';
import { LiveLogPanel } from '../../components/LiveLogPanel.js';
import { useToast } from '../../components/Toasts.js';
import { UpdateDialog } from './UpdateDialog.js';
import type {
  ConfigProfileApplyResult,
  ConfigProfileSummary,
  InstallTestResult,
  ServerRecord,
  ServerSourceInfo,
  UpdateCheckResult,
} from '../../../core/types.js';

export interface ServerDrawerProps {
  server: ServerRecord;
  onClose: () => void;
  onSaved: (server: ServerRecord) => void;
  /** Called after an update or profile change so the parent list can refresh. */
  onUpdated: () => void;
  /** Navigate to the full `#/server/<id>` inspector page. */
  onOpenInspector?: (serverId: string) => void;
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
export function ServerDrawer({ server, onClose, onSaved, onUpdated, onOpenInspector }: ServerDrawerProps) {
  const toast = useToast();
  const toolsState = useAsyncData(() => api.serverTools(server.id), [server.id]);
  const logsState = useAsyncData(() => api.serverLogs(server.id, 200), [server.id]);

  const updatesState = useAsyncData<ServerSourceInfo | null>(async () => {
    const sources = await api.listServerUpdates();
    return sources.find((source) => source.serverId === server.id) ?? null;
  }, [server.id]);
  const profilesState = useAsyncData(() => api.listConfigProfiles(), []);

  const [highPrivilegeTools, setHighPrivilegeTools] = useState<string[]>([]);
  const [approvalRequiredTools, setApprovalRequiredTools] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<InstallTestResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<UpdateCheckResult | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [applyResults, setApplyResults] = useState<ConfigProfileApplyResult[] | null>(null);
  const [migrating, setMigrating] = useState(false);

  useEffect(() => {
    if (toolsState.status !== 'ready') return;
    setHighPrivilegeTools(toolsState.data.highPrivilegeTools);
    setApprovalRequiredTools(toolsState.data.approvalRequiredTools);
  }, [toolsState.status, toolsState.data]);

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

  const source = updatesState.status === 'ready' ? updatesState.data : null;
  const profiles: ConfigProfileSummary[] = profilesState.status === 'ready' ? profilesState.data : [];
  const attachedIds = server.configProfileIds ?? profiles
    .filter((profile) => profile.attachedServerIds.includes(server.id))
    .map((profile) => profile.id);
  const attachedProfiles = profiles.filter((profile) => attachedIds.includes(profile.id));
  const updateAvailable =
    checkResult !== null ? checkResult.updateAvailable : source?.updateAvailable === true;

  useEffect(() => {
    if (profilesState.status !== 'ready') return;
    if (selectedProfileId !== '' && profiles.some((profile) => profile.id === selectedProfileId)) return;
    const next = profiles.find((profile) => attachedIds.includes(profile.id)) ?? profiles[0];
    setSelectedProfileId(next?.id ?? '');
  }, [profilesState.status, profilesState.data, selectedProfileId]);

  const checkNow = async (): Promise<void> => {
    setChecking(true);
    setProfileError(null);
    try {
      const result = await api.checkServerUpdate(server.id);
      setCheckResult(result);
      if (result.error !== null) {
        toast('error', `Update check failed: ${result.error}`);
      } else if (result.updateAvailable) {
        toast('info', `Update available: v${result.fromVersion ?? '?'} → v${result.toVersion ?? '?'}`);
      } else {
        toast('success', 'This server is up to date.');
      }
      updatesState.reload();
      onUpdated();
    } catch (error) {
      setProfileError(formatApiError(error));
    } finally {
      setChecking(false);
    }
  };

  const applyProfile = async (options: { restart: boolean; test: boolean }): Promise<void> => {
    if (selectedProfileId === '') {
      setProfileError('Choose a configuration profile first.');
      return;
    }
    setProfileBusy(true);
    setProfileError(null);
    try {
      const results = await api.applyConfigProfile(selectedProfileId, {
        serverIds: [server.id],
        restart: options.restart,
        test: options.test,
      });
      setApplyResults(results);
      const first = results[0];
      if (first?.error !== null && first?.error !== undefined) {
        setProfileError(first.error);
      } else {
        const name = profiles.find((profile) => profile.id === selectedProfileId)?.name ?? 'Profile';
        toast('success', `“${name}” applied to “${server.name}”.`);
      }
      profilesState.reload();
      onUpdated();
    } catch (error) {
      setProfileError(formatApiError(error));
    } finally {
      setProfileBusy(false);
    }
  };

  const detachProfile = async (profile: ConfigProfileSummary): Promise<void> => {
    setProfileBusy(true);
    setProfileError(null);
    try {
      await api.detachConfigProfile(profile.id, server.id);
      toast('success', `Detached “${profile.name}” from “${server.name}”.`);
      profilesState.reload();
      onUpdated();
    } catch (error) {
      setProfileError(formatApiError(error));
    } finally {
      setProfileBusy(false);
    }
  };

  const migrateEnvFile = async (): Promise<void> => {
    setMigrating(true);
    setProfileError(null);
    try {
      const profile = await api.migrateEnvFile(server.id);
      toast(
        'success',
        `Migrated legacy env file into encrypted profile “${profile.name}” and attached it.`,
      );
      profilesState.reload();
      onSaved(server);
      onUpdated();
    } catch (error) {
      setProfileError(formatApiError(error));
    } finally {
      setMigrating(false);
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
          {onOpenInspector !== undefined && (
            <GhostButton onClick={() => onOpenInspector(server.id)}>Open full inspector</GhostButton>
          )}
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
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Source &amp; updates</h3>
            <div className="flex flex-wrap items-center gap-1">
              <GhostButton onClick={() => void checkNow()} disabled={checking}>
                {checking ? 'Checking…' : 'Check now'}
              </GhostButton>
              <PrimaryButton
                onClick={() => setUpdateOpen(true)}
                disabled={!updateAvailable || checking}
                className="px-2 py-1 text-[11px]"
              >
                Update now
              </PrimaryButton>
            </div>
          </div>
          {updatesState.status === 'loading' && (
            <div role="status" aria-label="Loading update status" className="space-y-2">
              <SkeletonBlock className="h-3 w-2/3" />
              <SkeletonBlock className="h-3 w-1/2" />
            </div>
          )}
          {updatesState.status === 'error' && (
            <ErrorState message={updatesState.error} onRetry={updatesState.reload} />
          )}
          {updatesState.status === 'ready' &&
            (source === null ? (
              <p className="rounded-xl border border-dashed border-slate-800 px-3 py-3 text-[11px] text-slate-500">
                This server has no tracked upstream repository (locally registered or imported from a harness
                entry). Install it from a catalog or Git URL to enable update checks.
              </p>
            ) : (
              <dl className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4 sm:grid-cols-2">
                <InfoRow label="Repository">
                  {source.repoUrl === null ? (
                    '—'
                  ) : (
                    <span className="break-all font-mono text-[11px]" title={source.repoUrl}>
                      {truncateMiddle(source.repoUrl, 64)}
                    </span>
                  )}
                </InfoRow>
                <InfoRow label="Requested ref">{source.requestedRef ?? '—'}</InfoRow>
                <InfoRow label="Installed version">
                  {source.installedVersion === null ? '—' : `v${source.installedVersion}`}
                </InfoRow>
                <InfoRow label="Installed commit">
                  <span className="font-mono text-[11px]">{source.installedCommit ?? '—'}</span>
                </InfoRow>
                <InfoRow label="Latest version">
                  {source.latestVersion === null ? '—' : `v${source.latestVersion}`}
                  {source.latestRef !== null ? ` (${source.latestRef})` : ''}
                </InfoRow>
                <InfoRow label="Latest commit">
                  <span className="font-mono text-[11px]">{source.latestCommit ?? '—'}</span>
                </InfoRow>
                <InfoRow label="Last checked">
                  {source.checkedAt === null ? 'never' : formatTimestamp(source.checkedAt)}
                </InfoRow>
                <InfoRow label="Status">
                  <span className="flex flex-wrap items-center gap-1.5">
                    {source.checkError !== null ? (
                      <Badge tone="danger">error</Badge>
                    ) : source.updateAvailable ? (
                      <Badge tone="warning">update available</Badge>
                    ) : (
                      <Badge tone="success">up to date</Badge>
                    )}
                    {source.changelogUrl !== null && /^https?:\/\//.test(source.changelogUrl) && (
                      <a
                        href={source.changelogUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] font-semibold text-sky-300 underline-offset-2 hover:underline"
                      >
                        Changelog ↗
                      </a>
                    )}
                  </span>
                </InfoRow>
                {source.checkError !== null && (
                  <div className="sm:col-span-2">
                    <InfoRow label="Check error">
                      <span className="text-rose-300">{source.checkError}</span>
                    </InfoRow>
                  </div>
                )}
              </dl>
            ))}
          {checkResult !== null && (
            <div className="mt-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-[11px] text-slate-400">
              Latest check: <span className="font-mono text-slate-300">{checkResult.status}</span>
              {' · '}v{checkResult.fromVersion ?? '—'} → v{checkResult.toVersion ?? '—'}
              {' · '}commits {checkResult.fromCommit?.slice(0, 7) ?? '—'} →{' '}
              {checkResult.toCommit?.slice(0, 7) ?? '—'}
              {checkResult.error !== null ? ` · ${checkResult.error}` : ''}
            </div>
          )}
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
          <p className="mt-3 text-[11px] text-slate-500">
            Environment values, credentials and headers are managed by encrypted configuration profiles — open the
            <span className="mx-1 font-semibold text-slate-300">Configurations</span>
            page to attach reusable profiles instead of env files.
          </p>
        </section>

        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Configuration profiles
            </h3>
            <GhostButton onClick={profilesState.reload}>Refresh</GhostButton>
          </div>

          {server.envFile !== null && server.envFile !== undefined && (
            <Notice tone="warning" title="Legacy env file detected">
              <p>
                This server still reads <code className="font-mono">{server.envFile}</code>. Migrate it into an
                encrypted profile so the values live in the gateway vault and can be reused.
              </p>
              <button
                type="button"
                onClick={() => void migrateEnvFile()}
                disabled={migrating}
                className="mt-2 rounded-lg border border-amber-700 px-2.5 py-1 text-[11px] font-semibold text-amber-100 transition-colors hover:bg-amber-900/40 disabled:opacity-50"
              >
                {migrating ? 'Migrating…' : 'Migrate to encrypted profile'}
              </button>
            </Notice>
          )}

          {profilesState.status === 'loading' && (
            <div role="status" aria-label="Loading configuration profiles" className="space-y-2">
              <SkeletonBlock className="h-6 w-1/2" />
              <SkeletonBlock className="h-8 w-full" />
            </div>
          )}
          {profilesState.status === 'error' && (
            <ErrorState message={profilesState.error} onRetry={profilesState.reload} />
          )}
          {profilesState.status === 'ready' && (
            <div className="space-y-3">
              {attachedProfiles.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-800 px-3 py-3 text-[11px] text-slate-500">
                  No encrypted configuration profiles attached. Attach one below to inject shared values without an
                  env file.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {attachedProfiles.map((profile) => (
                    <span
                      key={profile.id}
                      className="inline-flex items-center gap-1 rounded-full border border-indigo-800 bg-indigo-950/70 py-0.5 pl-2 pr-1 text-[11px] text-indigo-200"
                    >
                      {profile.name}
                      <button
                        type="button"
                        aria-label={`Detach ${profile.name}`}
                        onClick={() => void detachProfile(profile)}
                        disabled={profileBusy}
                        className="rounded-full px-1 text-indigo-300 transition-colors hover:bg-indigo-900/60 hover:text-indigo-100 disabled:opacity-50"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {profiles.length === 0 ? (
                <p className="text-[11px] text-slate-500">
                  No profiles exist yet — create one on the Configurations page.
                </p>
              ) : (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block min-w-0 flex-1">
                    <span className="mb-1 block text-xs font-medium text-slate-300">Profile</span>
                    <Select
                      value={selectedProfileId}
                      onChange={(event) => setSelectedProfileId(event.target.value)}
                    >
                      {profiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                          {attachedIds.includes(profile.id) ? ' (attached)' : ''}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <GhostButton
                    onClick={() => void applyProfile({ restart: false, test: false })}
                    disabled={profileBusy || selectedProfileId === ''}
                  >
                    Attach
                  </GhostButton>
                  <PrimaryButton
                    onClick={() => void applyProfile({ restart: true, test: true })}
                    disabled={profileBusy || selectedProfileId === ''}
                    className="px-3 py-1.5 text-xs"
                  >
                    {profileBusy ? 'Applying…' : 'Apply & test'}
                  </PrimaryButton>
                </div>
              )}

              {profileError !== null && (
                <Notice tone="error" title="Configuration profile action failed" onDismiss={() => setProfileError(null)}>
                  {profileError}
                </Notice>
              )}

              {applyResults !== null && applyResults.length > 0 && (
                <ul className="space-y-1.5">
                  {applyResults.map((result) => (
                    <li
                      key={result.serverId}
                      className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-[11px]"
                    >
                      <span className="font-medium text-slate-200">{result.serverName}</span>{' '}
                      <Badge tone={result.applied ? 'success' : 'danger'}>
                        {result.applied ? 'attached' : 'failed'}
                      </Badge>{' '}
                      {result.restarted && <Badge tone="info">restarted</Badge>}{' '}
                      {result.test !== null && (
                        <Badge tone={result.test.ok ? 'success' : 'danger'}>
                          {result.test.ok
                            ? `${result.test.toolCount} tools · ${formatDuration(result.test.latencyMs)}`
                            : 'probe failed'}
                        </Badge>
                      )}
                      {result.error !== null && (
                        <span className="block text-rose-300">{result.error}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
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

      {updateOpen && (
        <UpdateDialog
          server={server}
          source={source}
          onClose={() => setUpdateOpen(false)}
          onUpdated={() => {
            updatesState.reload();
            setCheckResult(null);
            onUpdated();
          }}
        />
      )}
    </Drawer>
  );
}
