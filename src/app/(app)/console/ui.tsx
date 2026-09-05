/**
 * Presentation shared across the console.
 *
 * Everything here is server-safe: no hooks, no browser APIs, no `'use client'`.
 * That matters because console pages are server components that need to format
 * money and render badges during SSR, and the exports of a `'use client'`
 * module cannot be *called* from the server — only rendered. So money
 * formatting here comes from `@/lib/analytics/types` (a pure module) rather
 * than from `@/components/data-table`, which is a client module.
 *
 * DESIGN RULE THAT RUNS THROUGH THE WHOLE FILE: state is encoded in FORM, not
 * only in colour. Every tone carries an icon and a weight change as well as a
 * hue, so "needs attention" survives a greyscale print, a projector, and the
 * ~8% of male staff with a colour vision deficiency. A red number that is only
 * red is a number nobody notices.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Info,
  Minus,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/components/ui';
import { formatCents, formatRate, type Rate } from '@/lib/analytics/types';
import { LIFECYCLE_LABELS, type LifecycleView, type RiskLevel } from '@/lib/crm/lifecycle';

// ---------------------------------------------------------------------------
// Tone
// ---------------------------------------------------------------------------

/**
 * The five states a console number can be in.
 *
 * `caution` and `critical` are separate on purpose: "watch this" and "act on
 * this today" are different instructions, and collapsing them means either the
 * urgent things get lost or everything is urgent.
 */
export type Tone = 'neutral' | 'brand' | 'positive' | 'caution' | 'critical';

interface ToneStyle {
  text: string;
  bg: string;
  border: string;
  /**
   * The accent bar's fill. Written out rather than derived from `text` at
   * runtime: Tailwind generates utilities by scanning source text, so a class
   * assembled with `.replace()` exists in the DOM and not in the stylesheet.
   */
  bar: string;
  icon: LucideIcon;
}

export const TONE_STYLES: Record<Tone, ToneStyle> = {
  neutral: { text: 'text-ink', bg: 'bg-raised', border: 'border-line', bar: 'bg-line', icon: Minus },
  brand: {
    text: 'text-brand-600',
    bg: 'bg-brand-500/10',
    border: 'border-brand-500/40',
    bar: 'bg-brand-500',
    icon: Info,
  },
  positive: {
    text: 'text-success',
    bg: 'bg-success/10',
    border: 'border-success/40',
    bar: 'bg-success',
    icon: CheckCircle2,
  },
  caution: {
    text: 'text-warn',
    bg: 'bg-warn/10',
    border: 'border-warn/40',
    bar: 'bg-warn',
    icon: AlertTriangle,
  },
  critical: {
    text: 'text-danger',
    bg: 'bg-danger/10',
    border: 'border-danger/40',
    bar: 'bg-danger',
    icon: ShieldAlert,
  },
};

// ---------------------------------------------------------------------------
// Money and rates
// ---------------------------------------------------------------------------

/** Integer cents as currency. Re-exported so pages import money from one place. */
export function money(cents: number, currency = 'CAD'): string {
  return formatCents(cents, currency);
}

/**
 * Money at a glance: `$41.2k`. For KPI tiles and axis-adjacent labels where the
 * exact cent is noise — the precise figure is always available beside it or in
 * the export.
 */
export function compactMoney(cents: number, currency = 'CAD'): string {
  const symbol = currency === 'USD' ? 'US$' : '$';
  const dollars = Math.round(cents / 100);
  const sign = dollars < 0 ? '-' : '';
  const value = Math.abs(dollars);
  if (value >= 1_000_000) return `${sign}${symbol}${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${sign}${symbol}${Math.round(value / 1000)}k`;
  if (value >= 1_000) return `${sign}${symbol}${(value / 1000).toFixed(1)}k`;
  return `${sign}${symbol}${value.toLocaleString('en-CA')}`;
}

/** Whole numbers with thousands separators. */
export function count(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-CA') : '—';
}

/** A `Rate` as a percentage, or an em dash when the denominator was zero. */
export function percent(value: Rate, digits = 1): string {
  return formatRate(value, digits);
}

