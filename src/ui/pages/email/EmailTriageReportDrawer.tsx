import { useCallback, useEffect, useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { formatTimestamp } from '../../lib/format.js';
import { Drawer } from '../../components/Drawer.js';
import { SecondaryButton } from '../../components/Form.js';
import { EmptyState } from '../../components/EmptyState.js';
import { SkeletonBlock } from '../../components/Skeleton.js';
import { Notice } from '../../components/States.js';
import type { EmailTriageReport } from '../../../email/types.js';

export interface EmailTriageReportDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Called after an undo so the mailbox list can pick up a changed never-junk list. */
  onChanged: () => void;
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-slate-100">{value}</p>
      {hint !== undefined && <p className="text-[10px] text-slate-500">{hint}</p>}
    </div>
  );
}

/**
 * What triage did, read back from the audit trail.
 *
 * The point of this panel is the undo: a filing is a move, so anything the
 * model got wrong is one press from being back in the inbox, and the sender can
 * be exempted at the same time.
 */
export function EmailTriageReportDrawer({ open, onClose, onChanged }: EmailTriageReportDrawerProps) {
  const [report, setReport] = useState<EmailTriageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await api.getEmailTriageReport(7));
      setError(null);
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const undo = async (auditId: number, addSender: boolean): Promise<void> => {
    setBusy(auditId);
    setError(null);
    try {
      await api.unfileEmailFiling(auditId, addSender);
      await load();
      onChanged();
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setBusy(null);
    }
  };

  const totals = report?.totals;

  return (
    <Drawer
      open={open}
      size="lg"
      title="Triage report"
      subtitle="Last 7 days, from the audit trail"
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-[11px] text-slate-500">Admin only</span>
          <SecondaryButton onClick={() => void load()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </SecondaryButton>
          <SecondaryButton onClick={onClose}>Close</SecondaryButton>
        </>
      }
    >
      <div className="space-y-5">
        {error !== null && <Notice tone="error" title="Could not load the report">{error}</Notice>}
        {report === null || totals === undefined ? (
          loading ? (
            <div className="space-y-2">
              <SkeletonBlock className="h-16 w-full" />
              <SkeletonBlock className="h-24 w-full" />
            </div>
          ) : (
            <EmptyState title="No report" description="Triage has not recorded anything in this window." />
          )
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Decisions" value={totals.decisions} />
              <Stat label="Needs reply" value={totals.reply} />
              <Stat label="Important" value={totals.important} />
              <Stat label="No action" value={totals.skip} />
              <Stat label="Filed" value={totals.filed} hint="moved, never deleted" />
              <Stat label="Unsure" value={totals.unsure} hint="important under 0.7" />
            </div>

            {report.accounts.length > 0 && (
              <div className="space-y-1">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">By mailbox</p>
                {report.accounts.map((row) => (
                  <div
                    key={row.accountId}
                    className="flex items-center justify-between gap-3 rounded-md border border-slate-800 px-3 py-1.5 text-[11px]"
                  >
                    <span className="truncate text-slate-300">{row.accountEmail || row.accountId}</span>
                    <span className="shrink-0 text-slate-500">
                      {row.reply} reply · {row.important} important · {row.skip} no-action
                      {row.filed > 0 ? ` · ${row.filed} filed` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Recent filings</p>
              {report.recentFilings.length === 0 ? (
                <p className="text-[11px] text-slate-500">Nothing has been filed in the last 7 days.</p>
              ) : (
                report.recentFilings.map((filing) => (
                  <div key={filing.auditId} className="rounded-md border border-slate-800 px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[11px] font-medium text-slate-200">{filing.subject || '(no subject)'}</p>
                        <p className="truncate text-[10px] text-slate-500">
                          {filing.from} · {filing.folder} · {formatTimestamp(filing.at)}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() => void undo(filing.auditId, false)}
                          disabled={busy === filing.auditId || filing.toUid === null}
                          className="rounded border border-slate-700 px-2 py-0.5 text-[10px] font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                          title="Move it back to the inbox"
                        >
                          {busy === filing.auditId ? '…' : 'Move back'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void undo(filing.auditId, true)}
                          disabled={busy === filing.auditId || filing.toUid === null}
                          className="rounded border border-emerald-700/50 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
                          title="Move it back and never file this sender again"
                        >
                          Never file sender
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <p className="border-t border-slate-800 pt-3 text-[10px] leading-relaxed text-slate-500">
              A filing is a move, so every one of these can be undone. Nothing here was deleted, and no mail was
              sent: the only write triage performs is a move into a folder.
            </p>
          </>
        )}
      </div>
    </Drawer>
  );
}
