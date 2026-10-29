import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../lib/cx.js';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T, index: number) => ReactNode;
  className?: string;
  headerClassName?: string;
}

export interface TableProps<T> {
  columns: ReadonlyArray<Column<T>>;
  rows: readonly T[];
  getRowKey: (row: T, index: number) => string;
  empty?: ReactNode;
  loading?: boolean;
  /** Optional expandable detail row; pair with `onRowClick` + `expandedKey`. */
  renderExpanded?: (row: T) => ReactNode;
  expandedKey?: string | null;
  onRowClick?: (row: T) => void;
  className?: string;
}

/** Generic, dependency-free data table with optional expandable rows. */
export function Table<T>({
  columns,
  rows,
  getRowKey,
  empty,
  loading = false,
  renderExpanded,
  expandedKey = null,
  onRowClick,
  className,
}: TableProps<T>) {
  if (loading) {
    return <div className="px-4 py-8 text-sm text-slate-400">Loading…</div>;
  }
  if (rows.length === 0) {
    return <>{empty ?? <div className="px-4 py-8 text-sm text-slate-400">No records</div>}</>;
  }

  const expandable = renderExpanded !== undefined && onRowClick !== undefined;

  return (
    <div className={cx('overflow-x-auto', className)}>
      <table className="min-w-full divide-y divide-slate-800 text-left text-sm">
        <thead className="bg-slate-900/70">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cx(
                  'px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400',
                  column.headerClassName,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/70">
          {rows.map((row, index) => {
            const key = getRowKey(row, index);
            const isExpanded = renderExpanded !== undefined && expandedKey === key;
            return (
              <Fragment key={key}>
                <tr
                  className={cx(
                    'transition-colors hover:bg-slate-800/40',
                    expandable && 'cursor-pointer',
                  )}
                  onClick={expandable ? () => onRowClick?.(row) : undefined}
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cx('px-4 py-2.5 align-top text-slate-300', column.className)}
                    >
                      {column.render(row, index)}
                    </td>
                  ))}
                </tr>
                {isExpanded && renderExpanded !== undefined && (
                  <tr className="bg-slate-900/50">
                    <td colSpan={columns.length} className="px-4 py-3">
                      {renderExpanded(row)}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