/** Calendar day, stable wherever the server runs. */
export function day(date: Date | null | undefined): string {
  if (!date) return '—';
  return date.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Day and time — for support queues, where "this morning" is the whole point. */
export function dayTime(date: Date | null | undefined): string {
  if (!date) return '—';
  return date.toLocaleString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * "3 days ago" / "in 4 hours", computed against an explicit `now`.
 *
 * `formatRelative` in components/ui.tsx reads `Date.now()` internally, which
 * makes it non-deterministic across the SSR/hydration boundary. Console pages
 * pass the request's own clock so the server and the client agree.
 */
export function since(date: Date | null | undefined, now: Date): string {
  if (!date) return 'never';
  const ms = now.getTime() - date.getTime();
  const future = ms < 0;
  const abs = Math.abs(ms);
  const minutes = Math.floor(abs / 60_000);
  const phrase = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

  let body: string;
  if (minutes < 1) return future ? 'in a moment' : 'just now';
  if (minutes < 60) body = phrase(minutes, 'minute');
  else if (minutes < 1440) body = phrase(Math.floor(minutes / 60), 'hour');
  else if (minutes < 43_200) body = phrase(Math.floor(minutes / 1440), 'day');
  else body = phrase(Math.floor(minutes / 43_200), 'month');

  return future ? `in ${body}` : `${body} ago`;
}

// ---------------------------------------------------------------------------
// KPI tile
// ---------------------------------------------------------------------------

export interface KpiDelta {
  /** Already-formatted magnitude, e.g. "+$1,240" or "12 fewer". */
  label: string;
  direction: 'up' | 'down' | 'flat';
  /**
   * Whether the movement is good news. Decoupled from `direction` because up is
   * not always good — rising churn and rising MRR point the same way on screen
   * and in opposite directions for the business.
   */
  good?: boolean;
}

export interface KpiProps {
  label: string;
  value: string;
  hint?: ReactNode;
  tone?: Tone;
  delta?: KpiDelta;
  icon?: LucideIcon;
  /** Wraps the tile in a link — use it when the number has a working queue behind it. */
  href?: string;
}

/**
 * One headline number.
 *
 * The tile carries a left accent bar in its tone, so a row of KPIs shows which
 * one needs attention before any of the numbers have been read. Only `caution`
 * and `critical` also show a warning glyph — decorating healthy tiles too would
 * make the glyph mean nothing.
 */
export function Kpi({ label, value, hint, tone = 'neutral', delta, icon, href }: KpiProps) {
  const style = TONE_STYLES[tone];
  const Icon = icon;
  const alarming = tone === 'caution' || tone === 'critical';
  const AlarmIcon = style.icon;

  const body = (
    <>
      <span
        aria-hidden="true"
        className={cn('absolute inset-y-3 left-0 w-1 rounded-r-full', style.bar)}
      />
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-faint">{label}</p>
        {alarming ? (
          <AlarmIcon className={cn('h-4 w-4 shrink-0', style.text)} aria-hidden="true" />
        ) : (
          Icon && <Icon className="h-4 w-4 shrink-0 text-faint" aria-hidden="true" />
        )}
      </div>

      <p
        className={cn(
          'mt-1.5 text-2xl font-bold tabular-nums',
          tone === 'neutral' ? 'text-ink' : style.text,
        )}
      >
        {value}
      </p>

      {delta && <Delta {...delta} />}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </>
  );

  const className = cn(
    'card relative overflow-hidden p-4 pl-5',
    href && 'transition-colors duration-150 hover:bg-raised motion-reduce:transition-none',
  );

  if (href) {
    return (
      <Link href={href} className={cn(className, 'block')}>
        {body}
      </Link>
    );
  }
  return <div className={className}>{body}</div>;
}

/** The movement line under a KPI. Arrow direction is the shape; hue is the verdict. */
export function Delta({ label, direction, good }: KpiDelta) {
  const Arrow = direction === 'up' ? ArrowUpRight : direction === 'down' ? ArrowDownRight : Minus;
  const tone =
    good === undefined
      ? 'text-muted'
      : good
        ? 'text-success'
        : 'text-danger';

  return (
    <p className={cn('mt-1 flex items-center gap-1 text-xs font-medium tabular-nums', tone)}>
      <Arrow className="h-3 w-3 shrink-0" aria-hidden="true" />
      {label}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export function Pill({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  const style = TONE_STYLES[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-0.5 text-xs font-semibold',
        tone === 'neutral' ? 'bg-raised text-muted' : cn(style.bg, style.text),
        className,
      )}
    >
      {children}
    </span>
  );
}

const STAGE_TONE: Record<LifecycleView, Tone> = {
  lead: 'neutral',
  trial: 'brand',
  active: 'positive',
  at_risk: 'caution',
  past_due: 'critical',
  churned: 'neutral',
};

/** The single lifecycle badge — stage with at-risk folded in, per `LifecycleView`. */
export function StageBadge({ view }: { view: LifecycleView }) {
  return (
    <Pill tone={STAGE_TONE[view]} className={view === 'churned' ? 'line-through decoration-1' : ''}>
      {LIFECYCLE_LABELS[view]}
    </Pill>
  );
}

const RISK_TONE: Record<RiskLevel, Tone> = {
  normal: 'neutral',
  at_risk: 'caution',
  critical: 'critical',
};

const RISK_LABEL: Record<RiskLevel, string> = {
  normal: 'Healthy',
  at_risk: 'At risk',
  critical: 'Critical',
};

export function RiskBadge({ risk }: { risk: RiskLevel }) {
  return <Pill tone={RISK_TONE[risk]}>{RISK_LABEL[risk]}</Pill>;
}

const INVOICE_TONE: Record<string, { tone: Tone; label: string }> = {
  draft: { tone: 'neutral', label: 'Draft' },
  open: { tone: 'brand', label: 'Open' },
  past_due: { tone: 'critical', label: 'Past due' },
  paid: { tone: 'positive', label: 'Paid' },
  void: { tone: 'neutral', label: 'Void' },
  uncollectible: { tone: 'caution', label: 'Written off' },
};

/** `status` may be the raw column or the derived `past_due`. */
export function InvoiceBadge({ status }: { status: string }) {
  const meta = INVOICE_TONE[status] ?? { tone: 'neutral' as Tone, label: status };
  return <Pill tone={meta.tone}>{meta.label}</Pill>;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * A titled block. Console pages are dense, so every table and chart group gets
 * a heading a reader can scan and an `aria-labelledby` a screen reader can jump
 * between.
 */
export function Section({
  id,
  title,
  description,
  action,
  children,
  className,
}: {
  id: string;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={cn('mb-8', className)}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id={id} className="text-lg font-semibold text-ink">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * A segmented control made of links.
 *
 * Deliberately links rather than a client-side control: the reporting period
 * and the currency belong in the URL so a view can be bookmarked and pasted
 * into a ticket, the back button works, and the whole thing keeps working
 * before — or without — JavaScript. `DateRangePicker` in components/filters.tsx
 * is the right tool when the range only affects client-side state; here it
 * decides what the server queries.
 */
export function LinkTabs({
  label,
  options,
  current,
  className,
}: {
  label: string;
  options: readonly { value: string; label: string; href: string; title?: string }[];
  current: string;
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-xl border border-line bg-raised p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === current;
        return (
          <Link
            key={option.value}
            href={option.href}
            title={option.title}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors duration-150',
              'motion-reduce:transition-none',
              active ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink',
            )}
          >
            {option.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Label/value pair for the profile and subscription panels. */
export function Field({
  label,
  children,
  wide,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={cn('min-w-0', wide && 'sm:col-span-2')}>
      <dt className="text-xs font-medium uppercase tracking-wide text-faint">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

export function FieldGrid({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) {
  return (
    <dl
      className={cn(
        'grid gap-x-6 gap-y-4',
        cols === 3 ? 'sm:grid-cols-2 lg:grid-cols-3' : 'sm:grid-cols-2',
      )}
    >
      {children}
    </dl>
  );
}

/** The quiet fallback inside a panel that has nothing to show. */
export function Blank({ children }: { children: ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-muted">{children}</p>;
}

// ---------------------------------------------------------------------------
// Denial
// ---------------------------------------------------------------------------

/**
 * What a signed-in non-staff visitor sees.
 *
 * Says nothing about which role would have been enough, offers the way back to
 * the product, and does not render the console navigation — a list of the
 * internal pages is itself information a customer should not be handed.
 */
export function AccessDenied() {
  return (
    <section aria-labelledby="console-denied-title" className="flex min-h-screen items-center justify-center bg-bg px-4 py-16">
      <div className="card max-w-md p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-danger/10">
          <ShieldAlert className="h-6 w-6 text-danger" aria-hidden="true" />
        </div>
        <h1 id="console-denied-title" className="text-xl font-bold text-ink">This area is restricted to JobPilot staff</h1>
        <p className="mt-2 text-sm text-muted">
          Your account does not have console access. If you believe that is wrong, ask an
          administrator to check your staff permissions — they are granted deliberately, not by
          request from this page.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link href="/dashboard" className="btn-primary">
            Back to your dashboard
          </Link>
          <Link href="/" className="btn-secondary">
            Home
          </Link>
        </div>
      </div>
    </section>
  );
}
