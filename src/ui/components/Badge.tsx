import type { ReactNode } from 'react';
import { cx } from '../lib/cx.js';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-slate-700 bg-slate-800/80 text-slate-300',
  success: 'border-emerald-800 bg-emerald-950/70 text-emerald-300',
  warning: 'border-amber-800 bg-amber-950/70 text-amber-300',
  danger: 'border-rose-800 bg-rose-950/70 text-rose-300',
  info: 'border-sky-800 bg-sky-950/70 text-sky-300',
  accent: 'border-indigo-800 bg-indigo-950/70 text-indigo-300',
};

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}

export function Badge({ tone = 'neutral', children, className }: BadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Map server / audit / delegation status strings onto badge tones. */
export function badgeToneForStatus(status: string | null | undefined): BadgeTone {
  switch (status) {
    case 'running':
    case 'approved':
    case 'ok':
    case 'active':
    case 'online':
      return 'success';
    case 'starting':
    case 'stopping':
    case 'degraded':
    case 'pending':
      return 'warning';
    case 'failed':
    case 'denied':
    case 'error':
    case 'revoked':
    case 'offline':
      return 'danger';
    case 'stopped':
    case 'expired':
      return 'neutral';
    default:
      return 'neutral';
  }
}
