import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { Badge } from '../../components/Badge.js';
import { ErrorState, LoadingState, Notice } from '../../components/States.js';
import { PrimaryButton, SecondaryButton, TextInput } from '../../components/Form.js';
import { cx } from '../../lib/cx.js';
import type { ComputerUseDeviceInfo } from '../../../core/types.js';
import { deviceStateTone } from './shared.js';

/** Output read poll interval. */
const TERMINAL_POLL_MS = 1_500;
/** Rows requested when opening the session; the PTY is a normal 120×30 shell. */
const TERMINAL_ROWS = 30;
const TERMINAL_COLS = 120;
/** Output buffer requested per read. */
const TERMINAL_READ_LINES = 500;

export interface TerminalDialogProps {
  device: ComputerUseDeviceInfo | null;
  onClose: () => void;
}

type Phase = 'opening' | 'ready' | 'error';

/**
 * Interactive terminal over the broker's `term.*` device ops. The session opens
 * when the dialog appears, output is polled every ~1.5 s (500-line buffer,
 * long-poll `waitSeconds=1`), and the session is closed on unmount/close so no
 * shell is left behind. Errors (e.g. terminal policy disabled) are shown in
 * place; the dialog never closes itself on failure.
 */
export function TerminalDialog({ device, onClose }: TerminalDialogProps) {
  const deviceId = device?.id ?? null;
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>('opening');
  const [session, setSession] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const sessionRef = useRef<string | null>(null);
  const outputRef = useRef<HTMLPreElement | null>(null);

  const readOutput = useCallback(async (targetDeviceId: string, sessionId: string): Promise<void> => {
    const result = await api.readComputerUseTerminal(targetDeviceId, {
      session: sessionId,
      lines: TERMINAL_READ_LINES,
      waitSeconds: 1,
    });
    setLines((current) => {
      const next = result.lines;
      const unchanged =
        current.length === next.length && current.every((line, index) => line === next[index]);
      return unchanged ? current : next;
    });
  }, []);

  // Open the session when the dialog appears; close it when the dialog goes away.
  useEffect(() => {
    if (deviceId === null) return undefined;
    let cancelled = false;
    setPhase('opening');
    setSession(null);
    setLines([]);
    setError(null);
    setInput('');
    setSending(false);

    const open = async (): Promise<void> => {
      try {
        const sessionId = await api.openComputerUseTerminal(deviceId, {
          rows: TERMINAL_ROWS,
          cols: TERMINAL_COLS,
        });
        if (cancelled) {
          void api.closeComputerUseTerminal(deviceId, sessionId).catch(() => undefined);
          return;
        }
        sessionRef.current = sessionId;
        setSession(sessionId);
        setPhase('ready');
        await readOutput(deviceId, sessionId).catch((readError: unknown) => {
          if (!cancelled) setError(formatApiError(readError));
        });
      } catch (openError) {
        if (!cancelled) {
          setPhase('error');
          setError(formatApiError(openError));
        }
      }
    };
    void open();

    return () => {
      cancelled = true;
      const openSession = sessionRef.current;
      sessionRef.current = null;
      if (openSession !== null) {
        void api.closeComputerUseTerminal(deviceId, openSession).catch(() => undefined);
      }
    };
  }, [deviceId, attempt, readOutput]);

  // Poll the output buffer while the session is open; pause while the tab is hidden.
  useEffect(() => {
    if (deviceId === null || session === null || phase !== 'ready') return undefined;
    let disposed = false;

    const poll = async (): Promise<void> => {
      if (disposed) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      try {
        await readOutput(deviceId, session);
      } catch {
        // Transient read failures keep the last output; explicit errors are shown elsewhere.
      }
    };

    const timer = setInterval(() => void poll(), TERMINAL_POLL_MS);
    const onVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') void poll();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    return () => {
      disposed = true;
      clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [deviceId, session, phase, readOutput]);

  // Keep the newest output in view.
  useEffect(() => {
    const element = outputRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [lines]);

  if (device === null) return null;

  const ready = phase === 'ready' && session !== null;

  const send = async (value: string, enter: boolean, clearCommand: boolean): Promise<void> => {
    if (deviceId === null || session === null || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.sendComputerUseTerminal(deviceId, { session, input: value, enter });
      if (clearCommand) setInput('');
      await readOutput(deviceId, session).catch((readError: unknown) => {
        setError(formatApiError(readError));
      });
    } catch (sendError) {
      setError(formatApiError(sendError));
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/80 p-4 backdrop-blur-sm sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Terminal — ${device.name}`}
        className="w-full max-w-4xl rounded-xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/50"
      >
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold text-slate-100">
              Terminal — {device.name}
            </h2>
            <Badge tone={deviceStateTone(device.state)}>{device.state}</Badge>
            {device.terminalCapable && <Badge tone="accent">terminal</Badge>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close terminal"
            className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-800"
          >
            ✕
          </button>
        </header>

        <div className="space-y-3 px-5 py-4">
          {phase === 'opening' && <LoadingState label="Opening terminal session…" />}

          {phase === 'error' && (
            <ErrorState message={error ?? 'The terminal session could not be opened.'} onRetry={() => setAttempt((current) => current + 1)} />
          )}

          {phase === 'ready' && (
            <>
              <div className="overflow-hidden rounded-lg border border-slate-700 bg-slate-950">
                <pre
                  ref={outputRef}
                  aria-label={`Terminal output from ${device.name}`}
                  className={cx(
                    'h-80 w-full overflow-y-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed text-slate-200',
                    lines.length === 0 && 'text-slate-500',
                  )}
                >
                  {lines.length === 0
                    ? 'No output yet — type a command below.'
                    : lines.join('\n')}
                </pre>
              </div>

              {error !== null && (
                <Notice tone="error" title="Terminal error" onDismiss={() => setError(null)}>
                  {error}
                </Notice>
              )}

              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send(input, true, true);
                }}
              >
                <TextInput
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  aria-label="Terminal command"
                  placeholder="Type a command and press Enter"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!ready || sending}
                  className="min-w-0 flex-1 font-mono text-xs"
                />
                <PrimaryButton type="submit" disabled={!ready || sending} className="px-3 py-1.5 text-xs">
                  {sending ? 'Sending…' : 'Send'}
                </PrimaryButton>
                <SecondaryButton
                  onClick={() => void send('\u0003', false, false)}
                  disabled={!ready || sending}
                  title="Send SIGINT (Ctrl+C) to the running command"
                  className="px-3 py-1.5 text-xs"
                >
                  Ctrl+C
                </SecondaryButton>
              </form>

              <p className="text-[11px] text-slate-500">
                {session !== null && (
                  <>
                    Session <span className="font-mono text-slate-400">{session}</span> ·{' '}
                  </>
                )}
                Output refreshes every 1.5 s while this dialog is open. Closing it ends the shell on
                the machine.
              </p>
            </>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 px-5 py-3">
          <p className="text-[11px] text-slate-500">
            Commands run as the connector user on {device.name} — through the broker, never directly.
          </p>
          <SecondaryButton onClick={onClose} className="px-3 py-1.5 text-xs">
            Close
          </SecondaryButton>
        </footer>
      </div>
    </div>
  );
}
