import { cx } from '../lib/cx.js';

export interface JsonViewerProps {
  value: unknown;
  emptyLabel?: string;
  className?: string;
  maxHeight?: string;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Syntax-neutral pretty-printed JSON block. */
export function JsonViewer({ value, emptyLabel = 'No payload', className, maxHeight = '22rem' }: JsonViewerProps) {
  if (value === undefined || value === null) {
    return <p className="text-xs italic text-slate-500">{emptyLabel}</p>;
  }
  return (
    <pre
      className={cx(
        'terminal-scroll overflow-auto rounded-lg border border-slate-800 bg-slate-950/80 p-3 text-[11.5px] leading-relaxed text-slate-300 font-mono whitespace-pre-wrap break-words',
        className,
      )}
      style={{ maxHeight }}
    >
      {stringify(value)}
    </pre>
  );
}
