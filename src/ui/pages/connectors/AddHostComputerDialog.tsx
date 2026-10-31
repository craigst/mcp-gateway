import { useEffect, useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Notice } from '../../components/States.js';
import { Badge } from '../../components/Badge.js';
import { CopyButton } from '../../components/CopyButton.js';
import { Field, TextInput, buttonSecondary } from '../../components/Form.js';
import { cx } from '../../lib/cx.js';
import { formatTimestamp } from '../../lib/format.js';
import { useToast } from '../../components/Toasts.js';
import type { ComputerUseHostComputer } from '../../../core/types.js';
import { safeExternalUrl } from './shared.js';

export interface AddHostComputerDialogProps {
  open: boolean;
  onClose: () => void;
  /** Refresh the host list (called once the installer has been minted). */
  onCreated: () => void;
}

/**
 * "Add physical computer" wizard. Two phases:
 *  1. name — one field, validated locally;
 *  2. installer — the single bash command the operator runs on the PC, with
 *     clipboard copy, expiry and CA link, plus the run/single-use/systemd
 *     warnings. The list refreshes as soon as the host record is created.
 */
export function AddHostComputerDialog({ open, onClose, onCreated }: AddHostComputerDialogProps) {
  const toast = useToast();
  const [name, setName] = useState('studio-pc');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ComputerUseHostComputer | null>(null);
  const [createdName, setCreatedName] = useState('studio-pc');

  useEffect(() => {
    if (!open) return;
    setName('studio-pc');
    setBusy(false);
    setError(null);
    setResult(null);
    setCreatedName('studio-pc');
  }, [open]);

  const trimmedName = name.trim();
  const nameInvalid = trimmedName.length === 0;

  const submit = async (): Promise<void> => {
    if (nameInvalid) {
      setError('Give the computer a name first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.createHostComputer(trimmedName);
      setCreatedName(trimmedName);
      setResult(created);
      toast('info', `Installer for ${trimmedName} ready — run it on the PC to connect it.`);
      // The host computer record now exists (offline until the connector dials in).
      onCreated();
    } catch (submitError) {
      setError(formatApiError(submitError));
    } finally {
      setBusy(false);
    }
  };

  const install = result?.install ?? null;
  const caUrl = install === null ? null : safeExternalUrl(install.caUrl);
  const command = install?.command ?? '';

  return (
    <ConfirmDialog
      open={open}
      title="Add physical computer"
      description={
        result === null
          ? 'Create a host computer and generate the one-line installer for its desktop session.'
          : 'Run the command on the PC. Its connector dials out to the broker and the computer appears in the list above.'
      }
      size="lg"
      busy={busy}
      confirmLabel={result === null ? 'Create install command' : 'Done'}
      cancelLabel={result === null ? 'Cancel' : 'Close'}
      confirmDisabled={result === null && nameInvalid}
      onConfirm={() => {
        if (busy) return;
        if (result === null) void submit();
        else onClose();
      }}
      onCancel={() => {
        if (busy) return;
        onClose();
      }}
    >
      <div className="space-y-4">
        {result === null ? (
          <>
            <Field
              label="Computer name"
              hint="Shown in the Computer Use fleet and in the generated installer command."
            >
              <TextInput
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="studio-pc"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
            </Field>

            <Notice tone="info" title="What this creates">
              A host computer running the Computer Broker connector in remote-desktop mode for this
              PC&apos;s graphical session (Wayland, X11 screenshots fall back where needed). The
              one-line command is shown once, with a single-use token.
            </Notice>

            {error !== null && (
              <Notice tone="error" title="Could not create the install command" onDismiss={() => setError(null)}>
                {error}
              </Notice>
            )}
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="success">installer ready</Badge>
              <span className="text-[11px] text-slate-500">
                for <span className="font-semibold text-slate-300">{createdName}</span> · token expires{' '}
                {formatTimestamp(install?.expiresAt)}
              </span>
            </div>

            <div>
              <p className="mb-1 text-xs font-medium text-slate-300">Run this on the PC</p>
              <pre
                aria-label="Physical computer install command"
                className="max-h-40 overflow-auto rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-sky-200 whitespace-pre-wrap break-all"
              >
                {command}
              </pre>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <CopyButton value={command} label="Copy install command" />
                {caUrl !== null ? (
                  <a
                    href={caUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={cx(buttonSecondary, 'px-3 py-1.5 text-xs')}
                  >
                    Download broker CA ↗
                  </a>
                ) : (
                  <span className="font-mono text-[10px] text-slate-500">CA: {install?.caUrl ?? '—'}</span>
                )}
              </div>
            </div>

            <Notice tone="warning" title="Before you run it">
              <ul className="list-disc space-y-1 pl-4">
                <li>Run it on the PC itself, in its graphical desktop session — not over SSH.</li>
                <li>
                  The enrollment token is <strong>single-use</strong> and expires in about 15 minutes;
                  the command is shown only once.
                </li>
                <li>
                  It installs the computer-broker connector and starts it as a{' '}
                  <span className="font-mono">systemd --user</span> service that reconnects
                  automatically (and can later be updated from this page).
                </li>
                <li>The PC appears below and in the Computer Use fleet once the connector is online.</li>
              </ul>
            </Notice>

            {error !== null && (
              <Notice tone="error" title="Installer error" onDismiss={() => setError(null)}>
                {error}
              </Notice>
            )}
          </>
        )}
      </div>
    </ConfirmDialog>
  );
}
