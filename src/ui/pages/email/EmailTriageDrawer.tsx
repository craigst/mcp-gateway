import { useEffect, useMemo, useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { formatTimestamp } from '../../lib/format.js';
import { Drawer } from '../../components/Drawer.js';
import { CheckboxField, Field, PrimaryButton, SecondaryButton, Select, TextArea, TextInput } from '../../components/Form.js';
import { Notice } from '../../components/States.js';
import type { EmailTriageAccount, EmailTriageInput, EmailTriageMode } from '../../../email/types.js';

const POLL_CHOICES = [
  { value: '60', label: 'Every minute' },
  { value: '300', label: 'Every 5 minutes' },
  { value: '900', label: 'Every 15 minutes' },
  { value: '3600', label: 'Every hour' },
];

/** A textarea holding one sender per line, or separated by commas. */
function parseSenders(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\n,;]+/u)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    ),
  ];
}

const listText = (entries: readonly string[]): string => entries.join('\n');

export interface EmailTriageDrawerProps {
  open: boolean;
  /** The mailbox being edited; null while the list is still loading. */
  triage: EmailTriageAccount | null;
  onClose: () => void;
  onSaved: (next: EmailTriageAccount) => void;
}

/**
 * One mailbox's triage settings.
 *
 * The switch here is the only thing that lets the watcher read a mailbox. It
 * starts off, it cannot send, and it cannot delete: "full" only adds filing
 * no-action mail into a folder, which the card's "Not spam" button reverses.
 */
export function EmailTriageDrawer({ open, triage, onClose, onSaved }: EmailTriageDrawerProps) {
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<EmailTriageMode>('important');
  const [pollSeconds, setPollSeconds] = useState('300');
  const [junkFolder, setJunkFolder] = useState('');
  const [alwaysImportant, setAlwaysImportant] = useState('');
  const [neverJunk, setNeverJunk] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || triage === null) return;
    setEnabled(triage.enabled);
    setMode(triage.mode);
    setPollSeconds(String(triage.pollSeconds));
    setJunkFolder(triage.junkFolder ?? '');
    setAlwaysImportant(listText(triage.alwaysImportant));
    setNeverJunk(listText(triage.neverJunk));
    setError(null);
  }, [open, triage]);

  const dirty = useMemo(() => {
    if (triage === null) return false;
    return (
      enabled !== triage.enabled ||
      mode !== triage.mode ||
      pollSeconds !== String(triage.pollSeconds) ||
      junkFolder !== (triage.junkFolder ?? '') ||
      alwaysImportant !== listText(triage.alwaysImportant) ||
      neverJunk !== listText(triage.neverJunk)
    );
  }, [triage, enabled, mode, pollSeconds, junkFolder, alwaysImportant, neverJunk]);

  const save = async (): Promise<void> => {
    if (triage === null) return;
    setSaving(true);
    setError(null);
    const input: EmailTriageInput = {
      enabled,
      mode,
      pollSeconds: Number(pollSeconds),
      junkFolder: junkFolder.trim() === '' ? null : junkFolder.trim(),
      alwaysImportant: parseSenders(alwaysImportant),
      neverJunk: parseSenders(neverJunk),
    };
    try {
      const result = await api.updateEmailTriage(triage.accountId, input);
      onSaved(result.triage);
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setSaving(false);
    }
  };

  const reasonBlocked = triage !== null && !triage.accountEnabled ? 'This mailbox is disabled: enable it in account settings first.' : null;

  return (
    <Drawer
      open={open}
      size="lg"
      title="Email triage"
      subtitle={triage === null ? undefined : `${triage.name} · ${triage.email}`}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-[11px] text-slate-500">
            {triage === null
              ? 'Admin only'
              : triage.lastRunAt === null
                ? 'Never read yet'
                : `Last read ${formatTimestamp(triage.lastRunAt)}`}
          </span>
          <SecondaryButton onClick={onClose} disabled={saving}>
            Close
          </SecondaryButton>
          <PrimaryButton onClick={() => void save()} disabled={saving || triage === null || !dirty}>
            {saving ? 'Saving…' : 'Save'}
          </PrimaryButton>
        </>
      }
    >
      {triage === null ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : (
        <div className="space-y-5">
          {error !== null && <Notice tone="error" title="Could not save">{error}</Notice>}
          {reasonBlocked !== null && <Notice tone="warning" title="Mailbox disabled">{reasonBlocked}</Notice>}

          <CheckboxField
            label="Triage this mailbox"
            checked={enabled}
            onChange={setEnabled}
            disabled={!triage.accountEnabled}
          />

          <Notice tone={enabled ? 'warning' : 'info'} title={enabled ? 'This mailbox will be read' : 'This mailbox is not read'}>
            {enabled
              ? `New mail in ${triage.email} is read over IMAP, and its sender, subject and a short preview are sent to Jev to judge. A draft is only ever written into a card for you; nothing is sent, and nothing is deleted.`
              : 'Nothing is read, judged or moved while this is off. Turning it on only allows reading and drafting.'}
          </Notice>

          <Field label="What it may do" hint="Cards and drafts are always the limit; filing is the only extra action.">
            <Select
              value={mode}
              onChange={(event) => setMode(event.target.value === 'full' ? 'full' : 'important')}
              disabled={!enabled}
            >
              <option value="important">Cards and drafts only (nothing is moved)</option>
              <option value="full">Also file mail that needs no action</option>
            </Select>
          </Field>

          <Field label="Check for new mail" hint="A shorter interval costs more Jev calls.">
            <Select value={pollSeconds} onChange={(event) => setPollSeconds(event.target.value)} disabled={!enabled}>
              {POLL_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="File no-action mail into"
            hint="Leave blank to use the mailbox's own Junk folder. Mail is moved, never deleted."
          >
            <TextInput
              value={junkFolder}
              onChange={(event) => setJunkFolder(event.target.value)}
              placeholder="Junk"
              disabled={!enabled || mode !== 'full'}
            />
          </Field>

          <Field
            label="Always important"
            hint="One address per line (or @domain). These are never filed and never skipped by a rule."
          >
            <TextArea
              value={alwaysImportant}
              onChange={(event) => setAlwaysImportant(event.target.value)}
              rows={3}
              placeholder="mum@evoonline.co.uk"
              disabled={!enabled}
            />
          </Field>

          <Field
            label="Never file"
            hint="One address per line (or @domain). These may still be carded, but are never moved."
          >
            <TextArea
              value={neverJunk}
              onChange={(event) => setNeverJunk(event.target.value)}
              rows={3}
              placeholder="bank@example.com"
              disabled={!enabled}
            />
          </Field>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-slate-800 pt-3 text-[11px]">
            <dt className="text-slate-500">Cursor (uid)</dt>
            <dd className="text-slate-300">{triage.lastUid === 0 ? 'not started' : triage.lastUid}</dd>
            <dt className="text-slate-500">UIDVALIDITY</dt>
            <dd className="text-slate-300">{triage.uidValidity ?? '—'}</dd>
            <dt className="text-slate-500">Last changed</dt>
            <dd className="text-slate-300">{triage.updatedAt === null ? 'never' : formatTimestamp(triage.updatedAt)}</dd>
            <dt className="text-slate-500">Changed by</dt>
            <dd className="text-slate-300">{triage.updatedBy ?? '—'}</dd>
          </dl>
        </div>
      )}
    </Drawer>
  );
}
