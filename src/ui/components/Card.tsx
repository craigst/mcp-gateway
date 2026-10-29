import type { ReactNode } from 'react';
import { cx } from '../lib/cx.js';

export interface CardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  padded?: boolean;
}

/** Panel surface used by every console view. */
export function Card({ title, subtitle, actions, children, className, padded = true }: CardProps) {
  return (
    <section
      className={cx(
        'rounded-xl border border-slate-800 bg-slate-900/60 shadow-lg shadow-black/20',
        className,
      )}
    >
      {(title !== undefined || actions !== undefined) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div className="min-w-0">
            {title !== undefined && (
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-200">{title}</h2>
            )}
            {subtitle !== undefined && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
          </div>
          {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}
