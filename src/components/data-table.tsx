'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Inbox } from 'lucide-react';
import { cn } from '@/components/ui';
import { SearchInput } from '@/components/filters';

// --- Formatting -------------------------------------------------------------
// Money is integer cents and rates are integer parts-per-million everywhere in
// the schema. Divide only here, at the render boundary, never in a query.

/**
 * `129900` → `$1,299.00`. Pass integer cents; never a float.
 *
 * `symbol` display is the default so a mixed-currency table distinguishes
 * `US$2,500.00` from `$2,500.00`. Pass `hideCurrencyCode` for axis ticks, where
 * the currency is already stated once in the chart title.
 */
export function formatCents(
  cents: number,
  currency = 'CAD',
  options: { compact?: boolean; hideCurrencyCode?: boolean } = {},
): string {
  const formatter = new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    currencyDisplay: options.hideCurrencyCode ? 'narrowSymbol' : 'symbol',
    notation: options.compact ? 'compact' : 'standard',
    maximumFractionDigits: options.compact ? 1 : 2,
    minimumFractionDigits: options.compact ? 0 : 2,
  });
  return formatter.format(cents / 100);
}

/**
 * Parts per million → a percentage. `1_000_000` is 100%.
 *
 * `50000` → `5%` · `130000` → `13%` · `99750` → `9.975%` (QST).
 *
 * The scaling happens in integer space on purpose: `99750 / 10000` lands on a
 * double just below 9.975, so `toFixed` would round Quebec's rate down to
 * `9.97%`. Trailing zeros are trimmed, so whole rates read as whole numbers.
 */
export function formatPercentParts(parts: number, fractionDigits = 3): string {
  const scale = 10 ** fractionDigits;
  const rounded = Math.round((parts * scale) / 10_000) / scale;
  return `${rounded}%`;
}

/** `18432` → `18,432`. */
export function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-CA', { maximumFractionDigits: 0 }).format(value);
}

/** `18432` → `18.4K`. For axis ticks and tight stat tiles. */
export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat('en-CA', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

// --- Columns ----------------------------------------------------------------

export type ColumnAlign = 'left' | 'center' | 'right';

export interface Column<T> {
  /** Unique id. Doubles as the property read for sorting when `sortValue` is absent. */
  key: string;
  header: ReactNode;
  /** Cell contents. Defaults to the raw property at `key`, stringified. */
  render?: (row: T, index: number) => ReactNode;
  /**
   * Comparable value for this column. Supply it whenever `render` returns
   * something other than the raw value — sorting a formatted `"$1,299.00"`
   * string sorts alphabetically, which is wrong.
   */
  sortValue?: (row: T) => string | number | Date | boolean | null | undefined;
  /** Text the search box matches against. Defaults to the sort value. */
  searchText?: (row: T) => string;
  sortable?: boolean;
  /** Right-aligns and applies `tabular-nums` so digits line up down the column. */
  numeric?: boolean;
  align?: ColumnAlign;
  /** Any CSS width, e.g. `'8rem'` or `'20%'`. */
  width?: string;
  /** Keep the header for assistive tech but hide it visually (icon-only columns). */
  headerSrOnly?: boolean;
  /** Drop the column on narrow screens instead of forcing a horizontal scroll. */
  hideBelow?: 'sm' | 'md' | 'lg';
  className?: string;
}

const HIDE_BELOW: Record<NonNullable<Column<unknown>['hideBelow']>, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
};

export interface SortState {
  key: string;
  direction: 'asc' | 'desc';
}

export interface DataTableEmpty {
  title: string;
  description: string;
  icon?: ReactNode;
  action?: ReactNode;
}

export interface DataTableProps<T> {
  rows: readonly T[];
  columns: readonly Column<T>[];
  /** Stable identity per row — a database id, not the array index. */
  rowKey: (row: T, index: number) => string;
  /** Announced to screen readers before the table. Say what the rows are. */
  caption: string;
  /** Swaps the body for a skeleton without collapsing the layout. */
  loading?: boolean;
  skeletonRows?: number;
  /** Shows the built-in search box, matching across every column's text. */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Rows per page. Omit or pass `0` to render every row. */
  pageSize?: number;
  initialSort?: SortState;
  /** Called on click and on Enter/Space when the row has keyboard focus. */
  onRowClick?: (row: T, index: number) => void;
  /** Highlights a row as current — pair it with `onRowClick` and a `<Drawer>`. */
  isRowActive?: (row: T) => boolean;
  empty?: DataTableEmpty;
  /** Extra controls on the toolbar row, right of the search box. */
  toolbar?: ReactNode;
  /** Rendered below the last row, inside the scroll container — totals, usually. */
  footer?: ReactNode;
  /** Keeps the header visible while the body scrolls. Needs `maxHeight`. */
  stickyHeader?: boolean;
  /** Any CSS height, e.g. `'32rem'`. Turns the table body into a scroll area. */
  maxHeight?: string;
  /** Tighter row padding for dense operational tables. */
  dense?: boolean;
  className?: string;
}

