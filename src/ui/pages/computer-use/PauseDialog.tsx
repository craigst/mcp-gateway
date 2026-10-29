import { useEffect, useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Field, TextArea, TextInput } from '../../components/Form.js';
import { Notice } from '../../components/States.js';
import type { ComputerUseAvailability } from '../../../core/types.js';

export interface PauseDialogValues {
  /** Operator-supplied reason, trimmed; `null` when left blank. */
  reason: string | null;
  /** ISO timestamp for auto-resume, or `null` for an open-ended pause. */
  until: string | null;
}

export interface PauseDialogProps {
  open: boolean;
  scope: 'global' | 'computer';
  /** Computer name for the per-computer dialog (ignored for the global scope). */
  computerName?: string;
  /** Existing pause to edit; `null`/omitted starts a fresh pause. */
  current?: ComputerUseAvailability | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (values: PauseDialogValues) => void;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `datetime-local` value in the browser's local timezone (empty for past/unset). */
function toLocalInput(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso.trim() === '') return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dialogTitle(scope: 'global' | 'computer', computerName: string | undefined, editing: boolean): string {
  if (editing) {
    return scope === 'global' ? 'Edit agent computer use pause' : `Edit agent use pause on ${computerName ?? 'computer'}`;
  }
  return scope === 'global' ? 'Pause agent computer use' : `Pause agent use on ${computerName ?? 'computer'}`;
}

/**
 * Reason + optional auto-resume form shared by the global and per-computer
 * availability controls. Submitting always means "pause"; resuming happens on
 * the page directly, with no form.
 */
export function PauseDialog({
  open,
  scope,
  computerName,
  current = null,
  busy,
  error,
  onCancel,
  onSubmit,
}: PauseDialogProps) {
  const [reason, setReason] = useState('');
  const [untilLocal, setUntilLocal] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setReason(current?.reason ?? '');
    setUntilLocal(toLocalInput(current?.until));
    setValidationError(null);
  }, [open, current]);

  const editing = current !== null && current.state === 'paused';

  const submit = (): void => {
    let until: string | null = null;
    if (untilLocal.trim() !== '') {
      const date = new Date(untilLocal);
      if (Number.isNaN(date.getTime())) {
        setValidationError('Enter a valid date and time, or leave the field empty.');
        return;
      }
      if (date.getTime() <= Date.now()) {
        setValidationError('Choose a time in the future, or leave the field empty to resume manually.');
        return;
      }
      until = date.toISOString();
    }
    setValidationError(null);
    const trimmed = reason.trim();
    onSubmit({ reason: trimmed === '' ? null : trimmed, until });
  };

  return (
    <ConfirmDialog
      open={open}
      title={dialogTitle(scope, computerName, editing)}
      size="md"
      tone="default"
      confirmLabel={editing ? 'Save pause' : 'Pause'}
      busy={busy}
      onConfirm={submit}
      onCancel={onCancel}
      description={
        scope === 'global'
          ? 'Every permitted computer-use call is refused with COMPUTER_USE_PAUSED. The pause applies to the whole broker fleet.'
          : `Agents keep the computer visible but every call to ${computerName ?? 'this computer'} is refused while paused.`
      }
    >
      <div className="space-y-4">
        {(validationError ?? error) !== null && (
          <Notice tone="error" title="Could not save the pause">
            {validationError ?? error}
          </Notice>
        )}
        <Field
          label="Reason (optional)"
          hint="Shown to operators in this console. Useful when several people share the gateway."
        >
          <TextArea
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. Pausing while presenting to a client — agents must not drive the desktop."
            maxLength={200}
          />
        </Field>
        <Field
          label="Auto-resume (optional)"
          hint="Local time. Leave empty to stay paused until you resume manually."
        >
          <TextInput
            type="datetime-local"
            value={untilLocal}
            onChange={(event) => setUntilLocal(event.target.value)}
          />
        </Field>
      </div>
    </ConfirmDialog>
  );
}
