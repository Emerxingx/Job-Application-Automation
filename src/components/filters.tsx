'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { endOfDay, startOfDay, subDays, subMonths } from 'date-fns';
import { RotateCcw, Search, X } from 'lucide-react';
import { cn } from '@/components/ui';

// --- Date ranges ------------------------------------------------------------

export type DateRangePreset = '7d' | '30d' | '90d' | '12m' | 'all';

export interface DateRange {
  preset: DateRangePreset;
  /** Inclusive start of the window. `null` for the `all` preset. */
  from: Date | null;
  /** Inclusive end of the window — end of the current day. */
  to: Date;
}

export const DATE_RANGE_PRESETS: { value: DateRangePreset; label: string; title: string }[] = [
  { value: '7d', label: '7d', title: 'Last 7 days' },
  { value: '30d', label: '30d', title: 'Last 30 days' },
  { value: '90d', label: '90d', title: 'Last 90 days' },
  { value: '12m', label: '12m', title: 'Last 12 months' },
  { value: 'all', label: 'All', title: 'All time' },
];

/**
 * Turn a preset into concrete bounds. Windows are inclusive of both ends and
 * are computed in the visitor's local timezone — convert with {@link toDayKey}
 * before comparing against the UTC `day` keys on the rollup tables.
 */
export function rangeFromPreset(preset: DateRangePreset, now: Date = new Date()): DateRange {
  const to = endOfDay(now);
  switch (preset) {
    case '7d':
      return { preset, from: startOfDay(subDays(now, 6)), to };
    case '30d':
      return { preset, from: startOfDay(subDays(now, 29)), to };
    case '90d':
      return { preset, from: startOfDay(subDays(now, 89)), to };
    case '12m':
      return { preset, from: startOfDay(subMonths(now, 12)), to };
    case 'all':
      return { preset, from: null, to };
  }
}

/** UTC `YYYY-MM-DD` — the shape every `day` column in the schema stores. */
export function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Query-string params for a range, ready to hand to an export or report endpoint. */
export function toRangeParams(range: DateRange): Record<string, string> {
  const params: Record<string, string> = { preset: range.preset, to: range.to.toISOString() };
  if (range.from) params.from = range.from.toISOString();
  return params;
}

export interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  /** Visible label above the control. Pass `null` to hide it (still announced). */
  label?: string | null;
  /** Restrict which presets are offered, in the order given. */
  presets?: readonly DateRangePreset[];
  disabled?: boolean;
  className?: string;
}

/**
 * Segmented preset picker for "how far back does this report look".
 *
 * Implemented as a radiogroup, so a keyboard reaches it with one Tab and then
 * moves between presets with the arrow keys — the standard segmented-control
 * pattern, not five separate tab stops.
 *
 * ```tsx
 * const [range, setRange] = useState(() => rangeFromPreset('30d'));
 * <DateRangePicker value={range} onChange={setRange} />
 * ```
 */
