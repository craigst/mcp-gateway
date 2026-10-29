import { cx } from '../lib/cx.js';

export interface SkeletonBlockProps {
  className?: string;
}

/** Shimmering placeholder block (already dark-theme tinted). */
export function SkeletonBlock({ className }: SkeletonBlockProps) {
  return <div aria-hidden="true" className={cx('animate-pulse rounded bg-slate-800/80', className)} />;
}

export interface SkeletonTableProps {
  rows?: number;
  columns?: number;
  label?: string;
}

/** Table-shaped loading skeleton used while an async list resolves. */
export function SkeletonTable({ rows = 4, columns = 4, label = 'Loading data…' }: SkeletonTableProps) {
  return (
    <div role="status" aria-label={label} className="space-y-2 px-4 py-4">
      <div className="flex gap-3">
        {Array.from({ length: columns }).map((_, index) => (
          <SkeletonBlock key={`head-${index}`} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={`row-${rowIndex}`} className="flex gap-3 rounded-lg border border-slate-800/60 px-3 py-3">
          {Array.from({ length: columns }).map((_, columnIndex) => (
            <SkeletonBlock key={`cell-${rowIndex}-${columnIndex}`} className="h-3 flex-1" />
          ))}
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

/** Card-grid loading skeleton (sources / harness cards). */
export function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <div role="status" aria-label="Loading cards…" className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <SkeletonBlock className="h-4 w-1/2" />
          <SkeletonBlock className="h-3 w-4/5" />
          <SkeletonBlock className="h-3 w-2/3" />
          <SkeletonBlock className="h-8 w-24" />
        </div>
      ))}
      <span className="sr-only">Loading cards…</span>
    </div>
  );
}
