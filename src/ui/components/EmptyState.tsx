import type { ReactNode } from 'react';
import { cx } from '../lib/cx.js';

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Placeholder for empty collections / disabled features. */
export function EmptyState({ title, description, icon = '∅', action, className }: EmptyStateProps) {
  return (
    <div className={cx('flex flex-col items-center justify-center gap-2 px-4 py-10 text-center', className)}>
      <span aria-hidden="true" className="text-2xl text-slate-600">
        {icon}
      </span>
      <p className="text-sm font-medium text-slate-300">{title}</p>
      {description !== undefined && <p className="max-w-md text-xs text-slate-500">{description}</p>}
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}
