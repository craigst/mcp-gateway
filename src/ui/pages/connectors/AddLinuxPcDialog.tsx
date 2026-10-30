import { useEffect, useRef, useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Notice } from '../../components/States.js';
import { Badge } from '../../components/Badge.js';
import { CopyButton } from '../../components/CopyButton.js';
import {
  CheckboxField,
  Field,
  TextInput,
  buttonSecondary,
} from '../../components/Form.js';
import { cx } from '../../lib/cx.js';
import { formatTimestamp } from '../../lib/format.js';
import { useToast } from '../../components/Toasts.js';
import type { ComputerUseEnrollmentResponse } from '../../../core/types.js';
import {
  DEFAULT_PAIRING_MINUTES,
  MAX_PAIRING_MINUTES,
  MIN_PAIRING_MINUTES,
  parsePairingMinutes,
  relativeTime,
  safeExternalUrl,
} from './shared.js';

/** Poll interval for "has the machine connected yet?" while the dialog is open. */
const PAIRING_POLL_MS = 3_000;

export interface AddLinuxPcDialogProps {
  open: boolean;
  /** Device ids already known when the dialog opened (used to detect the new one). */
  initialDeviceIds: readonly string[];
  onClose: () => void;
  /** Called once with the newly appeared connector; the page refreshes + toasts. */
  onConnected: (device: { id: string; name: string }) => void;
}

/**
 * "Add a Linux PC" pairing wizard. Two phases:
 *  1. form — name, optional interactive terminal policy, pairing lifetime;
 *  2. install — the returned one-line command, expiry/CA links, and a 3 s poll
 *     that notices when the new connector appears in the device list.
 * Closing phase 2 keeps the pairing pending; "Ignore this pairing" revokes it.
 */
