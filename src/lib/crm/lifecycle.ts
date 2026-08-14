/**
 * Lifecycle stage and churn-risk computation.
 *
 * Every number in this file is a named, documented constant and every risk
 * verdict comes back with the reasons that produced it. That is the point: a
 * support agent looking at an "at risk" badge must be able to answer "why?"
 * without reading source code, and a manager must be able to change a
 * threshold without discovering it in four different places.
 *
 * The module is PURE — no database, no clock of its own, no I/O. `now` is an
 * argument. That makes every boundary in here directly testable.
 *
 * VOCABULARY. Two columns, deliberately not one:
 *   - `stage` is where the account is in the funnel and mirrors the values
 *     documented on Customer.lifecycleStage (lead | trial | active | past_due
 *     | churned).
 *   - `risk` is how likely an account is to leave and mirrors
 *     Customer.riskLevel (normal | at_risk | critical).
 * A single "at-risk stage" column would have to overwrite "past_due", losing
 * the more specific fact. `view` below folds the two into the one badge the
 * console shows.
 *
 * ENTITLEMENT WARNING: nothing here decides what a customer may *do*. Access is
 * read from Subscription only. These values drive CRM triage and reporting and
 * are allowed to be stale.
 */

// --- Vocabulary -------------------------------------------------------------

export type LifecycleStage = 'lead' | 'trial' | 'active' | 'past_due' | 'churned';
export type RiskLevel = 'normal' | 'at_risk' | 'critical';

/** What the console prints in the single "stage" column. */
export type LifecycleView = LifecycleStage | 'at_risk';

export const LIFECYCLE_STAGES = ['lead', 'trial', 'active', 'past_due', 'churned'] as const;
export const RISK_LEVELS = ['normal', 'at_risk', 'critical'] as const;

export function isLifecycleStage(value: string): value is LifecycleStage {
  return (LIFECYCLE_STAGES as readonly string[]).includes(value);
}

export function isRiskLevel(value: string): value is RiskLevel {
  return (RISK_LEVELS as readonly string[]).includes(value);
}

// --- Thresholds -------------------------------------------------------------

/**
 * Every tunable, in one place, with the reasoning attached. Days are whole
 * days; usage is whole percent, compared with integer arithmetic so a
 * threshold never moves by a rounding error.
 */
export const LIFECYCLE_THRESHOLDS = {
  /** No product activity for this long is the first dormancy signal. */
  dormantDays: 21,
  /** Silence this long is treated as a stronger signal, not two signals. */
  deepDormantDays: 45,
  /** An account younger than this is never called dormant — it is just new. */
  newAccountGraceDays: 14,
  /** "Barely using it": at most this percent of the monthly allowance. */
  lowUsagePercent: 10,
  /** Ignore low usage until the billing window has had time to be used. */
  usageWindowGraceDays: 10,
  /** A trial or grace period ending within this many days is imminent. */
  endingSoonDays: 3,
  /** Weighted score at which an account becomes at_risk. */
  atRiskScore: 2,
  /** Weighted score at which an account becomes critical. */
  criticalScore: 5,
  /** Health starts at 100 and loses this much per unit of risk weight. */
  healthPenaltyPerPoint: 10,
  /** A lead has no paying relationship to score, so it sits mid-scale. */
  leadHealthScore: 50,
} as const;

export type RiskCode =
  | 'payment_failure'
  | 'grace_ending'
  | 'cancel_scheduled'
  | 'dormant'
  | 'deep_dormant'
  | 'quota_unused'
  | 'no_applications'
  | 'trial_ending_unused';

interface RuleDoc {
  code: RiskCode;
  label: string;
  weight: number;
  /** Plain-English rule, rendered in the console next to the badge. */
  description: string;
}

/**
 * The rule book. Weights are additive; `at_risk` at 2, `critical` at 5.
 *
 * Calibration, stated so it can be argued with:
 *  - `cancel_scheduled` alone is critical. The customer has already decided.
 *  - `payment_failure` (3) alone is at_risk, and becomes critical the moment a
 *    second signal joins it — a failed card plus silence is a lost account.
 *  - `dormant` (2) alone is at_risk: it is the earliest honest warning we have.
 *  - `deep_dormant` REPLACES `dormant` rather than stacking with it, so 45 days
 *    of silence is one loud signal, not two quiet ones counted twice.
 */
