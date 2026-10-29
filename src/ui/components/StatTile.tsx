import type { ReactNode } from 'react';
import { cx } from '../lib/cx.js';

export type StatTone = 'default' | 'success' | 'warning' | 'danger' | 'info';

const TONES: Record<StatTone, string> = {
  default: 'text-slate-100',
  success: 'text-emerald-300',
  warning: 'text-amber-300',
  danger: 'text-rose-300',
  info: 'text-sky-300',
};

export interface StatTileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: StatTone;
  className?: string;
}

/** Compact KPI tile for the dashboard. */
export function StatTile({ label, value, hint, tone = 'default', className }: StatTileProps) {
  return (
    <div
      className={cx(
        'rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 shadow-lg shadow-black/10',
        className,
      )}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p className={cx('mt-1 text-2xl font-semibold tabular-nums', TONES[tone])}>{value}</p>
      {hint !== undefined && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}
