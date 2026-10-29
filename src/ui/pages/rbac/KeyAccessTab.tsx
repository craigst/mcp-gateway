import { useEffect, useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { useAsyncData } from '../../lib/hooks.js';
import { Badge, badgeToneForStatus } from '../../components/Badge.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorState, Notice } from '../../components/States.js';
import { SkeletonBlock } from '../../components/Skeleton.js';
import { CheckboxField, GhostButton, PrimaryButton } from '../../components/Form.js';
import { useToast } from '../../components/Toasts.js';
import type { KeyGrantToolView, KeyGrantView, KeySummary, ServerGrant } from '../../../core/types.js';

export interface KeyAccessTabProps {
  apiKey: KeySummary;
  onChanged: (key: KeySummary) => void;
}

/** Effective access view for a key: pause whole key, a server grant, or a single tool. */
export function KeyAccessTab({ apiKey: key, onChanged }: KeyAccessTabProps) {
  const toast = useToast();
  const accessState = useAsyncData(() => api.getKeyAccess(key.id), [key.id]);
  const [grants, setGrants] = useState<KeyGrantView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (accessState.status !== 'ready') return;
    setGrants(accessState.data.grants);
  }, [accessState.status, accessState.data]);

  const paused = key.pausedAt !== null;
  const revoked = key.revokedAt !== null;

  const setGrantPaused = (serverId: string, nextPaused: boolean): KeyGrantView[] =>
    grants.map((grant) => (grant.serverId === serverId ? { ...grant, paused: nextPaused } : grant));

  const setToolPaused = (serverId: string, toolName: string, nextPaused: boolean): KeyGrantView[] =>
    grants.map((grant) =>
      grant.serverId === serverId
        ? {
            ...grant,
            tools: grant.tools.map((tool) =>
              tool.name === toolName ? { ...tool, paused: nextPaused } : tool,
            ),
          }
        : grant,
    );

  const updateGrants = async (serverId: string, next: KeyGrantView[], payload: ServerGrant[]): Promise<void> => {
    const previous = grants;
    setGrants(next);
    setError(null);
    try {
      const updated = await api.updateKey(key.id, { serverGrants: payload });
      onChanged(updated);
      accessState.reload();
      toast('success', 'Access updated.');
    } catch (updateError) {
      setGrants(previous);
      setError(formatApiError(updateError));
    }
  };

  const toggleServer = async (grant: KeyGrantView): Promise<void> => {
    if (busy !== null) return;
    setBusy(`server:${grant.serverId}`);
    const nextPaused = !grant.paused;
    const payload = key.serverGrants.map((existing) =>
      existing.serverId === grant.serverId ? { ...existing, paused: nextPaused } : existing,
    );
    await updateGrants(grant.serverId, setGrantPaused(grant.serverId, nextPaused), payload);
    setBusy(null);
  };

  const toggleTool = async (grant: KeyGrantView, tool: KeyGrantToolView): Promise<void> => {
    if (busy !== null) return;
    setBusy(`tool:${grant.serverId}:${tool.name}`);
    const nextPaused = !tool.paused;
    const payload = key.serverGrants.map((existing) => {
      if (existing.serverId !== grant.serverId) return existing;
      const current = existing.pausedTools ?? [];
      const pausedTools = nextPaused
        ? [...current.filter((name) => name !== tool.name), tool.name]
        : current.filter((name) => name !== tool.name);
      return { ...existing, pausedTools };
    });
    await updateGrants(grant.serverId, setToolPaused(grant.serverId, tool.name, nextPaused), payload);
    setBusy(null);
  };

  const setKeyPaused = async (next: boolean): Promise<void> => {
    setBusy('key');
    setError(null);
    try {
      const updated = next ? await api.pauseKey(key.id) : await api.resumeKey(key.id);
      onChanged(updated);
      toast('success', next ? 'All access paused for this key.' : 'Key access resumed.');
      accessState.reload();
    } catch (pauseError) {
      setError(formatApiError(pauseError));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-900/40 p-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-100">Key-level access</p>
          <p className="text-[11px] text-slate-500">
            {paused
              ? 'This key is paused — all calls are refused.'
              : revoked
                ? 'This key is revoked; access controls are inert.'
                : 'Pausing refuses every call made with this key until resumed.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {paused ? (
            <PrimaryButton
              onClick={() => void setKeyPaused(false)}
              disabled={busy !== null || revoked}
              className="px-3 py-1.5 text-xs"
            >
              {busy === 'key' ? 'Resuming…' : 'Resume all access'}
            </PrimaryButton>
          ) : (
            <GhostButton onClick={() => void setKeyPaused(true)} disabled={busy !== null || revoked}>
              {busy === 'key' ? 'Pausing…' : 'Pause all access'}
            </GhostButton>
          )}
          <GhostButton onClick={accessState.reload}>Refresh</GhostButton>
        </div>
      </div>

      {paused && (
        <Notice tone="warning" title="This key is paused — all calls are refused">
          Resume the key from the header or above when the agent may call tools again. Server and tool switches below
          are preserved while paused.
        </Notice>
      )}
      {error !== null && (
        <Notice tone="error" title="Access update failed" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}

      {accessState.status === 'loading' && (
        <div role="status" aria-label="Loading key access" className="space-y-2">
          {[0, 1, 2].map((index) => (
            <SkeletonBlock key={index} className="h-16 w-full" />
          ))}
        </div>
      )}
      {accessState.status === 'error' && (
        <ErrorState message={accessState.error} onRetry={accessState.reload} />
      )}
      {accessState.status === 'ready' &&
        (grants.length === 0 ? (
          <EmptyState
            icon="⬡"
            title="No server grants"
            description="This key has no server grants yet. Add server and tool scopes in RBAC before pausing individual tools."
          />
        ) : (
          <ul className="space-y-3">
            {grants.map((grant) => {
              const known = grant.serverStatus !== 'unknown' && grant.serverStatus !== 'missing';
              return (
                <li key={grant.serverId} className="rounded-xl border border-slate-800 bg-slate-900/40">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-slate-200">{grant.serverName}</p>
                        <Badge tone={badgeToneForStatus(grant.serverStatus)}>{grant.serverStatus}</Badge>
                        {grant.paused && <Badge tone="warning">grant paused</Badge>}
                        {!known && <Badge tone="danger">unknown server</Badge>}
                      </div>
                      <p className="mt-0.5 font-mono text-[10px] text-slate-500">{grant.serverId}</p>
                      {!known && (
                        <p className="mt-1 text-[10px] text-slate-500">
                          This server no longer exists in the catalog; the grant can still be paused but calls will
                          fail with an unknown-server error.
                        </p>
                      )}
                    </div>
                    <CheckboxField
                      label="Pause whole server grant"
                      checked={grant.paused}
                      disabled={!known || busy !== null}
                      onChange={() => void toggleServer(grant)}
                    />
                  </div>

                  {grant.tools.length === 0 ? (
                    <p className="px-4 py-3 text-[11px] text-slate-500">
                      No tools are exposed by this server for this key.
                    </p>
                  ) : (
                    <ul className="divide-y divide-slate-800/70">
                      {grant.tools.map((tool) => (
                        <li
                          key={`${grant.serverId}:${tool.name}`}
                          className="flex flex-wrap items-start justify-between gap-2 px-4 py-2.5"
                        >
                          <div className="min-w-0 flex-1" title={tool.description || undefined}>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-mono text-[11px] text-slate-300">{tool.name}</span>
                              {tool.highPrivilege && <Badge tone="warning">high-privilege</Badge>}
                              {tool.approvalRequired && <Badge tone="danger">approval required</Badge>}
                              {tool.granted ? (
                                <Badge tone="success">granted</Badge>
                              ) : (
                                <Badge tone="neutral">not granted</Badge>
                              )}
                              {tool.paused && <Badge tone="warning">paused</Badge>}
                              {!tool.available && tool.granted && (
                                <Badge tone="neutral">unavailable</Badge>
                              )}
                            </div>
                            <p className="mt-0.5 max-w-xl truncate text-[10px] text-slate-500">
                              {tool.description || 'No description'}
                            </p>
                          </div>
                          {tool.granted && (
                            <CheckboxField
                              label="Pause tool"
                              checked={tool.paused}
                              disabled={busy !== null}
                              onChange={() => void toggleTool(grant, tool)}
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        ))}

      <p className="text-[11px] text-slate-500">
        Pausing a server or tool leaves the grant in place and only refuses calls. Add, remove or re-scope grants from
        the RBAC page.
      </p>
    </div>
  );
}
