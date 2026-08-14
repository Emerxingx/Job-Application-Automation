'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';
import { cn } from '@/components/ui';
import type { BillingInterval } from '@/lib/types';

export interface PlanView {
  code: string;
  name: string;
  tagline: string;
  monthlyPriceCents: number;
  quarterlyPriceCents: number;
  annualPriceCents: number;
  applicationsPerMonth: number;
  maxAgents: number;
  features: string[];
  highlight: boolean;
}

const INTERVALS: { value: BillingInterval; label: string; note?: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly', note: 'Save 10%' },
  { value: 'annual', label: 'Annual', note: 'Save 20%' },
];

function months(interval: BillingInterval): number {
  return interval === 'annual' ? 12 : interval === 'quarterly' ? 3 : 1;
}

function priceFor(plan: PlanView, interval: BillingInterval): number {
  if (interval === 'annual') return plan.annualPriceCents;
  if (interval === 'quarterly') return plan.quarterlyPriceCents;
  return plan.monthlyPriceCents;
}

export function PricingTable({
  plans,
  signedIn,
  currentPlanCode,
}: {
  plans: PlanView[];
  signedIn: boolean;
  currentPlanCode?: string;
}) {
  const [interval, setInterval] = useState<BillingInterval>('monthly');
  const [pending, setPending] = useState<string | null>(null);
  const router = useRouter();

  async function choose(planCode: string) {
    if (!signedIn) {
      router.push(`/signup?plan=${planCode}&interval=${interval}`);
      return;
    }

    setPending(planCode);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planCode, interval }),
      });
      const data = await res.json();
      if (res.ok) {
        router.push(data.url ?? '/dashboard/billing');
        router.refresh();
      } else {
        alert(data.error ?? 'Could not start checkout.');
      }
    } finally {
      setPending(null);
    }
  }

  return (
    <div>
      {/* Interval switcher */}
      <div
        className="mx-auto mb-10 flex w-fit items-center gap-1 rounded-2xl border border-line bg-surface p-1"
        role="tablist"
        aria-label="Billing interval"
      >
        {INTERVALS.map((opt) => (
          <button
            key={opt.value}
            role="tab"
            aria-selected={interval === opt.value}
            onClick={() => setInterval(opt.value)}
            className={cn(
              'relative rounded-xl px-4 py-2 text-sm font-semibold transition',
              interval === opt.value
                ? 'bg-brand-500 text-white'
                : 'text-muted hover:bg-raised hover:text-ink',
            )}
          >
            {opt.label}
            {opt.note && (
              <span
                className={cn(
                  'ml-1.5 text-xs font-medium',
                  interval === opt.value ? 'text-white/80' : 'text-success',
                )}
              >
                {opt.note}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {plans.map((plan) => {
          const total = priceFor(plan, interval);
          const perMonth = Math.round(total / months(interval) / 100);
          const isCurrent = currentPlanCode === plan.code;

          return (
            <div
              key={plan.code}
              className={cn(
                'card relative flex flex-col p-6',
                plan.highlight && 'border-brand-500 shadow-lift ring-1 ring-brand-500',
              )}
            >
              {plan.highlight && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand-500 px-3 py-1 text-xs font-semibold text-white">
                  Most popular
                </span>
              )}

              <div className="mb-5">
                <h3 className="text-lg font-bold text-ink">{plan.name}</h3>
                <p className="mt-1 text-sm text-muted">{plan.tagline}</p>
              </div>

              <div className="mb-5">
                <div className="flex items-baseline gap-1">
                  <span className="text-4xl font-bold tabular-nums text-ink">${perMonth}</span>
                  <span className="text-sm text-muted">/ month</span>
                </div>
                {interval !== 'monthly' && (
                  <p className="mt-1 text-xs text-muted">
                    ${(total / 100).toFixed(0)} billed {interval === 'annual' ? 'yearly' : 'quarterly'}
                  </p>
                )}
              </div>

              <div className="mb-5 rounded-xl bg-raised p-3">
                <p className="text-sm font-semibold text-ink">
                  {plan.applicationsPerMonth} applications / month
                </p>
                <p className="text-xs text-muted">
                  {plan.maxAgents} job agent{plan.maxAgents === 1 ? '' : 's'}
                </p>
              </div>

              <ul className="mb-6 flex-1 space-y-2.5">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-muted">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              {isCurrent ? (
                <span className="btn-secondary w-full cursor-default">Your current plan</span>
              ) : signedIn ? (
                <button
                  onClick={() => choose(plan.code)}
                  disabled={pending !== null}
                  className={cn('w-full', plan.highlight ? 'btn-primary' : 'btn-secondary')}
                >
                  {pending === plan.code && <Loader2 className="h-4 w-4 animate-spin" />}
                  {currentPlanCode ? 'Switch to this plan' : 'Choose plan'}
                </button>
              ) : (
                <Link
                  href={`/signup?plan=${plan.code}&interval=${interval}`}
                  className={cn('w-full', plan.highlight ? 'btn-primary' : 'btn-secondary')}
                >
                  Get started
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
