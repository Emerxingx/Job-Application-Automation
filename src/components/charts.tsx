'use client';

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BarChart3 } from 'lucide-react';
import { cn } from '@/components/ui';
import {
  formatCents,
  formatCompactNumber,
  formatInteger,
  formatPercentParts,
} from '@/components/data-table';
import { usePrefersReducedMotion } from '@/components/drawer';

// Defined next to the Drawer, which needs it first; re-exported here because
// this is the module animation-sensitive code tends to reach for.
export { usePrefersReducedMotion };

// --- Palette ----------------------------------------------------------------
//
// Six categorical slots, assigned in this fixed order and never cycled. The
// order is the colour-blindness safety mechanism, not decoration: each pair of
// neighbours clears an OKLab ΔE of 8 under simulated protanopia and deuteranopia
// (light 11.9, dark 13.5) and 15 under normal vision (light 15.8, dark 15.2),
// and every slot clears 3:1 against its surface, so no chart needs a contrast
// workaround.
//
// Every slot is also held at least 12 ΔE away from `success`, `warn` and
// `danger`. Those three are reserved: a series must never be mistaken for a
// state. If you need a seventh series, fold the tail into "Other" or facet the
// chart — do not invent a hue.
//
// Not validated for all-pairs separation, so this palette is for lines, bars,
// areas and donuts, where the eye compares neighbours. A scatter or bubble plot
// needs at most three slots.
const SERIES_LIGHT = ['#2a78d6', '#e0709b', '#6d3fc4', '#12a0b5', '#9a4a23', '#a8478f'] as const;
const SERIES_DARK = ['#2f7ddb', '#c65884', '#7e53d9', '#1196aa', '#ad5b35', '#b25098'] as const;

/** Human names for the slots, in order — handy when documenting a chart. */
export const SERIES_NAMES = ['blue', 'rose', 'violet', 'cyan', 'rust', 'magenta'] as const;

export const MAX_SERIES = SERIES_LIGHT.length;

const FALLBACK = {
  light: { grid: 'rgb(231 229 228)', axis: 'rgb(138 132 127)', ink: 'rgb(28 25 23)', surface: 'rgb(255 255 255)' },
  dark: { grid: 'rgb(51 51 57)', axis: 'rgb(120 113 108)', ink: 'rgb(250 250 249)', surface: 'rgb(24 24 27)' },
};

export interface ChartTokens {
  mode: 'light' | 'dark';
  series: readonly string[];
  grid: string;
  axis: string;
  ink: string;
  surface: string;
}

function readToken(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? `rgb(${raw})` : fallback;
}

/**
 * Resolve the palette and chrome colours for the theme that is actually on
 * screen — the explicit `data-theme` attribute when one is set, the OS
 * preference otherwise.
 *
 * Server rendering and the first client render both return the light values, so
 * hydration matches; the real theme lands in an effect, before Recharts has
 * measured its container and drawn anything.
 */
export function useChartTokens(): ChartTokens {
  const [mode, setMode] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const resolve = () => {
      const explicit = document.documentElement.getAttribute('data-theme');
      if (explicit === 'dark' || explicit === 'light') {
        setMode(explicit);
        return;
      }
      setMode(media.matches ? 'dark' : 'light');
    };

    resolve();
    media.addEventListener('change', resolve);
    const observer = new MutationObserver(resolve);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      media.removeEventListener('change', resolve);
      observer.disconnect();
    };
  }, []);

  return useMemo(() => {
    const fallback = FALLBACK[mode];
    return {
      mode,
      series: mode === 'dark' ? SERIES_DARK : SERIES_LIGHT,
      grid: readToken('--line', fallback.grid),
      axis: readToken('--faint', fallback.axis),
      ink: readToken('--ink', fallback.ink),
      surface: readToken('--surface', fallback.surface),
    };
  }, [mode]);
}

// --- Shared shapes ----------------------------------------------------------

export interface ChartSeries {
  /** Property on each datum holding this series' value. */
  key: string;
  /** Name shown in the legend, the tooltip and the accessible table. */
  label: string;
  /** Override the palette slot. Reach for this only to pin a meaning across pages. */
  color?: string;
  /** Draw the line dashed — a target, a forecast, a prior period. */
  dashed?: boolean;
}

