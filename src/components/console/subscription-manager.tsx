'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ShieldAlert } from 'lucide-react';
import type { BillingInterval } from '@/lib/types';
import {
  cancelAtPeriodEndAction,
  changePlanAction,
  grantBonusApplicationsAction,
  reactivateSubscriptionAction,
} from '@/app/(app)/console/customers/actions';

/**
 * The subscription-management panel on a client's 360° page.
 *
 * Every action funnels through the server actions in
 * console/customers/actions.ts — billing_ops-gated, reason-required,
 * audited. This component is purely the form surface: it collects a choice
 * and a written reason, shows the outcome, and refreshes the page so the
 * read-model above it reflects the change.
 */

export interface PlanOption {
  code: string;
  name: string;
}

type PanelMode = 'closed' | 'plan' | 'grant' | 'cancel' | 'reactivate';

export function SubscriptionManager({
  userId,
  currentPlanCode,
  currentInterval,
  cancelAtPeriodEnd,
  plans,
}: {
  userId: string;
  currentPlanCode: string;
  currentInterval: string;
  cancelAtPeriodEnd: boolean;
  plans: PlanOption[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<PanelMode>('closed');
  const [planCode, setPlanCode] = useState(currentPlanCode);
  const [interval, setInterval] = useState<BillingInterval>(
    (['monthly', 'quarterly', 'annual'].includes(currentInterval)
      ? currentInterval
      : 'monthly') as BillingInterval,
  );
  const [count, setCount] = useState(10);
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<{ ok: boolean; message: string }>) {
    setResult(null);
    startTransition(async () => {
      const r = await action();
      setResult(r);
      if (r.ok) {
        setMode('closed');
        setReason('');
        router.refresh();
      }
    });
  }

  const reasonField = (
    <div>
      <label className="label" htmlFor="mgmt-reason">
        Reason (recorded in the audit log)
      </label>
      <textarea
        id="mgmt-reason"
        className="input min-h-[70px] w-full"
        placeholder="Ticket number, conversation, agreement — why this change is being made."
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
    </div>
  );

  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-faint">Manage</span>
        <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => setMode(mode === 'plan' ? 'closed' : 'plan')}>
          Change plan
        </button>
        <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => setMode(mode === 'grant' ? 'closed' : 'grant')}>
          Grant applications
        </button>
        {cancelAtPeriodEnd ? (
          <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => setMode(mode === 'reactivate' ? 'closed' : 'reactivate')}>
            Reactivate
          </button>
        ) : (
          <button type="button" className="btn-secondary px-3 py-1.5 text-xs text-danger" onClick={() => setMode(mode === 'cancel' ? 'closed' : 'cancel')}>
            Cancel at period end
          </button>
        )}
      </div>

      {mode === 'plan' && (
        <div className="mt-4 space-y-3 rounded-lg border border-line bg-raised p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="mgmt-plan">New plan</label>
              <select id="mgmt-plan" className="input w-full" value={planCode} onChange={(e) => setPlanCode(e.target.value)}>
                {plans.map((p) => (
                  <option key={p.code} value={p.code}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="mgmt-interval">Interval</label>
              <select id="mgmt-interval" className="input w-full" value={interval} onChange={(e) => setInterval(e.target.value as BillingInterval)}>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="annual">Annual</option>
              </select>
            </div>
          </div>
          {reasonField}
          <button
            type="button"
            className="btn-primary"
            disabled={pending}
            onClick={() => run(() => changePlanAction({ userId, planCode, interval, reason }))}
          >
            {pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Apply plan change
          </button>
        </div>
      )}

      {mode === 'grant' && (
        <div className="mt-4 space-y-3 rounded-lg border border-line bg-raised p-4">
          <div>
            <label className="label" htmlFor="mgmt-count">Bonus applications (1–500)</label>
            <input
              id="mgmt-count"
              type="number"
              min={1}
              max={500}
              className="input w-32"
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            />
          </div>
          {reasonField}
          <button
            type="button"
            className="btn-primary"
            disabled={pending}
            onClick={() => run(() => grantBonusApplicationsAction({ userId, count, reason }))}
          >
            {pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Grant
          </button>
        </div>
      )}

      {mode === 'cancel' && (
        <div className="mt-4 space-y-3 rounded-lg border border-danger/40 bg-danger/5 p-4">
          <p className="flex items-start gap-2 text-sm text-muted">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            The client keeps access until the current period ends. Immediate termination with refund
            is a gateway operation and is deliberately not offered here.
          </p>
          {reasonField}
          <button
            type="button"
            className="btn-primary"
            disabled={pending}
            onClick={() => run(() => cancelAtPeriodEndAction({ userId, reason }))}
          >
            {pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Confirm cancellation
          </button>
        </div>
      )}

      {mode === 'reactivate' && (
        <div className="mt-4 space-y-3 rounded-lg border border-line bg-raised p-4">
          {reasonField}
          <button
            type="button"
            className="btn-primary"
            disabled={pending}
            onClick={() => run(() => reactivateSubscriptionAction({ userId, reason }))}
          >
            {pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Reactivate subscription
          </button>
        </div>
      )}

      {result && (
        <p className={`mt-3 text-sm ${result.ok ? 'text-success' : 'text-danger'}`}>{result.message}</p>
      )}
    </div>
  );
}