export const LIFECYCLE_RULE_BOOK: readonly RuleDoc[] = [
  {
    code: 'cancel_scheduled',
    label: 'Cancellation scheduled',
    weight: 5,
    description:
      'The subscription is set to end at the current period end. The decision is already made, so this is critical on its own.',
  },
  {
    code: 'payment_failure',
    label: 'Payment failing',
    weight: 3,
    description: `A payment failed in the last 30 days, an invoice is open past its due date, or the subscription is past due. Involuntary churn is the most recoverable kind — this is the queue to work first.`,
  },
  {
    code: 'grace_ending',
    label: 'Grace period ending',
    weight: 3,
    description: `Dunning grace ends within ${LIFECYCLE_THRESHOLDS.endingSoonDays} days, after which access is suspended.`,
  },
  {
    code: 'trial_ending_unused',
    label: 'Trial ending unused',
    weight: 3,
    description: `The trial ends within ${LIFECYCLE_THRESHOLDS.endingSoonDays} days and at most ${LIFECYCLE_THRESHOLDS.lowUsagePercent}% of the allowance has been used. A trial that converts has been used.`,
  },
  {
    code: 'deep_dormant',
    label: 'Deeply dormant',
    weight: 3,
    description: `No product activity for ${LIFECYCLE_THRESHOLDS.deepDormantDays} days or more.`,
  },
  {
    code: 'dormant',
    label: 'Dormant',
    weight: 2,
    description: `No product activity for ${LIFECYCLE_THRESHOLDS.dormantDays} days or more, on an account older than ${LIFECYCLE_THRESHOLDS.newAccountGraceDays} days.`,
  },
  {
    code: 'quota_unused',
    label: 'Allowance unused',
    weight: 2,
    description: `At most ${LIFECYCLE_THRESHOLDS.lowUsagePercent}% of this month's applications used, ${LIFECYCLE_THRESHOLDS.usageWindowGraceDays} or more days into the billing window. They are paying for something they are not using.`,
  },
  {
    code: 'no_applications',
    label: 'No applications in 30 days',
    weight: 2,
    description:
      'Zero applications submitted in the last 30 days. Applications are the value the product delivers; zero is the clearest possible statement that it is not delivering.',
  },
];

const RULE_BY_CODE = new Map<RiskCode, RuleDoc>(LIFECYCLE_RULE_BOOK.map((r) => [r.code, r]));

// --- Input ------------------------------------------------------------------

/**
 * Everything the computation is allowed to look at.
 *
 * `lastActivityAt` deserves a note: JobPilot has no last-login column, so the
 * newest ActivityEvent (scan, apply, tailor, prep, billing, agent) is the
 * proxy for "the customer showed up". It is a better proxy than a login would
 * be — signing in and doing nothing is not engagement.
 */
export interface LifecycleSignals {
  now: Date;
  /** User.createdAt. */
  signedUpAt: Date;
  /** Subscription.status, or null when the user never subscribed. */
  subscriptionStatus: string | null;
  cancelAtPeriodEnd?: boolean;
  trialEndsAt?: Date | null;
  graceEndsAt?: Date | null;
  /** Start of the current monthly application window. */
  periodStart?: Date | null;
  periodEnd?: Date | null;
  applicationsUsed?: number;
  /** Plan allowance plus any bonus applications. */
  applicationsLimit?: number;
  lastActivityAt?: Date | null;
  /** Payments with status "failed" in the last 30 days. */
  failedPaymentsLast30Days?: number;
  /** Invoices still open past their due date. */
  overdueInvoices?: number;
  applicationsLast30Days?: number;
}

export interface LifecycleReason {
  code: RiskCode;
  label: string;
  weight: number;
  /** The specific numbers behind this account's signal. */
  detail: string;
}

export interface LifecycleAssessment {
  stage: LifecycleStage;
  risk: RiskLevel;
  /** Stage with at_risk folded in — the single badge the console renders. */
  view: LifecycleView;
  /** 0-100. 100 is a healthy paying account, 0 is churned. */
  healthScore: number;
  /** Sum of the weights of the fired rules. */
  riskScore: number;
  reasons: LifecycleReason[];
  /** One sentence a support agent can read aloud. */
  summary: string;
}

// --- Small date helpers -----------------------------------------------------