/**
 * How a value is written. `cents` takes integer cents and `percentParts` takes
 * integer parts-per-million, matching the two numeric conventions in the schema,
 * so a caller never divides before handing data to a chart.
 */
export type ValueFormat =
  | 'number'
  | 'compact'
  | 'cents'
  | 'centsCompact'
  | 'percentParts'
  | ((value: number) => string);

function makeFormatter(format: ValueFormat, currency: string): (value: number) => string {
  if (typeof format === 'function') return format;
  switch (format) {
    case 'cents':
      return (value) => formatCents(value, currency);
    case 'centsCompact':
      return (value) => formatCents(value, currency, { compact: true });
    case 'percentParts':
      return (value) => formatPercentParts(value);
    case 'compact':
      return formatCompactNumber;
    default:
      return formatInteger;
  }
}

/** Axis ticks are always terse; the tooltip carries the exact figure. */
function makeAxisFormatter(format: ValueFormat, currency: string): (value: number) => string {
  if (typeof format === 'function') return format;
  if (format === 'cents' || format === 'centsCompact')
    return (value) => formatCents(value, currency, { compact: true, hideCurrencyCode: true });
  if (format === 'percentParts') return (value) => formatPercentParts(value, 0);
  return formatCompactNumber;
}

function readCell(row: unknown, key: string): unknown {
  if (row && typeof row === 'object') return (row as Record<string, unknown>)[key];
  return undefined;
}

function numberAt(row: unknown, key: string): number | null {
  const value = readCell(row, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// --- Frame ------------------------------------------------------------------

interface ChartFrameProps {
  title?: string;
  description?: string;
  action?: ReactNode;
  /** Rendered under the plot. Pass the legend, or a footnote. */
  below?: ReactNode;
  height: number;
  hasData: boolean;
  loading?: boolean;
  emptyTitle: string;
  emptyDescription: string;
  ariaLabel: string;
  table?: ReactNode;
  className?: string;
  children: ReactNode;
}

function ChartFrame({
  title,
  description,
  action,
  below,
  height,
  hasData,
  loading,
  emptyTitle,
  emptyDescription,
  ariaLabel,
  table,
  className,
  children,
}: ChartFrameProps) {
  return (
    <section className={cn('card p-4', className)}>
      {(title || action) && (
        <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h3 className="text-sm font-semibold text-ink">{title}</h3>}
            {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </header>
      )}

      {loading ? (
        <div
          className="animate-pulse rounded-xl bg-raised motion-reduce:animate-none"
          style={{ height }}
          role="status"
          aria-label={`${ariaLabel} — loading`}
        />
      ) : hasData ? (
        <>
          <div role="group" aria-label={ariaLabel} style={{ height }}>
            {children}
          </div>
          {table}
        </>
      ) : (
        <div
          className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line px-6 text-center"
          style={{ height }}
        >
          <BarChart3 className="mb-2 h-5 w-5 text-faint" aria-hidden="true" />
          <p className="text-sm font-semibold text-ink">{emptyTitle}</p>
          <p className="mt-1 max-w-xs text-xs text-muted">{emptyDescription}</p>
        </div>
      )}

      {hasData && !loading && below}
    </section>
  );
}

// --- Legend -----------------------------------------------------------------

interface LegendEntry {
  label: string;
  color: string;
  value?: string;
}

function ChartLegend({ entries }: { entries: readonly LegendEntry[] }) {
  return (
    <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {entries.map((entry) => (
        <li key={entry.label} className="flex items-center gap-1.5 text-xs">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: entry.color }}
            aria-hidden="true"
          />
          <span className="text-muted">{entry.label}</span>
          {entry.value && <span className="font-semibold tabular-nums text-ink">{entry.value}</span>}
        </li>
      ))}
    </ul>
  );
}

// --- Tooltip ----------------------------------------------------------------

interface TooltipEntry {
  name?: number | string;
  value?: number | string | readonly (number | string)[];
  color?: string;
  dataKey?: string | number | ((row: unknown) => unknown);
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: readonly TooltipEntry[];
  label?: string | number;
  formatValue: (value: number) => string;
  formatLabel?: (label: string | number) => string;
  labels: Record<string, string>;
}