export function DateRangePicker({
  value,
  onChange,
  label = 'Period',
  presets,
  disabled,
  className,
}: DateRangePickerProps) {
  const labelId = useId();
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const options = useMemo(() => {
    if (!presets) return DATE_RANGE_PRESETS;
    return presets
      .map((preset) => DATE_RANGE_PRESETS.find((option) => option.value === preset))
      .filter((option): option is (typeof DATE_RANGE_PRESETS)[number] => Boolean(option));
  }, [presets]);

  const select = useCallback(
    (preset: DateRangePreset) => onChange(rangeFromPreset(preset)),
    [onChange],
  );

  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    const last = options.length - 1;
    let next: number | null = null;

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index === 0 ? last : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next === null) return;

    event.preventDefault();
    select(options[next].value);
    buttonRefs.current[next]?.focus();
  }

  return (
    <div className={className}>
      {label !== null && (
        <span id={labelId} className="label mb-1 text-xs">
          {label}
        </span>
      )}
      <div
        role="radiogroup"
        aria-labelledby={label !== null ? labelId : undefined}
        aria-label={label === null ? 'Reporting period' : undefined}
        className="inline-flex items-center gap-0.5 rounded-xl border border-line bg-raised p-0.5"
      >
        {options.map((option, index) => {
          const active = option.value === value.preset;
          return (
            <button
              key={option.value}
              ref={(node) => {
                buttonRefs.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={option.title}
              title={option.title}
              disabled={disabled}
              tabIndex={active ? 0 : -1}
              onClick={() => select(option.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                'rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors duration-150',
                'motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50',
                active
                  ? 'bg-surface text-ink shadow-card'
                  : 'text-muted hover:text-ink',
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- Select -----------------------------------------------------------------

export interface SelectFilterOption {
  value: string;
  label: string;
  /** Optional count shown after the label, e.g. "Open (12)". */
  count?: number;
}

export interface SelectFilterProps {
  label: string;
  value: string;
  options: readonly SelectFilterOption[];
  onChange: (value: string) => void;
  /** Label for the "no filter" choice. Omit to require a selection. */
  anyLabel?: string;
  /** The value the `anyLabel` option reports. Defaults to an empty string. */
  anyValue?: string;
  /** Hide the visible label but keep it for assistive tech. */
  hideLabel?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * A single-choice dimension filter — status, plan, provider, assignee.
 *
 * Deliberately a native `<select>`: it is keyboard- and screen-reader-correct
 * everywhere, and it becomes the platform picker on a phone. Reach for a custom
 * listbox only when options need icons or two-line descriptions.
 */
export function SelectFilter({
  label,
  value,
  options,
  onChange,
  anyLabel,
  anyValue = '',
  hideLabel,
  disabled,
  className,
}: SelectFilterProps) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className={cn('label mb-1 text-xs', hideLabel && 'sr-only')}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="input py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
      >
        {anyLabel !== undefined && <option value={anyValue}>{anyLabel}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.count === undefined ? option.label : `${option.label} (${option.count})`}
          </option>
        ))}
      </select>
    </div>
  );
}

// --- Search -----------------------------------------------------------------

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  /** Hide the visible label but keep it for assistive tech. Defaults to true. */
  hideLabel?: boolean;
  /** Called on Enter, for searches that hit the server rather than filter in place. */
  onSubmit?: (value: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * Free-text filter box. Fully controlled — it holds no state of its own, so the
 * page owns the query and can put it in the URL.
 *
 * For a search that hits the server, wrap the value in {@link useDebouncedValue}
 * rather than debouncing inside the input, so typing stays responsive while the
 * request rate stays sane.
 */
export function SearchInput({
  value,
  onChange,
  label = 'Search',
  placeholder = 'Search…',
  hideLabel = true,
  onSubmit,
  autoFocus,
  disabled,
  className,
}: SearchInputProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={id} className={cn('label mb-1 text-xs', hideLabel && 'sr-only')}>
        {label}
      </label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          id={id}
          type="search"
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && onSubmit) {
              event.preventDefault();
              onSubmit(value);
            }
            if (event.key === 'Escape' && value) {
              event.preventDefault();
              onChange('');
            }
          }}
          className="input py-2 pl-9 pr-9 text-sm disabled:cursor-not-allowed disabled:opacity-50
                     [&::-webkit-search-cancel-button]:appearance-none"
        />
        {value && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              onChange('');
              inputRef.current?.focus();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-faint
                       transition-colors duration-150 hover:text-ink motion-reduce:transition-none"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Trail a value behind its source by `delay` ms. Use it between a
 * {@link SearchInput} and a server request:
 *
 * ```tsx
 * const [query, setQuery] = useState('');
 * const debounced = useDebouncedValue(query, 300);
 * useEffect(() => { void load(debounced); }, [debounced]);
 * ```
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

// --- Bar --------------------------------------------------------------------

export interface FilterBarProps {
  children: ReactNode;
  /** Shows a "Clear filters" button when supplied. */
  onReset?: () => void;
  /** Disables the reset button — pass false when nothing is filtered. */
  canReset?: boolean;
  /** Rendered flush right, e.g. an `<ExportButton />`. */
  actions?: ReactNode;
  /** Short summary such as "128 invoices · $41,204.00". */
  summary?: ReactNode;
  className?: string;
}

/**
 * One row of controls above a table or a set of charts. Keeping every filter on
 * a single line is the point: a reader should be able to see, without scrolling,
 * exactly which slice of the data they are looking at.
 *
 * ```tsx
 * <FilterBar onReset={reset} canReset={dirty} actions={<ExportButton endpoint="/api/console/invoices/export" />}>
 *   <DateRangePicker value={range} onChange={setRange} />
 *   <SelectFilter label="Status" value={status} options={STATUSES} onChange={setStatus} anyLabel="Any status" />
 *   <SearchInput value={query} onChange={setQuery} placeholder="Invoice number or email" />
 * </FilterBar>
 * ```
 */
export function FilterBar({
  children,
  onReset,
  canReset = true,
  actions,
  summary,
  className,
}: FilterBarProps) {
  return (
    <div className={cn('card mb-5 p-3', className)}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-end gap-3">{children}</div>

        <div className="flex shrink-0 items-center gap-2">
          {onReset && (
            <button
              type="button"
              onClick={onReset}
              disabled={!canReset}
              className="btn-ghost px-2.5 py-2 text-xs"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Clear
            </button>
          )}
          {actions}
        </div>
      </div>

      {summary && (
        <p className="mt-2.5 border-t border-line pt-2.5 text-xs text-muted" aria-live="polite">
          {summary}
        </p>
      )}
    </div>
  );
}