const DAY_MS = 86_400_000;

/** Whole days elapsed since `date`. Negative when `date` is in the future. */
export function daysSince(date: Date | null | undefined, now: Date): number | null {
  if (!date) return null;
  return Math.floor((now.getTime() - date.getTime()) / DAY_MS);
}

/** Whole days until `date`. Negative once it has passed. */
export function daysUntil(date: Date | null | undefined, now: Date): number | null {
  if (!date) return null;
  return Math.floor((date.getTime() - now.getTime()) / DAY_MS);
}

/**
 * Percent of the allowance consumed, as a whole number. Integer arithmetic
 * throughout: `used * 100 <= limit * percent` never disagrees with itself the
 * way a float comparison at exactly 10% can.
 */
export function usagePercent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.floor((used * 100) / limit);
}

function atMostPercent(used: number, limit: number, percent: number): boolean {
  if (limit <= 0) return false;
  return used * 100 <= limit * percent;
}

// --- Stage ------------------------------------------------------------------

/**
 * Which funnel stage the subscription status puts the account in.
 *
 * Ordered, first match wins:
 *   R1 canceled / suspended        → churned
 *   R2 past_due / grace            → past_due
 *   R3 trialing                    → trial
 *   R4 active                      → active
 *   R5 no subscription, or a status we do not recognise → lead
 *
 * R5 is the fail-safe: an unclassifiable account is never reported as a paying
 * customer, so a typo in a status string understates revenue rather than
 * inventing it.
 */
export function stageForStatus(status: string | null | undefined): LifecycleStage {
  switch (status) {
    case 'canceled':
    case 'suspended':
      return 'churned';
    case 'past_due':
    case 'grace':
      return 'past_due';
    case 'trialing':
      return 'trial';
    case 'active':
      return 'active';
    default:
      return 'lead';
  }
}

// --- The computation --------------------------------------------------------

/**
 * Assess an account. Pure: same signals in, same verdict out, forever.
 */
