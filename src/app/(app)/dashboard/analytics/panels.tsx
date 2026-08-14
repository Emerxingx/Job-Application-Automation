import type { ReactNode } from 'react';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { Card, cn } from '@/components/ui';

/**
 * Server-rendered pieces of the analytics page.
 *
 * None of these are interactive, so none of them ship JavaScript. They compose
 * `Card` and the same type scale as `Stat` in src/components/ui.tsx rather than
 * introducing a second visual language — the only thing they add is the
 * period-over-period delta line, which `Stat` has no slot for.
 */

// --- KPI --------------------------------------------------------------------

export type DeltaDirection = 'up' | 'down' | 'flat';

export interface Delta {
  /** Already written for a reader, e.g. "+12" or "+3.4 pts". */
  text: string;
  direction: DeltaDirection;
  /** False when a rise is bad news. Every KPI on this page is "up is better". */
  upIsGood?: boolean;
}

const DELTA_ICON = { up: TrendingUp, down: TrendingDown, flat: Minus };

export function KpiCard({
  label,
  value,
  hint,
  delta,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  hint?: string;
  delta?: Delta | null;
  tone?: 'default' | 'success' | 'brand';
}) {
  const Icon = delta ? DELTA_ICON[delta.direction] : null;
  const good = delta?.upIsGood ?? true;
  const deltaTone =
    !delta || delta.direction === 'flat'
      ? 'text-faint'
      : (delta.direction === 'up') === good
        ? 'text-success'
        : 'text-danger';

  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-faint">{label}</p>
      <p
        className={cn(
          'mt-1.5 text-2xl font-bold tabular-nums',
          tone === 'success' && 'text-success',
          tone === 'brand' && 'text-brand-600',
          tone === 'default' && 'text-ink',
        )}
      >
        {value}
      </p>
      {delta && Icon && (
        // One text run, not three flex items: in a four-across grid the phrase
        // has to be able to wrap, and wrapping between flex items breaks it
        // mid-sentence ("No / change / vs previous period").
        <p className={cn('mt-1.5 flex items-start gap-1 text-xs font-medium', deltaTone)}>
          <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="tabular-nums">{delta.text}</span>
            {delta.direction !== 'flat' && (
              <span className="font-normal text-faint"> vs previous period</span>
            )}
          </span>
        </p>
      )}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </Card>
  );
}

// --- Funnel -----------------------------------------------------------------

export interface FunnelStageView {
  key: string;
  label: string;
  count: number;
  /** What this stage means, in the applicant's language. */
  note: string;
  /** Conversion from the stage above, or null for the first stage. */
  conversion: string | null;
}

/**
 * The response funnel, drawn as proportional bars rather than a tapering
 * polygon: a bar's length is readable at 390px wide and a polygon is not, and
 * the counts stay legible when three of the four stages are zero.
 */
export function FunnelPanel({ stages }: { stages: FunnelStageView[] }) {
  const top = Math.max(1, stages[0]?.count ?? 0);

  return (
    <ol className="space-y-3">
      {stages.map((stage, index) => {
        const pct = Math.round((stage.count / top) * 100);
        return (
          <li key={stage.key}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <span className="text-sm font-medium text-ink">{stage.label}</span>
              <span className="text-sm font-semibold tabular-nums text-ink">{stage.count}</span>
            </div>
            <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-raised">
              <div
                className={cn(
                  'h-full rounded-full',
                  index === 0 ? 'bg-brand-500/40' : index === stages.length - 1 ? 'bg-success' : 'bg-brand-500',
                )}
                style={{ width: `${Math.max(stage.count > 0 ? 2 : 0, pct)}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-faint">
              {stage.conversion ? `${stage.conversion} · ${stage.note}` : stage.note}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

// --- Keyword list -----------------------------------------------------------

export interface KeywordRowView {
  keyword: string;
  count: number;
  /** Share of scored roles containing it, already formatted. */
  share: string;
  /** 0–100, for the bar. */
  percent: number;
}

export function KeywordList({
  rows,
  total,
  tone,
  emptyMessage,
}: {
  rows: KeywordRowView[];
  /** How many roles the counts are out of — stated once, per row it is implied. */
  total: number;
  tone: 'missing' | 'matched';
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">{emptyMessage}</p>;
  }

  return (
    <ol className="space-y-3">
      {rows.map((row, index) => (
        <li key={row.keyword}>
          <div className="flex items-baseline gap-3">
            <span className="w-4 shrink-0 text-xs font-semibold tabular-nums text-faint">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
              {row.keyword}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted">
              {row.count} of {total} · {row.share}
            </span>
          </div>
          <div className="ml-7 mt-1.5 h-1.5 overflow-hidden rounded-full bg-raised">
            <div
              className={cn(
                'h-full rounded-full',
                tone === 'missing' ? 'bg-warn' : 'bg-success',
              )}
              style={{ width: `${Math.max(2, Math.min(100, row.percent))}%` }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

// --- Section heading --------------------------------------------------------

export function SectionCard({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('p-5', className)}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </Card>
  );
}
