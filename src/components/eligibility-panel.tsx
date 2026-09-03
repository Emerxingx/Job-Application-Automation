import { AlertTriangle, CheckCircle2, HelpCircle, XCircle } from 'lucide-react';
import { Card } from '@/components/ui';
import type { EligibilityVerdict, RuleId } from '@/lib/eligibility/engine';

const RULE_LABELS: Record<RuleId, string> = {
  work_authorization: 'Work authorisation',
  sponsorship: 'Sponsorship',
  security_clearance: 'Security clearance',
  location: 'Location',
  licensure: 'Licence or certification',
  language: 'Language',
};

const OUTCOME = {
  eligible: { label: 'You are eligible', tone: 'text-success', icon: CheckCircle2, blurb: 'Every hard requirement the posting states is met by your profile.' },
  ineligible: { label: 'Not eligible', tone: 'text-danger', icon: XCircle, blurb: 'A hard requirement the posting states is not met. This posting is not in your feed; the reason is below.' },
  unknown: { label: 'Eligibility unconfirmed', tone: 'text-warning', icon: AlertTriangle, blurb: 'Something the posting states could not be checked against your profile. Nothing here excludes you; confirm before applying.' },
} as const;

/**
 * Stage 07: the eligibility verdict, rule by rule, in words. Never a score —
 * eligibility is evaluated before and apart from fit, and a candidate is
 * never shown a strong match for a role they are legally ineligible for.
 */
export function EligibilityPanel({ verdict, evaluatedAt }: { verdict: EligibilityVerdict; evaluatedAt: Date }) {
  const o = OUTCOME[verdict.outcome];
  const Icon = o.icon;
  return (
    <Card className="p-5" aria-labelledby="eligibility-heading">
      <div className="flex items-start gap-3">
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${o.tone}`} aria-hidden="true" />
        <div>
          <h2 id="eligibility-heading" className={`font-semibold ${o.tone}`}>
            {o.label}
          </h2>
          <p className="mt-1 text-xs text-muted">{o.blurb}</p>
        </div>
      </div>
      <ul className="mt-4 space-y-2.5 border-t border-line pt-4">
        {verdict.rules.map((r) => {
          const RuleIcon = r.status === 'pass' ? CheckCircle2 : r.status === 'fail' ? XCircle : HelpCircle;
          const tone = r.status === 'pass' ? 'text-success' : r.status === 'fail' ? 'text-danger' : 'text-warning';
          return (
            <li key={r.rule} className="flex items-start gap-2 text-sm">
              <RuleIcon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} aria-hidden="true" />
              <div>
                <span className="font-medium text-ink">{RULE_LABELS[r.rule]}</span>
                <span className="sr-only">: {r.status}</span>
                {!r.hard && <span className="ml-1 text-xs text-faint">(advisory)</span>}
                <p className="text-muted">{r.reason}</p>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-faint">
        Checked {evaluatedAt.toLocaleDateString('en-CA')} against your work authorisation, preferences, certifications and languages. Rules {verdict.rulesVersion}.
      </p>
    </Card>
  );
}