export function computeLifecycle(signals: LifecycleSignals): LifecycleAssessment {
  const t = LIFECYCLE_THRESHOLDS;
  const now = signals.now;
  const stage = stageForStatus(signals.subscriptionStatus);

  const used = signals.applicationsUsed ?? 0;
  const limit = signals.applicationsLimit ?? 0;
  const accountAgeDays = daysSince(signals.signedUpAt, now) ?? 0;
  const silentDays = daysSince(signals.lastActivityAt, now);
  const failedPayments = signals.failedPaymentsLast30Days ?? 0;
  const overdue = signals.overdueInvoices ?? 0;
  // Deliberately NOT defaulted to 0: an omitted count means "not measured",
  // and defaulting it to zero would fire the no_applications rule against
  // every caller who did not supply it.
  const recentApplications = signals.applicationsLast30Days;

  const reasons: LifecycleReason[] = [];
  const add = (code: RiskCode, detail: string) => {
    const rule = RULE_BY_CODE.get(code);
    if (!rule) return;
    reasons.push({ code, label: rule.label, weight: rule.weight, detail });
  };

  // Churned accounts have already left; scoring their churn risk is noise in
  // the retention queue. Leads have no paying relationship to lose. Both skip
  // risk scoring entirely — filter by stage to find them.
  const scored = stage === 'trial' || stage === 'active' || stage === 'past_due';

  if (scored) {
    // --- Money -------------------------------------------------------------
    if (signals.cancelAtPeriodEnd) {
      add('cancel_scheduled', 'Set to cancel at the end of the current period.');
    }

    if (failedPayments > 0 || overdue > 0 || stage === 'past_due') {
      const parts: string[] = [];
      if (failedPayments > 0) {
        parts.push(`${failedPayments} failed payment${failedPayments === 1 ? '' : 's'} in 30 days`);
      }
      if (overdue > 0) {
        parts.push(`${overdue} invoice${overdue === 1 ? '' : 's'} past due`);
      }
      if (parts.length === 0) parts.push('subscription is past due');
      add('payment_failure', `${parts.join('; ')}.`);
    }

    const graceIn = daysUntil(signals.graceEndsAt, now);
    if (graceIn !== null && graceIn <= t.endingSoonDays) {
      add(
        'grace_ending',
        graceIn < 0
          ? 'Grace period has already expired; access should be suspended.'
          : `Grace period ends in ${graceIn} day${graceIn === 1 ? '' : 's'}.`,
      );
    }

    // --- Trial -------------------------------------------------------------
    if (stage === 'trial') {
      const trialIn = daysUntil(signals.trialEndsAt, now);
      if (
        trialIn !== null &&
        trialIn <= t.endingSoonDays &&
        atMostPercent(used, limit, t.lowUsagePercent)
      ) {
        add(
          'trial_ending_unused',
          `Trial ends in ${trialIn} day${trialIn === 1 ? '' : 's'} with ${used}/${limit} applications used.`,
        );
      }
    }

    // --- Engagement --------------------------------------------------------
    // Dormancy needs an account old enough to have had a chance to be used;
    // a three-day-old signup with no events is onboarding, not churning.
    if (accountAgeDays >= t.newAccountGraceDays) {
      const effectiveSilence = silentDays === null ? accountAgeDays : silentDays;
      const describeSilence =
        silentDays === null
          ? `No product activity ever recorded, ${accountAgeDays} days after signup.`
          : `No product activity for ${effectiveSilence} days.`;

      if (effectiveSilence >= t.deepDormantDays) {
        add('deep_dormant', describeSilence);
      } else if (effectiveSilence >= t.dormantDays) {
        add('dormant', describeSilence);
      }
    }

    // Paying for an allowance they are not spending. Only meaningful once the
    // window has had time to be used, and only where there is an allowance.
    const windowAgeDays = daysSince(signals.periodStart, now);
    if (
      limit > 0 &&
      windowAgeDays !== null &&
      windowAgeDays >= t.usageWindowGraceDays &&
      atMostPercent(used, limit, t.lowUsagePercent)
    ) {
      add(
        'quota_unused',
        `${used} of ${limit} applications used (${usagePercent(used, limit)}%), ${windowAgeDays} days into the billing window.`,
      );
    }

    // Distinct from quota_unused: that one is about the current window, this
    // one is a flat 30-day look-back that survives a window that just reset.
    if (recentApplications === 0 && accountAgeDays >= t.newAccountGraceDays) {
      add('no_applications', 'No applications submitted in the last 30 days.');
    }
  }

  const riskScore = reasons.reduce((sum, reason) => sum + reason.weight, 0);
  const risk: RiskLevel =
    riskScore >= t.criticalScore ? 'critical' : riskScore >= t.atRiskScore ? 'at_risk' : 'normal';

  const healthScore =
    stage === 'churned'
      ? 0
      : stage === 'lead'
        ? t.leadHealthScore
        : Math.max(0, Math.min(100, 100 - riskScore * t.healthPenaltyPerPoint));

  // at_risk replaces `active` and `trial` only. "past_due" already names the
  // reason and is more useful than the generic badge; churned and lead are not
  // risk-scored at all.
  const view: LifecycleView =
    risk !== 'normal' && (stage === 'active' || stage === 'trial') ? 'at_risk' : stage;

  return {
    stage,
    risk,
    view,
    healthScore,
    riskScore,
    reasons,
    summary: describeLifecycle(stage, risk, reasons),
  };
}

/** One sentence, safe to render straight into the console. */
export function describeLifecycle(
  stage: LifecycleStage,
  risk: RiskLevel,
  reasons: LifecycleReason[],
): string {
  const head = STAGE_SENTENCE[stage];
  if (risk === 'normal' || reasons.length === 0) return head;
  const ranked = [...reasons].sort((a, b) => b.weight - a.weight);
  const labels = ranked.map((r) => r.label.toLowerCase()).join(', ');
  const level = risk === 'critical' ? 'Critical risk' : 'At risk';
  return `${head} ${level}: ${labels}.`;
}

const STAGE_SENTENCE: Record<LifecycleStage, string> = {
  lead: 'Signed up but never subscribed.',
  trial: 'On trial.',
  active: 'Active paying customer.',
  past_due: 'Payment is overdue; access continues until the grace period ends.',
  churned: 'No longer subscribed.',
};

/** Human label for a stage or the folded view value. */
export const LIFECYCLE_LABELS: Record<LifecycleView, string> = {
  lead: 'Lead',
  trial: 'Trial',
  active: 'Active',
  at_risk: 'At risk',
  past_due: 'Past due',
  churned: 'Churned',
};
