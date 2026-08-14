'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Loader2, Lock, UserCog } from 'lucide-react';
import { LIFECYCLE_STAGES } from '@/lib/crm/lifecycle';
import { Field, FieldGrid, Pill } from '../../ui';

const STAGE_LABEL: Record<string, string> = {
  lead: 'Lead',
  trial: 'Trial',
  active: 'Active',
  past_due: 'Past due',
  churned: 'Churned',
};

const SEGMENTS = [
  { value: 'self_serve', label: 'Self serve' },
  { value: 'smb', label: 'SMB' },
  { value: 'enterprise', label: 'Enterprise' },
];

export interface CrmPanelProps {
  userId: string;
  /** Whoever is looking, so "Assign to me" knows who "me" is. */
  staffId: string;
  staffName: string;
  /** Only billing_ops and above may write these fields — see the PATCH route. */
  canEdit: boolean;
  stage: string;
  segment: string;
  source: string;
  campaign: string | null;
  ownerStaffId: string | null;
  ownerName: string | null;
  vip: boolean;
  doNotContact: boolean;
  churnReason: string | null;
  metricsRefreshedLabel: string;
}

/**
 * The staff-owned half of a customer record.
 *
 * Two warnings are printed on the panel itself rather than left to tribal
 * knowledge, because both are easy to get wrong and expensive when they are:
 *
 *  - `lifecycleStage` is DERIVED. Setting it here is a correction that lasts
 *    until the next metrics refresh recomputes it from subscription signals.
 *    Judgement that has to persist belongs in segment, churn reason or a note.
 *  - `doNotContact` is a CASL consent flag, not a preference. Turning it on
 *    stops marketing contact; turning it off does not restore consent that was
 *    withdrawn.
 *
 * Every write goes through PATCH /api/console/customers/:id, which is what
 * writes the AuditLog row naming the actor and the fields that moved.
 */
export function CrmPanel(props: CrmPanelProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [refreshing, startTransition] = useTransition();

  const busy = saving !== null || refreshing;

  async function patch(field: string, body: Record<string, unknown>) {
    setSaving(field);
    setError(null);
    try {
      const response = await fetch(`/api/console/customers/${props.userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? `That change was not saved (${response.status}).`);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError('Could not reach the server. Nothing was changed.');
    } finally {
      setSaving(null);
    }
  }

  if (!props.canEdit) {
    return (
      <div className="card p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
          <UserCog className="h-4 w-4 text-muted" aria-hidden="true" />
          CRM
          <Pill tone="neutral">
            <Lock className="h-3 w-3" aria-hidden="true" />
            Read only
          </Pill>
        </h3>
        <ReadOnlyFields {...props} />
        <p className="mt-3 text-xs text-faint">
          Lifecycle, ownership and consent flags feed revenue reporting, so editing them needs
          billing operations access.
        </p>
      </div>
    );
  }

  return (
    <div className="card p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
        <UserCog className="h-4 w-4 text-muted" aria-hidden="true" />
        CRM
        {busy && (
          <Loader2
            className="h-3.5 w-3.5 animate-spin text-muted motion-reduce:animate-none"
            aria-label="Saving"
          />
        )}
      </h3>

      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="crm-stage" className="label text-xs">
              Lifecycle stage
            </label>
            <select
              id="crm-stage"
              value={props.stage}
              disabled={busy}
              onChange={(event) => void patch('stage', { lifecycleStage: event.target.value })}
              className="input py-2 text-sm disabled:opacity-60"
            >
              {LIFECYCLE_STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {STAGE_LABEL[stage]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="crm-segment" className="label text-xs">
              Segment
            </label>
            <select
              id="crm-segment"
              value={props.segment}
              disabled={busy}
              onChange={(event) => void patch('segment', { segment: event.target.value })}
              className="input py-2 text-sm disabled:opacity-60"
            >
              {SEGMENTS.map((segment) => (
                <option key={segment.value} value={segment.value}>
                  {segment.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <p className="label text-xs">Account owner</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-ink">
              {props.ownerName ?? <span className="text-faint">Unassigned</span>}
            </span>
            {props.ownerStaffId === props.staffId ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void patch('owner', { ownerStaffId: null })}
                className="btn-ghost px-2 py-1 text-xs"
              >
                Release
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void patch('owner', { ownerStaffId: props.staffId })}
                className="btn-secondary px-2 py-1 text-xs"
              >
                Assign to me
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={props.vip}
              disabled={busy}
              onChange={(event) => void patch('vip', { vip: event.target.checked })}
              className="h-4 w-4 rounded border-line accent-brand-500"
            />
            VIP
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={props.doNotContact}
              disabled={busy}
              onChange={(event) => void patch('dnc', { doNotContact: event.target.checked })}
              className="h-4 w-4 rounded border-line accent-danger"
            />
            Do not contact
          </label>
        </div>

        <FieldGrid>
          <Field label="Source">{props.source.replace(/_/g, ' ')}</Field>
          <Field label="Campaign">{props.campaign ?? '—'}</Field>
          <Field label="Churn reason">
            {props.churnReason ? props.churnReason.replace(/_/g, ' ') : '—'}
          </Field>
          <Field label="Metrics refreshed">{props.metricsRefreshedLabel}</Field>
        </FieldGrid>
      </div>

      <p className="mt-3 text-xs text-faint">
        Stage is recomputed from subscription signals — a change here holds until the next refresh.
        “Do not contact” is a CASL consent flag: switching it off does not restore withdrawn
        consent.
      </p>

      {error && (
        <p
          role="alert"
          className="mt-3 flex items-start gap-1.5 rounded-xl bg-danger/10 p-2.5 text-xs text-danger"
        >
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}

function ReadOnlyFields(props: CrmPanelProps) {
  return (
    <FieldGrid>
      <Field label="Lifecycle stage">{STAGE_LABEL[props.stage] ?? props.stage}</Field>
      <Field label="Segment">{props.segment.replace(/_/g, ' ')}</Field>
      <Field label="Account owner">{props.ownerName ?? 'Unassigned'}</Field>
      <Field label="Source">{props.source.replace(/_/g, ' ')}</Field>
      <Field label="VIP">{props.vip ? 'Yes' : 'No'}</Field>
      <Field label="Do not contact">{props.doNotContact ? 'Yes' : 'No'}</Field>
      <Field label="Campaign">{props.campaign ?? '—'}</Field>
      <Field label="Metrics refreshed">{props.metricsRefreshedLabel}</Field>
    </FieldGrid>
  );
}