// --- Sorting ----------------------------------------------------------------

function readValue<T>(row: T, column: Column<T>): unknown {
  if (column.sortValue) return column.sortValue(row);
  if (row && typeof row === 'object') return (row as Record<string, unknown>)[column.key];
  return undefined;
}

function toComparable(value: unknown): string | number | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return String(value);
}

/** Nulls always sort last, in both directions — an absent value is not "smallest". */
function compareValues(a: unknown, b: unknown, direction: 'asc' | 'desc'): number {
  const left = toComparable(a);
  const right = toComparable(b);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;

  const sign = direction === 'asc' ? 1 : -1;
  if (typeof left === 'number' && typeof right === 'number') return (left - right) * sign;
  return String(left).localeCompare(String(right), 'en-CA', { numeric: true }) * sign;
}

function searchTextFor<T>(row: T, columns: readonly Column<T>[]): string {
  const parts: string[] = [];
  for (const column of columns) {
    if (column.searchText) {
      parts.push(column.searchText(row));
      continue;
    }
    const value = readValue(row, column);
    if (value === null || value === undefined) continue;
    parts.push(value instanceof Date ? value.toISOString() : String(value));
  }
  // Newline separator: search terms are split on whitespace, so a term can
  // never straddle two columns and produce a phantom match.
  return parts.join('\n').toLowerCase();
}

// --- Component --------------------------------------------------------------