/** Recharts clones this element and injects `active`, `payload` and `label`. */
function ChartTooltip({
  active,
  payload,
  label,
  formatValue,
  formatLabel,
  labels,
}: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="card min-w-[9rem] px-3 py-2 shadow-lift">
      {label !== undefined && (
        <p className="mb-1.5 text-xs font-semibold text-ink">
          {formatLabel ? formatLabel(label) : String(label)}
        </p>
      )}
      <ul className="space-y-1">
        {payload.map((entry, index) => {
          const key = typeof entry.dataKey === 'string' ? entry.dataKey : String(entry.name ?? index);
          const name = labels[key] ?? String(entry.name ?? key);
          const raw = typeof entry.value === 'number' ? entry.value : Number(entry.value);
          return (
            <li key={`${key}-${index}`} className="flex items-center justify-between gap-4 text-xs">
              <span className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: entry.color }}
                  aria-hidden="true"
                />
                <span className="text-muted">{name}</span>
              </span>
              <span className="font-semibold tabular-nums text-ink">
                {Number.isFinite(raw) ? formatValue(raw) : '—'}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// --- Accessible table -------------------------------------------------------

function ChartDataTable({
  caption,
  head,
  rows,
}: {
  caption: string;
  head: readonly string[];
  rows: readonly (readonly string[])[];
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {head.map((cell) => (
            <th key={cell} scope="col">
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>
            {row.map((cell, cellIndex) =>
              cellIndex === 0 ? (
                <th key={cellIndex} scope="row">
                  {cell}
                </th>
              ) : (
                <td key={cellIndex}>{cell}</td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --- Cartesian charts -------------------------------------------------------

export interface CartesianChartProps<D> {
  data: readonly D[];
  /** Property holding the category or timestamp on the x axis. */
  xKey: string;
  series: readonly ChartSeries[];
  title?: string;
  description?: string;
  action?: ReactNode;
  /** Plot height in pixels. Width always fills the card. */
  height?: number;
  valueFormat?: ValueFormat;
  /** ISO currency code used by the `cents` formats. */
  currency?: string;
  formatX?: (value: string | number) => string;
  /** Defaults to on for two or more series. */
  showLegend?: boolean;
  showGrid?: boolean;
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  className?: string;
}

interface ResolvedSeries extends ChartSeries {
  color: string;
}

function useResolvedChart<D>(
  data: readonly D[],
  xKey: string,
  series: readonly ChartSeries[],
  valueFormat: ValueFormat,
  currency: string,
  formatX?: (value: string | number) => string,
) {
  const tokens = useChartTokens();
  const reducedMotion = usePrefersReducedMotion();

  const resolved: ResolvedSeries[] = useMemo(
    () =>
      series.slice(0, MAX_SERIES).map((entry, index) => ({
        ...entry,
        color: entry.color ?? tokens.series[index % tokens.series.length],
      })),
    [series, tokens.series],
  );

  const labels = useMemo(
    () => Object.fromEntries(resolved.map((entry) => [entry.key, entry.label])),
    [resolved],
  );

  const formatValue = useMemo(() => makeFormatter(valueFormat, currency), [valueFormat, currency]);
  const formatAxis = useMemo(
    () => makeAxisFormatter(valueFormat, currency),
    [valueFormat, currency],
  );
  const formatCategory = useMemo(
    () => formatX ?? ((value: string | number) => String(value)),
    [formatX],
  );

  const hasData = useMemo(
    () =>
      data.length > 0 &&
      resolved.some((entry) => data.some((row) => numberAt(row, entry.key) !== null)),
    [data, resolved],
  );

  const tableRows = useMemo(
    () =>
      data.map((row) => [
        formatCategory(String(readCell(row, xKey) ?? '')),
        ...resolved.map((entry) => {
          const value = numberAt(row, entry.key);
          return value === null ? '—' : formatValue(value);
        }),
      ]),
    [data, xKey, resolved, formatCategory, formatValue],
  );

  return {
    tokens,
    reducedMotion,
    resolved,
    labels,
    formatValue,
    formatAxis,
    formatCategory,
    hasData,
    tableRows,
  };
}

const AXIS_TICK = { fontSize: 11 };

/**
 * Change over time, one point per period — MRR by day, applications per week,
 * webhook failures per hour.
 *
 * Reach for a line when the x axis is continuous and the shape of the trend is
 * the message. If the periods are few and discrete, or the reader will compare
 * magnitudes rather than follow a slope, use {@link BarChartCard}.
 *
 * ```tsx
 * <LineChartCard
 *   title="Monthly recurring revenue"
 *   data={rollups}
 *   xKey="day"
 *   valueFormat="cents"
 *   series={[{ key: 'mrrCents', label: 'MRR' }, { key: 'newMrrCents', label: 'New' }]}
 * />
 * ```
 */
export function LineChartCard<D>({
  data,
  xKey,
  series,
  title,
  description,
  action,
  height = 260,
  valueFormat = 'number',
  currency = 'CAD',
  formatX,
  showLegend,
  showGrid = true,
  loading,
  emptyTitle = 'No data for this period',
  emptyDescription = 'Widen the date range, or come back once there is activity to plot.',
  className,
}: CartesianChartProps<D>) {
  const chart = useResolvedChart(data, xKey, series, valueFormat, currency, formatX);
  const legend = showLegend ?? chart.resolved.length > 1;

  return (
    <ChartFrame
      title={title}
      description={description}
      action={action}
      height={height}
      hasData={chart.hasData}
      loading={loading}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      ariaLabel={`${title ?? 'Line chart'} — ${chart.resolved.map((s) => s.label).join(', ')}`}
      className={className}
      table={
        <ChartDataTable
          caption={`${title ?? 'Chart'} data`}
          head={[xKey, ...chart.resolved.map((s) => s.label)]}
          rows={chart.tableRows}
        />
      }
      below={
        legend && (
          <ChartLegend
            entries={chart.resolved.map((s) => ({ label: s.label, color: s.color }))}
          />
        )
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          {showGrid && (
            <CartesianGrid vertical={false} stroke={chart.tokens.grid} strokeDasharray="3 3" />
          )}
          <XAxis
            dataKey={xKey}
            tickLine={false}
            axisLine={false}
            tick={AXIS_TICK}
            stroke={chart.tokens.axis}
            tickMargin={8}
            minTickGap={24}
            tickFormatter={(value: string | number) => chart.formatCategory(value)}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={AXIS_TICK}
            stroke={chart.tokens.axis}
            width={56}
            tickFormatter={(value: number) => chart.formatAxis(value)}
          />
          <Tooltip
            cursor={{ stroke: chart.tokens.grid, strokeWidth: 1 }}
            content={
              <ChartTooltip
                formatValue={chart.formatValue}
                formatLabel={chart.formatCategory}
                labels={chart.labels}
              />
            }
          />
          {chart.resolved.map((entry) => (
            <Line
              key={entry.key}
              type="monotone"
              dataKey={entry.key}
              name={entry.label}
              stroke={entry.color}
              strokeWidth={2}
              strokeDasharray={entry.dashed ? '5 4' : undefined}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: chart.tokens.surface }}
              isAnimationActive={!chart.reducedMotion}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export interface BarChartCardProps<D> extends CartesianChartProps<D> {
  /** Stack the series instead of grouping them side by side. */
  stacked?: boolean;
  /** Lay the bars horizontally — better for long category names. */
  horizontal?: boolean;
}

/**
 * Magnitude across a handful of discrete categories — invoices by status, MRR
 * movement by month, tickets by queue.
 *
 * Bars are anchored to a zero baseline; never start the axis anywhere else. Use
 * `stacked` only when the total is itself meaningful, and keep stacks to three
 * or four segments — past that the middle bands become impossible to compare.
 */
export function BarChartCard<D>({
  data,
  xKey,
  series,
  title,
  description,
  action,
  height = 260,
  valueFormat = 'number',
  currency = 'CAD',
  formatX,
  showLegend,
  showGrid = true,
  stacked = false,
  horizontal = false,
  loading,
  emptyTitle = 'No data for this period',
  emptyDescription = 'Widen the date range, or come back once there is activity to plot.',
  className,
}: BarChartCardProps<D>) {
  const chart = useResolvedChart(data, xKey, series, valueFormat, currency, formatX);
  const legend = showLegend ?? chart.resolved.length > 1;

  const categoryAxis = (
    <XAxis
      {...(horizontal
        ? { type: 'number' as const, tickFormatter: (value: number) => chart.formatAxis(value) }
        : {
            dataKey: xKey,
            type: 'category' as const,
            tickFormatter: (value: string | number) => chart.formatCategory(value),
          })}
      tickLine={false}
      axisLine={false}
      tick={AXIS_TICK}
      stroke={chart.tokens.axis}
      tickMargin={8}
      minTickGap={16}
    />
  );

  const valueAxis = (
    <YAxis
      {...(horizontal
        ? {
            dataKey: xKey,
            type: 'category' as const,
            width: 120,
            tickFormatter: (value: string | number) => chart.formatCategory(value),
          }
        : {
            type: 'number' as const,
            width: 56,
            tickFormatter: (value: number) => chart.formatAxis(value),
          })}
      tickLine={false}
      axisLine={false}
      tick={AXIS_TICK}
      stroke={chart.tokens.axis}
    />
  );

  return (
    <ChartFrame
      title={title}
      description={description}
      action={action}
      height={height}
      hasData={chart.hasData}
      loading={loading}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      ariaLabel={`${title ?? 'Bar chart'} — ${chart.resolved.map((s) => s.label).join(', ')}`}
      className={className}
      table={
        <ChartDataTable
          caption={`${title ?? 'Chart'} data`}
          head={[xKey, ...chart.resolved.map((s) => s.label)]}
          rows={chart.tableRows}
        />
      }
      below={
        legend && (
          <ChartLegend entries={chart.resolved.map((s) => ({ label: s.label, color: s.color }))} />
        )
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout={horizontal ? 'vertical' : 'horizontal'}
          margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          barGap={2}
          barCategoryGap="22%"
        >
          {showGrid && (
            <CartesianGrid
              vertical={horizontal}
              horizontal={!horizontal}
              stroke={chart.tokens.grid}
              strokeDasharray="3 3"
            />
          )}
          {categoryAxis}
          {valueAxis}
          <Tooltip
            cursor={{ fill: chart.tokens.grid, fillOpacity: 0.35 }}
            content={
              <ChartTooltip
                formatValue={chart.formatValue}
                formatLabel={chart.formatCategory}
                labels={chart.labels}
              />
            }
          />
          {chart.resolved.map((entry) => (
            <Bar
              key={entry.key}
              dataKey={entry.key}
              name={entry.label}
              fill={entry.color}
              stackId={stacked ? 'stack' : undefined}
              // 4px rounded cap on the data end only; the baseline end stays square.
              radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
              // A 2px ring in the surface colour keeps stacked segments and
              // neighbouring bars from bleeding into one another.
              stroke={chart.tokens.surface}
              strokeWidth={stacked ? 2 : 0}
              isAnimationActive={!chart.reducedMotion}
              maxBarSize={48}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/**
 * A line with the region under it filled — for a single accumulating quantity
 * where the volume, not just the slope, is the point: applications sent per day,
 * cash collected, storage used.
 *
 * Stack areas only for parts of a whole. Two overlapping filled areas hide each
 * other; if you are comparing independent series, use {@link LineChartCard}.
 */
export function AreaChartCard<D>({
  data,
  xKey,
  series,
  title,
  description,
  action,
  height = 260,
  valueFormat = 'number',
  currency = 'CAD',
  formatX,
  showLegend,
  showGrid = true,
  stacked = false,
  loading,
  emptyTitle = 'No data for this period',
  emptyDescription = 'Widen the date range, or come back once there is activity to plot.',
  className,
}: CartesianChartProps<D> & { stacked?: boolean }) {
  const chart = useResolvedChart(data, xKey, series, valueFormat, currency, formatX);
  const gradientId = useId().replace(/:/g, '');
  const legend = showLegend ?? chart.resolved.length > 1;

  return (
    <ChartFrame
      title={title}
      description={description}
      action={action}
      height={height}
      hasData={chart.hasData}
      loading={loading}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      ariaLabel={`${title ?? 'Area chart'} — ${chart.resolved.map((s) => s.label).join(', ')}`}
      className={className}
      table={
        <ChartDataTable
          caption={`${title ?? 'Chart'} data`}
          head={[xKey, ...chart.resolved.map((s) => s.label)]}
          rows={chart.tableRows}
        />
      }
      below={
        legend && (
          <ChartLegend entries={chart.resolved.map((s) => ({ label: s.label, color: s.color }))} />
        )
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <defs>
            {chart.resolved.map((entry) => (
              <linearGradient
                key={entry.key}
                id={`${gradientId}-${entry.key}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor={entry.color} stopOpacity={stacked ? 0.55 : 0.28} />
                <stop offset="100%" stopColor={entry.color} stopOpacity={stacked ? 0.35 : 0.02} />
              </linearGradient>
            ))}
          </defs>
          {showGrid && (
            <CartesianGrid vertical={false} stroke={chart.tokens.grid} strokeDasharray="3 3" />
          )}
          <XAxis
            dataKey={xKey}
            tickLine={false}
            axisLine={false}
            tick={AXIS_TICK}
            stroke={chart.tokens.axis}
            tickMargin={8}
            minTickGap={24}
            tickFormatter={(value: string | number) => chart.formatCategory(value)}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={AXIS_TICK}
            stroke={chart.tokens.axis}
            width={56}
            tickFormatter={(value: number) => chart.formatAxis(value)}
          />
          <Tooltip
            cursor={{ stroke: chart.tokens.grid, strokeWidth: 1 }}
            content={
              <ChartTooltip
                formatValue={chart.formatValue}
                formatLabel={chart.formatCategory}
                labels={chart.labels}
              />
            }
          />
          {chart.resolved.map((entry) => (
            <Area
              key={entry.key}
              type="monotone"
              dataKey={entry.key}
              name={entry.label}
              stroke={entry.color}
              strokeWidth={2}
              fill={`url(#${gradientId}-${entry.key})`}
              stackId={stacked ? 'stack' : undefined}
              activeDot={{ r: 4, strokeWidth: 2, stroke: chart.tokens.surface }}
              isAnimationActive={!chart.reducedMotion}
              connectNulls
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

// --- Donut ------------------------------------------------------------------

export interface DonutSlice {
  /** Stable identity — the colour follows this, not the slice's rank. */
  id: string;
  label: string;
  value: number;
  color?: string;
}

export interface DonutChartCardProps {
  slices: readonly DonutSlice[];
  title?: string;
  description?: string;
  action?: ReactNode;
  height?: number;
  valueFormat?: ValueFormat;
  currency?: string;
  /** Big number in the hole. Defaults to the formatted sum of the slices. */
  centerValue?: string;
  centerLabel?: string;
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  className?: string;
}

/**
 * Composition of a single whole — invoices by status, revenue by plan, tickets
 * by channel.
 *
 * Only for parts of one total, and only up to six slices; a seventh belongs in
 * "Other". If the reader needs to compare the parts against each other rather
 * than against the whole, a bar chart answers that better and this does not.
 *
 * Slices carry their own value in the legend, so identity never rests on colour
 * alone, and a 2px gap in the surface colour separates neighbours.
 */
export function DonutChartCard({
  slices,
  title,
  description,
  action,
  height = 240,
  valueFormat = 'number',
  currency = 'CAD',
  centerValue,
  centerLabel,
  loading,
  emptyTitle = 'Nothing to break down',
  emptyDescription = 'Once there are records in this period, their split appears here.',
  className,
}: DonutChartCardProps) {
  const tokens = useChartTokens();
  const reducedMotion = usePrefersReducedMotion();
  const formatValue = useMemo(() => makeFormatter(valueFormat, currency), [valueFormat, currency]);

  const resolved = useMemo(
    () =>
      slices.slice(0, MAX_SERIES).map((slice, index) => ({
        ...slice,
        color: slice.color ?? tokens.series[index % tokens.series.length],
      })),
    [slices, tokens.series],
  );

  const total = useMemo(
    () => resolved.reduce((sum, slice) => sum + (Number.isFinite(slice.value) ? slice.value : 0), 0),
    [resolved],
  );
  const hasData = resolved.length > 0 && total > 0;
  const labels = useMemo(
    () => Object.fromEntries(resolved.map((slice) => [slice.label, slice.label])),
    [resolved],
  );

  return (
    <ChartFrame
      title={title}
      description={description}
      action={action}
      height={height}
      hasData={hasData}
      loading={loading}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      ariaLabel={`${title ?? 'Donut chart'} — ${resolved.map((slice) => slice.label).join(', ')}`}
      className={className}
      table={
        <ChartDataTable
          caption={`${title ?? 'Chart'} data`}
          head={['Segment', 'Value', 'Share']}
          rows={resolved.map((slice) => [
            slice.label,
            formatValue(slice.value),
            total > 0 ? `${Math.round((slice.value / total) * 100)}%` : '—',
          ])}
        />
      }
      below={
        <ChartLegend
          entries={resolved.map((slice) => ({
            label: slice.label,
            color: slice.color,
            value: formatValue(slice.value),
          }))}
        />
      }
    >
      <div className="relative h-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={resolved as DonutSlice[]}
              dataKey="value"
              nameKey="label"
              innerRadius="62%"
              outerRadius="88%"
              paddingAngle={2}
              stroke={tokens.surface}
              strokeWidth={2}
              isAnimationActive={!reducedMotion}
              labelLine={false}
            >
              {resolved.map((slice) => (
                <Cell key={slice.id} fill={slice.color} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltip formatValue={formatValue} labels={labels} />} />
          </PieChart>
        </ResponsiveContainer>

        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-bold tabular-nums text-ink">
            {centerValue ?? formatValue(total)}
          </span>
          {centerLabel && (
            <span className="mt-0.5 text-xs uppercase tracking-wide text-faint">{centerLabel}</span>
          )}
        </div>
      </div>
    </ChartFrame>
  );
}

// --- Sparkline --------------------------------------------------------------

export interface SparklineProps {
  /** Values in chronological order. Nulls are bridged, not dropped. */
  values: readonly (number | null)[];
  /** Required — the shape carries no axes, so the label must say what it is. */
  label: string;
  width?: number | string;
  height?: number;
  /** Defaults to the first palette slot. Pass a slot to match a sibling chart. */
  color?: string;
  /** Fill the area under the line. */
  filled?: boolean;
  className?: string;
}

/**
 * A trend line small enough to live inside a stat tile or a table cell: 30 days
 * of applications beside the total, a customer's MRR beside their name.
 *
 * There are no axes and no tooltip by design — a sparkline shows direction and
 * volatility, never a readable value. When someone needs the numbers, put a
 * {@link LineChartCard} on the page instead.
 */
export function Sparkline({
  values,
  label,
  width = '100%',
  height = 36,
  color,
  filled = true,
  className,
}: SparklineProps) {
  const tokens = useChartTokens();
  const reducedMotion = usePrefersReducedMotion();
  const gradientId = useId().replace(/:/g, '');
  const stroke = color ?? tokens.series[0];

  const data = useMemo(() => values.map((value, index) => ({ index, value })), [values]);
  const points = values.filter((value): value is number => typeof value === 'number');

  if (points.length < 2) {
    return (
      <div
        className={cn('flex items-center text-xs text-faint', className)}
        style={{ width, height }}
      >
        Not enough data
      </div>
    );
  }

  const first = points[0];
  const last = points[points.length - 1];
  const direction = last > first ? 'rising' : last < first ? 'falling' : 'flat';

  return (
    <div
      className={className}
      style={{ width, height }}
      role="img"
      aria-label={`${label}: ${direction}, from ${formatCompactNumber(first)} to ${formatCompactNumber(last)} over ${points.length} points`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
          <defs>
            <linearGradient id={`spark-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.3} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="value"
            stroke={stroke}
            strokeWidth={2}
            fill={filled ? `url(#spark-${gradientId})` : 'none'}
            fillOpacity={filled ? 1 : 0}
            dot={false}
            activeDot={false}
            isAnimationActive={!reducedMotion}
            connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
