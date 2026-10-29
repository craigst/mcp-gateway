import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../lib/cx.js';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

type PushToast = (tone: ToastTone, message: string) => void;

const ToastContext = createContext<PushToast | null>(null);

const TONE_CLASS: Record<ToastTone, string> = {
  success: 'border-emerald-800 bg-emerald-950/95 text-emerald-200',
  error: 'border-rose-800 bg-rose-950/95 text-rose-200',
  info: 'border-sky-800 bg-sky-950/95 text-sky-200',
};

const TONE_ICON: Record<ToastTone, string> = {
  success: '✓',
  error: '!',
  info: 'i',
};

const noop: PushToast = () => {};

/**
 * Lightweight toast provider. Pages rendered inside the console shell get
 * a fixed toast stack; standalone pages silently fall back to inline feedback.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.length = 0;
    };
  }, []);

  const remove = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback<PushToast>(
    (tone, message) => {
      if (message.trim() === '') return;
      counter.current += 1;
      const id = counter.current;
      setToasts((current) => [...current.slice(-3), { id, tone, message }]);
      const timer = setTimeout(() => remove(id), tone === 'error' ? 9000 : 5000);
      timers.current.push(timer);
    },
    [remove],
  );

  const value = useMemo(() => pushToast, [pushToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={cx(
              'pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-xs shadow-xl shadow-black/40 backdrop-blur',
              TONE_CLASS[toast.tone],
            )}
          >
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current text-[10px] font-bold"
            >
              {TONE_ICON[toast.tone]}
            </span>
            <p className="flex-1 whitespace-pre-wrap break-words">{toast.message}</p>
            <button
              type="button"
              onClick={() => remove(toast.id)}
              aria-label="Dismiss notification"
              className="shrink-0 text-[11px] opacity-70 transition-opacity hover:opacity-100"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Push a toast. No-op when rendered outside `<ToastProvider>`. */
export function useToast(): PushToast {
  return useContext(ToastContext) ?? noop;
}
