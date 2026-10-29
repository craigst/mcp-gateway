import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { cx } from '../lib/cx.js';

export interface TabItem<K extends string> {
  key: K;
  label: string;
  /** Optional short secondary line (rendered next to the label). */
  hint?: string;
  badge?: ReactNode;
}

export interface TabsProps<K extends string> {
  items: readonly TabItem<K>[];
  active: K;
  onChange: (key: K) => void;
  /** Accessible name for the tablist, e.g. "Catalog sections". */
  label: string;
  className?: string;
}

/**
 * Horizontal, keyboard-accessible tab strip (roving tabindex + arrow keys).
 * Panels themselves are rendered by the owner via `TabPanel`.
 */
export function Tabs<K extends string>({ items, active, onChange, label, className }: TabsProps<K>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (index: number): void => {
    const item = items[index];
    if (!item) return;
    onChange(item.key);
    refs.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (items.length === 0) return;
    const currentIndex = Math.max(
      0,
      items.findIndex((item) => item.key === active),
    );
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        select((currentIndex + 1) % items.length);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        select((currentIndex - 1 + items.length) % items.length);
        break;
      case 'Home':
        event.preventDefault();
        select(0);
        break;
      case 'End':
        event.preventDefault();
        select(items.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cx('flex flex-wrap items-center gap-1 border-b border-slate-800', className)}
    >
      {items.map((item, index) => {
        const selected = item.key === active;
        return (
          <button
            key={item.key}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`tab-${item.key}`}
            aria-controls={`tabpanel-${item.key}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.key)}
            className={cx(
              'relative -mb-px inline-flex items-center gap-2 rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              selected
                ? 'border-sky-400 bg-slate-900/70 text-sky-200'
                : 'border-transparent text-slate-400 hover:bg-slate-900/50 hover:text-slate-200',
            )}
          >
            {item.label}
            {item.hint !== undefined && (
              <span className="hidden text-[11px] font-normal text-slate-500 sm:inline">{item.hint}</span>
            )}
            {item.badge !== undefined && (
              <span className="rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-slate-300">
                {item.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  /** Must match the `TabItem.key` it belongs to. */
  id: string;
  active: boolean;
  children: ReactNode;
  className?: string;
}

/** Renders only when active; provides the ARIA panel linkage for `Tabs`. */
export function TabPanel({ id, active, children, className }: TabPanelProps) {
  if (!active) return null;
  return (
    <div
      role="tabpanel"
      id={`tabpanel-${id}`}
      aria-labelledby={`tab-${id}`}
      className={className}
    >
      {children}
    </div>
  );
}
