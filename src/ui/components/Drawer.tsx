import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../lib/cx.js';

export type DrawerSize = 'md' | 'lg' | 'xl';

const SIZES: Record<DrawerSize, string> = {
  md: 'max-w-xl',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
};

export interface DrawerProps {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: DrawerSize;
}

/**
 * Right-hand detail panel (used for the server policy view).
 * Escape closes it; focus moves into the panel on open.
 */
export function Drawer({ open, title, subtitle, onClose, children, footer, size = 'lg' }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = 'drawer-title';

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/70 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          'flex h-full w-full flex-col border-l border-slate-800 bg-slate-950 shadow-2xl shadow-black/60 outline-none',
          SIZES[size],
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-800 px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-base font-semibold text-slate-100">
              {title}
            </h2>
            {subtitle !== undefined && <div className="mt-0.5 text-xs text-slate-400">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="rounded-lg border border-slate-700 px-2 py-1 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-800"
          >
            ✕
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer !== undefined && (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-800 px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
