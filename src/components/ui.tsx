import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { ReactNode } from 'react';

export function cn(...inputs: Parameters<typeof clsx>): string {
  return twMerge(clsx(inputs));
}

// --- Match score ------------------------------------------------------------

/** Colour band for a 0-100 match score. */
export function scoreTone(score: number): {
  text: string;
  bg: string;
  ring: string;
  label: string;
} {
  if (score >= 85)
    return {
      text: 'text-success',
      bg: 'bg-success/10',
      ring: 'stroke-success',
      label: 'Excellent',
    };
  if (score >= 70)
    return { text: 'text-brand-600', bg: 'bg-brand-500/10', ring: 'stroke-brand-500', label: 'Strong' };
  if (score >= 55)
    return { text: 'text-warn', bg: 'bg-warn/10', ring: 'stroke-warn', label: 'Moderate' };
  return { text: 'text-faint', bg: 'bg-raised', ring: 'stroke-faint', label: 'Stretch' };
}

/** Circular success-probability dial. */
export function ScoreRing({ score, size = 56 }: { score: number; size?: number }) {
  const tone = scoreTone(score);
  const stroke = size >= 56 ? 5 : 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.max(0, Math.min(100, score)) / 100);

  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Match score ${score} out of 100 — ${tone.label}`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-line"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={tone.ring}
        />
      </svg>
      <span
        className={cn(
          'absolute inset-0 flex items-center justify-center font-bold tabular-nums',
          tone.text,
          size >= 56 ? 'text-base' : 'text-xs',
        )}
      >
        {score}
      </span>
    </div>
  );
}

// --- Status ----------------------------------------------------------------

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  queued: { bg: 'bg-raised', text: 'text-muted', label: 'Queued' },
  applying: { bg: 'bg-brand-500/10', text: 'text-brand-600', label: 'Applying' },
  submitted: { bg: 'bg-success/10', text: 'text-success', label: 'Submitted' },
  failed: { bg: 'bg-danger/10', text: 'text-danger', label: 'Needs attention' },
  interviewing: { bg: 'bg-brand-500/10', text: 'text-brand-600', label: 'Interviewing' },
  offer: { bg: 'bg-success/10', text: 'text-success', label: 'Offer' },
  rejected: { bg: 'bg-raised', text: 'text-faint', label: 'Not selected' },
  withdrawn: { bg: 'bg-raised', text: 'text-faint', label: 'Withdrawn' },
  active: { bg: 'bg-success/10', text: 'text-success', label: 'Active' },
  paused: { bg: 'bg-raised', text: 'text-faint', label: 'Paused' },
  new: { bg: 'bg-brand-500/10', text: 'text-brand-600', label: 'New' },
  reviewed: { bg: 'bg-raised', text: 'text-muted', label: 'Reviewed' },
  applied: { bg: 'bg-success/10', text: 'text-success', label: 'Applied' },
  dismissed: { bg: 'bg-raised', text: 'text-faint', label: 'Dismissed' },
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? { bg: 'bg-raised', text: 'text-muted', label: status };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-lg px-2 py-0.5 text-xs font-semibold',
        style.bg,
        style.text,
      )}
    >
      {style.label}
    </span>
  );
}

// --- Layout primitives ------------------------------------------------------

export function Card({
  children,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article' | 'li';
}) {
  return <Tag className={cn('card', className)}>{children}</Tag>;
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </header>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-raised text-muted">
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-muted">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'success' | 'brand';
}) {
  return (
    <div className="card p-4">
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
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** Horizontal quota / progress meter. */
export function Meter({
  used,
  total,
  label,
}: {
  used: number;
  total: number;
  label?: string;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const tone = pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warn' : 'bg-brand-500';

  return (
    <div>
      {label && (
        <div className="mb-1.5 flex items-baseline justify-between text-xs">
          <span className="font-medium text-muted">{label}</span>
          <span className="tabular-nums text-faint">
            {used} / {total}
          </span>
        </div>
      )}
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-raised"
        role="progressbar"
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={label ?? 'Usage'}
      >
        <div className={cn('h-full rounded-full transition-all duration-500', tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function formatRelative(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86400000);

  if (days === 0) {
    const hours = Math.floor(diff / 3600000);
    if (hours === 0) {
      const mins = Math.floor(diff / 60000);
      return mins <= 1 ? 'Just now' : `${mins} minutes ago`;
    }
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} week${days < 14 ? '' : 's'} ago`;
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatSalary(
  min?: number | null,
  max?: number | null,
  currency = 'CAD',
): string {
  if (!min && !max) return 'Not disclosed';
  const fmt = (n: number) => `${Math.round(n / 1000)}k`;
  if (min && max) return `${currency} ${fmt(min)}–${fmt(max)}`;
  return `${currency} ${fmt((min || max)!)}`;
}