export function AddLinuxPcDialog({
  open,
  initialDeviceIds,
  onClose,
  onConnected,
}: AddLinuxPcDialogProps) {
  const toast = useToast();
  const [name, setName] = useState('linux-pc');
  const [allowTerminal, setAllowTerminal] = useState(false);
  const [minutes, setMinutes] = useState(String(DEFAULT_PAIRING_MINUTES));
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ComputerUseEnrollmentResponse | null>(null);
  const [createdName, setCreatedName] = useState('linux-pc');

  const baselineRef = useRef<Set<string>>(new Set());
  const initialIdsRef = useRef(initialDeviceIds);
  initialIdsRef.current = initialDeviceIds;
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  // Reset the wizard each time it opens and freeze the "already known" device set.
  useEffect(() => {
    if (!open) return;
    setName('linux-pc');
    setAllowTerminal(false);
    setMinutes(String(DEFAULT_PAIRING_MINUTES));
    setBusy(false);
    setRevoking(false);
    setError(null);
    setResult(null);
    setCreatedName('linux-pc');
    baselineRef.current = new Set(initialIdsRef.current);
  }, [open]);

  // While a token is live, check every 3 s whether a device we have never seen
  // before has dialled in. Pause while the tab is hidden; check once on return.
  useEffect(() => {
    if (!open || result === null) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const check = async (): Promise<void> => {
      if (disposed) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      try {
        const next = await api.getComputerUseConnectors();
        if (disposed) return;
        const fresh = next.devices.find((device) => !baselineRef.current.has(device.id));
        if (fresh !== undefined) {
          disposed = true;
          if (timer !== null) clearInterval(timer);
          onConnectedRef.current({ id: fresh.id, name: fresh.name });
        }
      } catch {
        // The waiting state stays quiet; an explicit refresh surfaces transport errors.
      }
    };

    void check();
    timer = setInterval(() => void check(), PAIRING_POLL_MS);
    const onVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') void check();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    return () => {
      disposed = true;
      if (timer !== null) clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [open, result]);

  const parsedMinutes = parsePairingMinutes(minutes);
  const invalidMinutes = parsedMinutes === null;

  const submit = async (): Promise<void> => {
    if (parsedMinutes === null) {
      setError(`Pairing lifetime must be a whole number of minutes between ${MIN_PAIRING_MINUTES} and ${MAX_PAIRING_MINUTES}.`);
      return;
    }
    const machineName = name.trim() === '' ? 'linux-pc' : name.trim();
    setBusy(true);
    setError(null);
    try {
      const created = await api.createComputerUseEnrollment({
        kind: 'device',
        name: machineName,
        ttlSeconds: parsedMinutes * 60,
        allowTerminal,
      });
      setCreatedName(machineName);
      setResult(created);
      toast('info', `Pairing token for ${machineName} created. Run the command on the machine to connect it.`);
    } catch (submitError) {
      setError(formatApiError(submitError));
    } finally {
      setBusy(false);
    }
  };

  const ignore = async (): Promise<void> => {
    if (result === null) {
      onClose();
      return;
    }
    setRevoking(true);
    setError(null);
    try {
      await api.revokeComputerUseEnrollment(result.enrollment.id);
      toast('info', `Pairing for ${createdName} ignored; the token was revoked.`);
      onClose();
    } catch (revokeError) {
      setError(formatApiError(revokeError));
    } finally {
      setRevoking(false);
    }
  };

  const working = busy || revoking;
  const install = result?.install ?? null;
  const caUrl = install === null ? null : safeExternalUrl(install.caUrl);
  const copyValue = install?.command ?? '';

  return (
    <ConfirmDialog
      open={open}
      title="Add a Linux PC"
      description={
        result === null
          ? 'Mint a single-use pairing token and generate the one-line installer for a Linux machine.'
          : 'Run the command on the machine. The pairing is claimed once, when its connector first dials out.'
      }
      size="lg"
      busy={working}
      confirmLabel={result === null ? 'Generate pairing' : 'Close'}
      cancelLabel={result === null ? 'Cancel' : 'Ignore this pairing'}
      confirmDisabled={result === null && invalidMinutes}
      onConfirm={() => {
        if (working) return;
        if (result === null) void submit();
        else onClose();
      }}
      onCancel={() => {
        if (working) return;
        if (result === null) onClose();
        else void ignore();
      }}
    >
      <div className="space-y-4">
        {result === null ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Machine name"
                hint="Used as the connector label and in the generated install command."
              >
                <TextInput
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="linux-pc"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={working}
                />
              </Field>
              <Field
                label="Pairing lifetime (minutes)"
                hint={`Between ${MIN_PAIRING_MINUTES} and ${MAX_PAIRING_MINUTES} minutes (24 h).`}
                error={invalidMinutes && minutes.trim() !== '' ? 'Enter a whole number in range.' : undefined}
              >
                <TextInput
                  type="number"
                  inputMode="numeric"
                  min={MIN_PAIRING_MINUTES}
                  max={MAX_PAIRING_MINUTES}
                  step={1}
                  value={minutes}
                  onChange={(event) => setMinutes(event.target.value)}
                  disabled={working}
                />
              </Field>
            </div>

            <CheckboxField
              label={
                <span>
                  Allow interactive terminal (<span className="font-mono">terminal.enabled=true</span>)
                </span>
              }
              checked={allowTerminal}
              onChange={setAllowTerminal}
              disabled={working}
            />
            <Notice tone="warning" title="Interactive terminal is a real shell">
              Enabling it lets this console run commands as the connector&apos;s user on the machine,
              through the broker. Leave it off unless you trust every operator with access to this
              console for that machine.
            </Notice>

            {error !== null && (
              <Notice tone="error" title="Could not create the pairing" onDismiss={() => setError(null)}>
                {error}
              </Notice>
            )}
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="success">pairing created</Badge>
              <Badge tone={install?.allowTerminal === true ? 'warning' : 'neutral'}>
                {install?.allowTerminal === true ? 'terminal enabled' : 'terminal disabled'}
              </Badge>
              <span className="text-[11px] text-slate-500">
                token expires {formatTimestamp(install?.expiresAt)}
              </span>
            </div>

            <div>
              <p className="mb-1 text-xs font-medium text-slate-300">
                Run this on the Linux PC
              </p>
              <pre className="max-h-40 overflow-auto rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-sky-200 whitespace-pre-wrap break-all">
                {copyValue}
              </pre>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <CopyButton value={copyValue} label="Copy install command" />
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
                  <span className="font-mono text-[10px] text-slate-500">
                    CA: {install?.caUrl ?? '—'}
                  </span>
                )}
              </div>
            </div>

            <dl className="grid gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-[11px] sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Broker URL</dt>
                <dd className="mt-0.5 break-all font-mono text-slate-300">{install?.brokerUrl ?? '—'}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Connector URL</dt>
                <dd className="mt-0.5 break-all font-mono text-slate-300">{install?.connectorUrl ?? '—'}</dd>
              </div>
            </dl>

            <div role="status" className="flex items-start gap-2 rounded-lg border border-sky-900/60 bg-sky-950/30 px-3 py-2 text-xs text-sky-200">
              <span
                aria-hidden="true"
                className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-sky-800 border-t-sky-300"
              />
              <div className="min-w-0 space-y-0.5">
                <p className="font-semibold">Waiting for {createdName} to connect…</p>
                <p className="text-[11px] text-sky-300/80">
                  Checking every 3 s while this dialog is open. The token is claimed once; it expires{' '}
                  {relativeTime(install?.expiresAt)} ({formatTimestamp(install?.expiresAt)}).
                </p>
              </div>
            </div>

            {error !== null && (
              <Notice tone="error" title="Could not revoke the pairing" onDismiss={() => setError(null)}>
                {error}
              </Notice>
            )}

            <p className="text-[11px] text-slate-500">
              Closing this dialog keeps the pairing pending — revoke it from the Pending pairings list.
              The command is shown once; the token cannot be recovered.
            </p>
          </>
        )}
      </div>
    </ConfirmDialog>
  );
}