/**
 * The table every list view in the console and the dashboard is built from:
 * invoices, payments, tickets, agents, applications, webhook deliveries.
 *
 * Sorting, searching and paging all happen on the client, over rows the server
 * already sent. That is the right trade for the few hundred rows a page should
 * be loading; past roughly a thousand, filter on the server and pass the page
 * of results straight through with `searchable={false}` and no `pageSize`.
 *
 * Keyboard behaviour: headers are buttons, so Tab reaches every sort control.
 * When `onRowClick` is set the body becomes one tab stop with arrow keys moving
 * between rows and Enter or Space opening the focused one — a table of 200 rows
 * must not be 200 tab stops.
 *
 * ```tsx
 * <DataTable
 *   caption="Invoices"
 *   rows={invoices}
 *   rowKey={(invoice) => invoice.id}
 *   onRowClick={setSelected}
 *   searchable
 *   pageSize={25}
 *   initialSort={{ key: 'issuedAt', direction: 'desc' }}
 *   columns={[
 *     { key: 'number', header: 'Number', sortable: true, render: (i) => i.number ?? 'Draft' },
 *     { key: 'totalCents', header: 'Total', sortable: true, numeric: true,
 *       render: (i) => formatCents(i.totalCents, i.currency) },
 *   ]}
 * />
 * ```
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  caption,
  loading = false,
  skeletonRows = 6,
  searchable = false,
  searchPlaceholder = 'Search…',
  pageSize = 0,
  initialSort,
  onRowClick,
  isRowActive,
  empty,
  toolbar,
  footer,
  stickyHeader = true,
  maxHeight,
  dense = false,
  className,
}: DataTableProps<T>) {
  const captionId = useId();
  const [sort, setSort] = useState<SortState | null>(initialSort ?? null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [activeRow, setActiveRow] = useState(0);
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    const terms = needle.split(/\s+/);
    return rows.filter((row) => {
      const haystack = searchTextFor(row, columns);
      return terms.every((term) => haystack.includes(term));
    });
  }, [rows, columns, query]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const column = columns.find((candidate) => candidate.key === sort.key);
    if (!column) return filtered;
    // Copy first: sorting the prop array in place would mutate the caller's data.
    return [...filtered].sort((a, b) =>
      compareValues(readValue(a, column), readValue(b, column), sort.direction),
    );
  }, [filtered, columns, sort]);

  const paginated = pageSize > 0;
  const pageCount = paginated ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;

  // A filter that shortens the list can strand the reader past the last page.
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  useEffect(() => {
    setPage(0);
    setActiveRow(0);
  }, [query, sort]);

  const visible = useMemo(() => {
    if (!paginated) return sorted;
    const start = page * pageSize;
    return sorted.slice(start, start + pageSize);
  }, [sorted, paginated, page, pageSize]);

  const toggleSort = useCallback((key: string) => {
    setSort((current) => {
      if (current?.key !== key) return { key, direction: 'asc' };
      if (current.direction === 'asc') return { key, direction: 'desc' };
      return null; // third click clears, restoring the server's order
    });
  }, []);

  const activate = useCallback(
    (row: T, index: number) => {
      onRowClick?.(row, index);
    },
    [onRowClick],
  );

  const onBodyKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTableSectionElement>) => {
      if (!onRowClick || visible.length === 0) return;
      const last = visible.length - 1;
      let next: number | null = null;

      if (event.key === 'ArrowDown') next = Math.min(activeRow + 1, last);
      else if (event.key === 'ArrowUp') next = Math.max(activeRow - 1, 0);
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = last;
      else if (event.key === 'Enter' || event.key === ' ') {
        const row = visible[activeRow];
        if (!row) return;
        event.preventDefault();
        activate(row, activeRow);
        return;
      }
      if (next === null) return;

      event.preventDefault();
      setActiveRow(next);
      rowRefs.current[next]?.focus();
    },
    [onRowClick, visible, activeRow, activate],
  );

  const onRowMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLTableRowElement>, row: T, index: number) => {
      // A link or button inside a cell owns its own click.
      if ((event.target as HTMLElement).closest('a,button,input,select,textarea,label')) return;
      setActiveRow(index);
      activate(row, index);
    },
    [activate],
  );

  const showEmpty = !loading && visible.length === 0;
  const filteredOut = showEmpty && rows.length > 0;
  const rowPadding = dense ? 'px-3 py-2' : 'px-4 py-3';

  // The caption announces the sort, so it needs the column's name rather than
  // its property key — "sorted by Total" reads; "sorted by totalCents" does not.
  const sortedColumnName = useMemo(() => {
    if (!sort) return '';
    const column = columns.find((candidate) => candidate.key === sort.key);
    return typeof column?.header === 'string' ? column.header : sort.key;
  }, [sort, columns]);

  function goToPage(next: number) {
    setPage(next);
    setActiveRow(0);
  }

  function alignClass(column: Column<T>): string {
    const align = column.align ?? (column.numeric ? 'right' : 'left');
    if (align === 'right') return 'text-right';
    if (align === 'center') return 'text-center';
    return 'text-left';
  }

  return (
    <div className={cn('card overflow-hidden', className)}>
      {(searchable || toolbar) && (
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-3">
          {searchable && (
            <SearchInput
              value={query}
              onChange={setQuery}
              label={`Search ${caption.toLowerCase()}`}
              placeholder={searchPlaceholder}
              className="w-full sm:w-72"
            />
          )}
          {toolbar && <div className="flex flex-1 items-center justify-end gap-2">{toolbar}</div>}
        </div>
      )}

      <div
        className="scroll-x overscroll-contain"
        style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}
      >
        <table className="w-full border-collapse text-sm">
          <caption id={captionId} className="sr-only">
            {caption}
            {sort && `, sorted by ${sortedColumnName} ${sort.direction === 'asc' ? 'ascending' : 'descending'}`}
          </caption>

          <thead>
            <tr className="border-b border-line">
              {columns.map((column) => {
                const sortedHere = sort?.key === column.key;
                const ariaSort = sortedHere
                  ? sort.direction === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none';
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={column.sortable ? ariaSort : undefined}
                    style={column.width ? { width: column.width } : undefined}
                    className={cn(
                      'bg-surface text-xs font-semibold uppercase tracking-wide text-faint',
                      stickyHeader && maxHeight && 'sticky top-0 z-10',
                      rowPadding,
                      alignClass(column),
                      column.hideBelow && HIDE_BELOW[column.hideBelow],
                      column.className,
                    )}
                  >
                    {column.sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column.key)}
                        className={cn(
                          'inline-flex items-center gap-1 rounded transition-colors duration-150',
                          'hover:text-ink motion-reduce:transition-none',
                          sortedHere && 'text-ink',
                          (column.align ?? (column.numeric ? 'right' : 'left')) === 'right' &&
                            'flex-row-reverse',
                        )}
                      >
                        <span className={cn(column.headerSrOnly && 'sr-only')}>{column.header}</span>
                        {sortedHere ? (
                          sort.direction === 'asc' ? (
                            <ArrowUp className="h-3 w-3" aria-hidden="true" />
                          ) : (
                            <ArrowDown className="h-3 w-3" aria-hidden="true" />
                          )
                        ) : (
                          <ChevronsUpDown className="h-3 w-3 opacity-40" aria-hidden="true" />
                        )}
                      </button>
                    ) : (
                      <span className={cn(column.headerSrOnly && 'sr-only')}>{column.header}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>

          {loading ? (
            <tbody>
              {Array.from({ length: skeletonRows }, (_, rowIndex) => (
                <tr key={rowIndex} className="border-b border-line last:border-0">
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn(
                        rowPadding,
                        column.hideBelow && HIDE_BELOW[column.hideBelow],
                      )}
                    >
                      <span
                        className="block h-3.5 animate-pulse rounded bg-raised motion-reduce:animate-none"
                        style={{ width: `${55 + ((rowIndex * 13 + column.key.length * 7) % 40)}%` }}
                      />
                      <span className="sr-only">Loading</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ) : showEmpty ? (
            <tbody>
              <tr>
                <td colSpan={columns.length} className="px-6 py-14 text-center">
                  <div className="mx-auto flex max-w-sm flex-col items-center">
                    <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-raised text-muted">
                      {empty?.icon ?? <Inbox className="h-5 w-5" aria-hidden="true" />}
                    </div>
                    <p className="text-base font-semibold text-ink">
                      {filteredOut ? 'No matches' : (empty?.title ?? 'Nothing here yet')}
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      {filteredOut
                        ? `Nothing in ${caption.toLowerCase()} matches “${query.trim()}”.`
                        : (empty?.description ?? 'Rows will appear here as soon as there are any.')}
                    </p>
                    {filteredOut ? (
                      <button
                        type="button"
                        onClick={() => setQuery('')}
                        className="btn-secondary mt-4 px-3 py-1.5 text-xs"
                      >
                        Clear search
                      </button>
                    ) : (
                      empty?.action && <div className="mt-4">{empty.action}</div>
                    )}
                  </div>
                </td>
              </tr>
            </tbody>
          ) : (
            <tbody onKeyDown={onBodyKeyDown}>
              {visible.map((row, index) => {
                const active = isRowActive?.(row) ?? false;
                const interactive = Boolean(onRowClick);
                return (
                  <tr
                    key={rowKey(row, index)}
                    ref={(node) => {
                      rowRefs.current[index] = node;
                    }}
                    tabIndex={interactive ? (index === activeRow ? 0 : -1) : undefined}
                    aria-current={active ? true : undefined}
                    onFocus={interactive ? () => setActiveRow(index) : undefined}
                    onClick={
                      interactive ? (event) => onRowMouseDown(event, row, index) : undefined
                    }
                    className={cn(
                      'border-b border-line last:border-0 transition-colors duration-150',
                      'motion-reduce:transition-none',
                      interactive && 'cursor-pointer hover:bg-raised focus-visible:bg-raised',
                      active && 'bg-brand-500/5',
                    )}
                  >
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={cn(
                          'text-ink',
                          rowPadding,
                          alignClass(column),
                          column.numeric && 'tabular-nums',
                          column.hideBelow && HIDE_BELOW[column.hideBelow],
                          column.className,
                        )}
                      >
                        {column.render
                          ? column.render(row, index)
                          : String(readValue(row, column) ?? '—')}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          )}

          {footer && !loading && !showEmpty && (
            <tfoot className="border-t border-line bg-raised/50 font-semibold text-ink">
              {footer}
            </tfoot>
          )}
        </table>
      </div>

      {(paginated || sorted.length > 0) && !loading && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-3 py-2.5">
          <p className="text-xs text-muted" aria-live="polite">
            {sorted.length === 0
              ? 'No rows'
              : paginated
                ? `Showing ${page * pageSize + 1}–${Math.min((page + 1) * pageSize, sorted.length)} of ${formatInteger(sorted.length)}`
                : `${formatInteger(sorted.length)} row${sorted.length === 1 ? '' : 's'}`}
            {query.trim() && rows.length !== sorted.length && ` (filtered from ${formatInteger(rows.length)})`}
          </p>

          {paginated && pageCount > 1 && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => goToPage(Math.max(0, page - 1))}
                disabled={page === 0}
                className="btn-ghost px-2 py-1.5 text-xs disabled:opacity-40"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                Previous
              </button>
              <span className="px-2 text-xs tabular-nums text-muted">
                Page {page + 1} of {pageCount}
              </span>
              <button
                type="button"
                onClick={() => goToPage(Math.min(pageCount - 1, page + 1))}
                disabled={page >= pageCount - 1}
                className="btn-ghost px-2 py-1.5 text-xs disabled:opacity-40"
              >
                Next
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
