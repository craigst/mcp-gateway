import type { ReactNode } from 'react';

/** Loading / error / inline notice primitives. */
export interface LoadingStateProps {
  label?: string;
}

export function LoadingState({ label = 'Loading…' }: LoadingStateProps) {
  return (
    <div role="status" className="flex items-center gap-3 px-4 py-8 text-sm text-slate-400">
      <span
        aria-hidden="true"
        className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-sky-400"
      />
      {label}
    </div>
  );
}

export interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-900/60 bg-rose-950/30 px-4 py-4">
      <div>
        <p className="text-sm font-semibold text-rose-200">Request failed</p>
        <p className="mt-0.5 max-w-2xl text-xs text-rose-300/80">{message}</p>
      </div>
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-rose-800 px-3 py-1.5 text-xs font-semibold text-rose-200 transition-colors hover:bg-rose-900/40"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function InlineNotice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
      {children}
    </p>
  );
}
