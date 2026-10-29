import { useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { Drawer } from '../../components/Drawer.js';
import { Badge } from '../../components/Badge.js';
import type { BadgeTone } from '../../components/Badge.js';
import { Notice } from '../../components/States.js';
import { Tabs } from '../../components/Tabs.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import {
  DangerButton,
  Field,
  GhostButton,
  PrimaryButton,
  SecondaryButton,
  TextInput,
} from '../../components/Form.js';
import { useToast } from '../../components/Toasts.js';
import { formatTimestamp } from '../../lib/format.js';
import { KeyActivityTab } from './KeyActivityTab.js';
import { KeyAccessTab } from './KeyAccessTab.js';
import type { KeySummary } from '../../../core/types.js';

export interface KeyDetailProps {
  keyRecord: KeySummary;
  onClose: () => void;
  onChanged: (key: KeySummary) => void;
}

type DetailTab = 'activity' | 'access';

function statusOf(key: KeySummary): { label: string; tone: BadgeTone } {
  if (key.revokedAt !== null) return { label: 'revoked', tone: 'danger' };
  if (key.expiresAt !== null && new Date(key.expiresAt).getTime() < Date.now()) {
    return { label: 'expired', tone: 'neutral' };
  }
  if (key.pausedAt !== null) return { label: 'paused', tone: 'warning' };
  return { label: 'active', tone: 'success' };
}

/** Drawer with per-key activity, effective access controls and rename/pause actions. */
export function KeyDetail({ keyRecord: key, onClose, onChanged }: KeyDetailProps) {
  const toast = useToast();
  const [tab, setTab] = useState<DetailTab>('activity');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(key.name);
  const [savingName, setSavingName] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const status = statusOf(key);
  const paused = key.pausedAt !== null;
  const revoked = key.revokedAt !== null;

  const saveName = async (): Promise<void> => {
    const name = nameDraft.trim();
    setActionError(null);
    if (name === '') {
      setActionError('Key name cannot be empty.');
      return;
    }
    setSavingName(true);
    try {
      const updated = await api.updateKey(key.id, { name });
      onChanged(updated);
      setEditingName(false);
      toast('success', `Key renamed to “${updated.name}”.`);
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setSavingName(false);
    }
  };

  const togglePause = async (): Promise<void> => {
    setPauseBusy(true);
    setActionError(null);
    try {
      const updated = paused ? await api.resumeKey(key.id) : await api.pauseKey(key.id);
      onChanged(updated);
      toast('success', paused ? `“${updated.name}” resumed.` : `“${updated.name}” paused — all calls are refused.`);
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setPauseBusy(false);
    }
  };

  const confirmRevoke = async (): Promise<void> => {
    setRevokeBusy(true);
    setActionError(null);
    try {
      const updated = await api.revokeKey(key.id);
      onChanged(updated);
      setRevokeOpen(false);
      toast('success', `Revoked “${updated.name}”.`);
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setRevokeBusy(false);
    }
  };

  return (
    <Drawer
      open
      title={key.name}
      subtitle={
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[11px] text-slate-500">{key.id}</span>
          <Badge tone={key.keyType === 'master' ? 'danger' : 'info'}>{key.keyType}</Badge>
          <Badge tone="neutral">{key.keyPrefix}…</Badge>
          <Badge tone={status.tone}>{status.label}</Badge>
        </span>
      }
      onClose={onClose}
      size="xl"
      footer={<SecondaryButton onClick={onClose}>Close</SecondaryButton>}
    >
      <div className="space-y-4">
        {actionError !== null && (
          <Notice tone="error" title="Key action failed" onDismiss={() => setActionError(null)}>
            {actionError}
          </Notice>
        )}
        {paused && (
          <Notice tone="warning" title="This key is paused — all calls are refused">
            Resume from the actions below or from the Access tab when the agent may call tools again.
          </Notice>
        )}

        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              {editingName ? (
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Key name" className="min-w-[12rem]">
                    <TextInput
                      value={nameDraft}
                      onChange={(event) => setNameDraft(event.target.value)}
                      autoFocus
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void saveName();
                        if (event.key === 'Escape') {
                          setEditingName(false);
                          setNameDraft(key.name);
                        }
                      }}
                    />
                  </Field>
                  <PrimaryButton onClick={() => void saveName()} disabled={savingName}>
                    {savingName ? 'Saving…' : 'Save'}
                  </PrimaryButton>
                  <SecondaryButton
                    onClick={() => {
                      setEditingName(false);
                      setNameDraft(key.name);
                    }}
                    disabled={savingName}
                  >
                    Cancel
                  </SecondaryButton>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-base font-semibold text-slate-100">{key.name}</p>
                  <GhostButton
                    onClick={() => {
                      setNameDraft(key.name);
                      setEditingName(true);
                    }}
                    disabled={revoked}
                    aria-label="Rename key"
                  >
                    ✎ Rename
                  </GhostButton>
                </div>
              )}
              <div className="mt-2 grid gap-3 text-[11px] text-slate-400 sm:grid-cols-2 xl:grid-cols-4">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Created</p>
                  <p>{formatTimestamp(key.createdAt)}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Last used</p>
                  <p>{key.lastUsedAt === null ? 'never' : formatTimestamp(key.lastUsedAt)}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Expires</p>
                  <p>{key.expiresAt === null ? 'never' : formatTimestamp(key.expiresAt)}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Flags</p>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    <Badge tone={key.delegationAllowed ? 'success' : 'neutral'}>
                      delegate {key.delegationAllowed ? 'on' : 'off'}
                    </Badge>
                    <Badge tone={key.escalationAllowed ? 'info' : 'neutral'}>
                      escalate {key.escalationAllowed ? 'on' : 'off'}
                    </Badge>
                  </div>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <GhostButton onClick={() => void togglePause()} disabled={pauseBusy || revoked}>
                {pauseBusy ? 'Working…' : paused ? 'Resume' : 'Pause'}
              </GhostButton>
              <DangerButton
                onClick={() => setRevokeOpen(true)}
                disabled={revoked}
                className="px-2 py-1 text-[11px]"
              >
                Revoke
              </DangerButton>
            </div>
          </div>
        </section>

        <Tabs
          label="Key detail sections"
          items={[
            { key: 'activity' as const, label: 'Activity' },
            { key: 'access' as const, label: 'Access' },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === 'activity' && <KeyActivityTab keyId={key.id} />}
        {tab === 'access' && <KeyAccessTab apiKey={key} onChanged={onChanged} />}
      </div>

      <ConfirmDialog
        open={revokeOpen}
        title="Revoke API key"
        tone="danger"
        confirmLabel="Revoke key"
        busy={revokeBusy}
        onConfirm={() => void confirmRevoke()}
        onCancel={() => setRevokeOpen(false)}
        description={`Instantly lock out “${key.name}” (${key.keyPrefix}…)? This cannot be undone.`}
      />
    </Drawer>
  );
}
