// Dunning — what to do when a payment fails.
//
// THE POLICY, IN ONE PARAGRAPH
//
// A failed subscription payment is retried on days 0, 1, 3, 5 and 7 after the
// first failure. If all five attempts fail, the account enters a 3-day grace
// period during which the applicant keeps full access — they are mid-job-hunt,
// and cutting them off over an expired card loses a customer who wanted to
// pay. When grace expires the subscription is suspended and the invoice is
// marked exhausted. Any successful payment at any point recovers the account
// immediately.
//
// WHY THESE NUMBERS
//
// Day 0 catches a temporary hold; day 1 catches "my paycheque lands tomorrow";
// days 3, 5 and 7 spread the remaining attempts across a week so a monthly
// payday cycle gets at least one chance. Beyond ~7 days recovery rates
// collapse and card networks start charging for retrying a card that keeps
// declining, which is why attempt 6 does not exist. Every number is
// configurable per policy; these are the defaults.
//
// FOUR RULES THAT ARE NOT NEGOTIABLE
//
// 1. NEVER RETRY WHAT THE GATEWAY IS RETRYING. `DunningState.gatewayOwned` is
//    true when Stripe Smart Retries owns the schedule. Idempotency keys do NOT
//    protect us here — our retry is a different logical charge to Stripe, so
//    both would succeed and the customer would be billed twice. When the
//    gateway owns it we still run the access clock, but we never charge.
//
// 2. NEVER RETRY A HARD DECLINE. `stolen_card` does not become a valid card by
//    waiting two days. Retrying hard declines is what gets a merchant account
//    flagged. A hard decline goes straight to "we need a new card" and starts
//    the grace clock immediately.
//
// 3. NEVER BURN AN ATTEMPT WITH NO PAYMENT METHOD. If the card was removed or
//    expired, an attempt cannot succeed; asking for a new one is the only
//    move, and the retries stay in the bank for when it arrives.
//
// 4. GRACE IS A HALF-OPEN INTERVAL. Access continues while
//    `now < gracePeriodEndsAt` and stops at the instant it is reached. One
//    written-down convention, tested at the exact millisecond, so "does the
//    customer still have access?" has the same answer everywhere it is asked.
//
// This module is PURE. It reads no database, no clock and no environment: the
// current time is a parameter with a default. That is what makes "what happens
// on day 6 to an account with a hard decline and no card" a test rather than a
// production incident.

import { parseJson } from '@/lib/types';

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Day offsets from the FIRST failure, matching `DunningState.schedule`. */
export const DUNNING_SCHEDULE_DAYS: readonly number[] = [0, 1, 3, 5, 7];

/** Days of continued access after the last retry fails. */
export const DUNNING_GRACE_DAYS = 3;

/** Matches `DunningState.maxAttempts`. */
export const DUNNING_MAX_ATTEMPTS = 5;

export interface DunningPolicy {
  scheduleDays: readonly number[];
  graceDays: number;
  maxAttempts: number;
}

export const DEFAULT_DUNNING_POLICY: DunningPolicy = {
  scheduleDays: DUNNING_SCHEDULE_DAYS,
  graceDays: DUNNING_GRACE_DAYS,
  maxAttempts: DUNNING_MAX_ATTEMPTS,
};

/** `DunningState.state`. */
export type DunningStateName =
  | 'scheduled'
  | 'retrying'
  | 'awaiting_action'
  | 'grace'
  | 'recovered'
  | 'exhausted'
  | 'canceled';

/** `Invoice.dunningStage`. Kept in step with the state by every decision. */
export type DunningStage =
  | 'none'
  | 'retrying'
  | 'grace'
  | 'suspended'
  | 'exhausted'
  | 'recovered';

/** `DunningAttempt.outcome`. */
export type DunningOutcome =
  | 'pending'
  | 'succeeded'
  | 'soft_decline'
  | 'hard_decline'
  | 'error'
  | 'skipped_gateway_owned';

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

export type FailureClass =
  /** Might succeed on its own later — retry it. */
  | 'soft'
  /** Will never succeed with this instrument — do not retry. */
  | 'hard'
  /** Needs the customer to do something (new card, 3DS, bank approval). */
  | 'action_required'
  /** Our side or the network failed; the card was never asked. */
  | 'error'
  | 'unknown';

const SOFT_DECLINES = new Set([
  'insufficient_funds',
  'card_declined',
  'generic_decline',
  'do_not_honor',
  'try_again_later',
  'processing_error',
  'issuer_not_available',
  'reenter_transaction',
  'approve_with_id',
  'withdrawal_count_limit_exceeded',
  'card_velocity_exceeded',
  'INSTRUMENT_DECLINED',
]);

const HARD_DECLINES = new Set([
  'stolen_card',
  'lost_card',
  'pickup_card',
  'fraudulent',
  'card_not_supported',
  'currency_not_supported',
  'invalid_account',
  'restricted_card',
  'revocation_of_authorization',
  'transaction_not_allowed',
  'merchant_blacklist',
  'PAYER_ACCOUNT_RESTRICTED',
]);

const ACTION_REQUIRED = new Set([
  'expired_card',
  'incorrect_cvc',
  'incorrect_number',
  'invalid_cvc',
  'invalid_expiry_month',
  'invalid_expiry_year',
  'authentication_required',
  'payment_method_required',
  'no_payment_method',
  'PAYER_ACTION_REQUIRED',
]);

const ERRORS = new Set(['api_error', 'network_error', 'rate_limit', 'gateway_error', 'processing_timeout']);

/**
 * Map a gateway failure code to a retry class.
 *
 * Codes are kept raw on `Payment.failureCode` for triage; this is the only
 * place that decides what a code MEANS, so a new code from a new gateway is
 * one edit, not a search through the cron.
 */
export function classifyFailure(code: string | null | undefined): FailureClass {
  if (!code) return 'unknown';
  const normalized = code.trim();
  if (SOFT_DECLINES.has(normalized)) return 'soft';
  if (HARD_DECLINES.has(normalized)) return 'hard';
  if (ACTION_REQUIRED.has(normalized)) return 'action_required';
  if (ERRORS.has(normalized)) return 'error';

  const lower = normalized.toLowerCase();
  if (SOFT_DECLINES.has(lower)) return 'soft';
  if (HARD_DECLINES.has(lower)) return 'hard';
  if (ACTION_REQUIRED.has(lower)) return 'action_required';
  if (ERRORS.has(lower)) return 'error';
  return 'unknown';
}

/** Whether a class may be charged again on the schedule. */
export function isRetryable(failure: FailureClass): boolean {
  return failure === 'soft' || failure === 'unknown' || failure === 'error';
}

/** The `DunningAttempt.outcome` a failure class produces. */
export function outcomeForFailure(failure: FailureClass): DunningOutcome {
  switch (failure) {
    case 'hard':
      return 'hard_decline';
    case 'error':
      return 'error';
    case 'action_required':
      return 'hard_decline';
    default:
      return 'soft_decline';
  }
}

// ---------------------------------------------------------------------------
// Schedule arithmetic
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A "day" here is exactly 24 hours of absolute time, not the same wall-clock
 * time tomorrow. Retries are 24h apart across a DST boundary, and the grace
 * period is exactly 72 hours everywhere — no province gets an hour more or
 * less of a free product than another.
 */
export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

/**
 * Read `DunningState.schedule` (a JSON string column) into day offsets.
 *
 * Sanitised on the way in: non-integers, negatives and duplicates dropped,
 * ascending order forced. A malformed column falls back to the default policy
 * rather than producing a retry schedule of `NaN`.
 */
export function parseDunningSchedule(
  value: string | number[] | null | undefined,
  fallback: readonly number[] = DUNNING_SCHEDULE_DAYS,
): number[] {
  const raw = Array.isArray(value) ? value : parseJson<number[]>(value, [...fallback]);
  const clean = [...new Set(raw.filter((day) => Number.isInteger(day) && day >= 0))].sort((a, b) => a - b);
  return clean.length > 0 ? clean : [...fallback];
}

/** Serialise day offsets back into the column. */
export function serializeDunningSchedule(days: readonly number[]): string {
  return JSON.stringify([...days]);
}

/** `DunningAttempt.idempotencyKey` — deterministic, so a re-run cannot double-charge. */
export function dunningIdempotencyKey(invoiceId: string, attemptNumber: number): string {
  return `jp_dun_${invoiceId}_${attemptNumber}`;
}

export interface PlannedAttempt {
  attemptNumber: number;
  dayOffset: number;
  scheduledFor: Date;
}

export interface DunningTimeline {
  attempts: PlannedAttempt[];
  /** When the last retry is made. */
  finalAttemptAt: Date;
  /** Access continues until this instant, exclusive. */
  graceEndsAt: Date;
  /** The same instant, named for what happens at it. */
  suspendAt: Date;
}

function effectivePolicy(policy: Partial<DunningPolicy> = {}): DunningPolicy {
  const scheduleDays = parseDunningSchedule(
    policy.scheduleDays ? [...policy.scheduleDays] : null,
    DEFAULT_DUNNING_POLICY.scheduleDays,
  );
  const maxAttempts = Math.max(
    1,
    Math.min(policy.maxAttempts ?? DEFAULT_DUNNING_POLICY.maxAttempts, scheduleDays.length),
  );
  return {
    scheduleDays: scheduleDays.slice(0, maxAttempts),
    graceDays: Math.max(0, policy.graceDays ?? DEFAULT_DUNNING_POLICY.graceDays),
    maxAttempts,
  };
}

/**
 * The whole retry plan for one failure, computed up front.
 *
 * Useful three ways: the cron reads the next entry, /console renders the plan
 * to a staff member, and the customer's billing page can honestly say "we will
 * try again on the 14th, and access continues until the 21st".
 */
export function buildDunningTimeline(
  firstFailedAt: Date,
  policy: Partial<DunningPolicy> = {},
): DunningTimeline {
  const { scheduleDays, graceDays } = effectivePolicy(policy);

  const attempts = scheduleDays.map((dayOffset, index) => ({
    attemptNumber: index + 1,
    dayOffset,
    scheduledFor: addDays(firstFailedAt, dayOffset),
  }));

  const finalAttemptAt = attempts[attempts.length - 1]!.scheduledFor;
  const graceEndsAt = addDays(finalAttemptAt, graceDays);

  return { attempts, finalAttemptAt, graceEndsAt, suspendAt: graceEndsAt };
}

/** When attempt `n` (1-based) is due. Null once the schedule is exhausted. */
export function scheduledAttemptAt(
  firstFailedAt: Date,
  attemptNumber: number,
  policy: Partial<DunningPolicy> = {},
): Date | null {
  const { scheduleDays } = effectivePolicy(policy);
  const dayOffset = scheduleDays[attemptNumber - 1];
  return dayOffset === undefined ? null : addDays(firstFailedAt, dayOffset);
}

/** Access is live while `now < gracePeriodEndsAt`. Half-open, by convention. */
export function isWithinGrace(now: Date, gracePeriodEndsAt: Date | null | undefined): boolean {
  if (!gracePeriodEndsAt) return false;
  return now.getTime() < gracePeriodEndsAt.getTime();
}

/** Whole days of grace left, rounded up. Zero once grace has ended. */
export function graceDaysRemaining(now: Date, gracePeriodEndsAt: Date | null | undefined): number {
  if (!gracePeriodEndsAt) return 0;
  const ms = gracePeriodEndsAt.getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS);
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type DunningAction =
  /** Nothing is due yet. `runAt` says when to look again. */
  | 'wait'
  /** Charge the invoice now, using `idempotencyKey`. */
  | 'retry_payment'
  /** The gateway owns the retries. Record the skip; charge nothing. */
  | 'skip_gateway_owned'
  /** Only the customer can unblock this. Notify; do not charge. */
  | 'request_payment_method'
  /** Retries are done. Start the access countdown. */
  | 'enter_grace'
  /** Grace has ended. Cut access off. */
  | 'suspend'
  /** The invoice was paid. Close dunning out. */
  | 'mark_recovered'
  /** The invoice is void, or dunning is already finished. Stop. */
  | 'stop';

export type NotificationChannel = 'in_app' | 'email';

export interface DunningNotification {
  /** `Notification.type`, and the `EmailLog.template` when emailed. */
  template:
    | 'dunning.payment_failed'
    | 'dunning.action_required'
    | 'dunning.grace_started'
    | 'dunning.final_warning'
    | 'dunning.suspended'
    | 'dunning.recovered';
  channels: NotificationChannel[];
  /** `Notification.severity`. */
  severity: 'info' | 'success' | 'warning' | 'danger';
  /** `Notification.category` — billing mail is transactional, not marketing. */
  category: 'billing';
  title: string;
  body: string;
  /** `Notification.href`. */
  href: string;
}

export interface DunningDecision {
  action: DunningAction;
  /** What `DunningState.state` becomes. */
  nextState: DunningStateName;
  /** What `Invoice.dunningStage` becomes. */
  stage: DunningStage;
  /** True when the action should happen right now. */
  dueNow: boolean;
  /** The attempt this decision is about, or null when it is not a charge. */
  attemptNumber: number | null;
  /** `DunningAttempt.idempotencyKey`, when a charge is being made or skipped. */
  idempotencyKey: string | null;
  /** `DunningState.nextRetryAt` — when this or the next check is due. */
  runAt: Date | null;
  /** `DunningState.gracePeriodEndsAt`. */
  gracePeriodEndsAt: Date | null;
  /** True when the subscription must be suspended as part of applying this. */
  suspendSubscription: boolean;
  notification: DunningNotification | null;
  /** One sentence for the audit log and the /console row. */
  reason: string;
}

export interface DunningInput {
  invoiceId: string;
  /** `Invoice.status`. A paid or void invoice ends dunning whatever else is true. */
  invoiceStatus: InvoiceStatus;
  amountDueCents: number;
  /** Current `DunningState.state`. */
  state: DunningStateName;
  /** True when the gateway retries on its own. NEVER charge when true. */
  gatewayOwned: boolean;
  /** Retries already made. */
  attemptCount: number;
  /** When the first payment failed — the clock every offset is measured from. */
  firstFailedAt: Date;
  lastFailureCode?: string | null;
  /** Already-persisted grace end, when one has been set. */
  gracePeriodEndsAt?: Date | null;
  /**
   * False when the card was removed, expired or never captured. Retries are
   * pointless and are not consumed.
   */
  hasUsablePaymentMethod?: boolean;
  policy?: Partial<DunningPolicy>;
}

const BILLING_HREF = '/dashboard/billing';

function money(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  return `$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Decide what happens next for one failed invoice.
 *
 * Pure: same inputs, same answer, no clock and no I/O. The caller applies the
 * decision — writes the `DunningAttempt`, moves `DunningState`, sends the
 * notification — which is what makes this testable at 3am on a Tuesday in
 * March rather than only on the day the bug happens.
 */
export function computeNextAction(input: DunningInput, now: Date = new Date()): DunningDecision {
  const policy = effectivePolicy(input.policy);
  const timeline = buildDunningTimeline(input.firstFailedAt, policy);
  const graceEndsAt = input.gracePeriodEndsAt ?? timeline.graceEndsAt;

  // --- terminal conditions first -------------------------------------------

  if (input.invoiceStatus === 'paid' || input.amountDueCents <= 0) {
    return {
      action: 'mark_recovered',
      nextState: 'recovered',
      stage: 'recovered',
      dueNow: true,
      attemptNumber: null,
      idempotencyKey: null,
      runAt: null,
      gracePeriodEndsAt: null,
      suspendSubscription: false,
      notification: {
        template: 'dunning.recovered',
        channels: ['in_app'],
        severity: 'success',
        category: 'billing',
        title: 'Payment received',
        body: 'Thanks — your payment went through and your account is fully active.',
        href: BILLING_HREF,
      },
      reason: 'The invoice is settled; dunning is closed as recovered.',
    };
  }

  if (input.invoiceStatus === 'void' || input.invoiceStatus === 'uncollectible') {
    return stop(`The invoice is ${input.invoiceStatus}; there is nothing left to collect.`, 'canceled');
  }

  if (input.state === 'recovered' || input.state === 'canceled') {
    return stop('Dunning has already been closed for this invoice.', input.state);
  }

  if (input.state === 'exhausted') {
    return stop('Dunning is exhausted; the subscription is already suspended.', 'exhausted', 'suspended');
  }

  // --- grace has run out ---------------------------------------------------

  // Checked before anything that could charge: once access has been suspended
  // the only thing that reopens it is a successful payment, handled above.
  const graceExpired = !isWithinGrace(now, graceEndsAt);
  const retriesDone = input.attemptCount >= policy.maxAttempts;
  const failure = classifyFailure(input.lastFailureCode);
  const blockedOnCustomer =
    failure === 'hard' || failure === 'action_required' || input.hasUsablePaymentMethod === false;

  if (graceExpired && (retriesDone || blockedOnCustomer || input.state === 'grace')) {
    return {
      action: 'suspend',
      nextState: 'exhausted',
      stage: 'suspended',
      dueNow: true,
      attemptNumber: null,
      idempotencyKey: null,
      runAt: null,
      gracePeriodEndsAt: graceEndsAt,
      suspendSubscription: true,
      notification: {
        template: 'dunning.suspended',
        channels: ['in_app', 'email'],
        severity: 'danger',
        category: 'billing',
        title: 'Your subscription is paused',
        body:
          `We could not collect ${money(input.amountDueCents)} and the grace period has ended, so applications ` +
          'are paused. Update your payment method to pick up right where you left off — nothing is lost.',
        href: BILLING_HREF,
      },
      reason: `Grace ended at ${graceEndsAt.toISOString()}; suspending access.`,
    };
  }

  // --- the gateway is doing the retrying -----------------------------------

  if (input.gatewayOwned) {
    // The access clock still runs — a gateway that never recovers must not
    // leave a free account open forever — but we never send a charge.
    return {
      action: 'skip_gateway_owned',
      nextState: input.state === 'scheduled' ? 'retrying' : input.state,
      stage: 'retrying',
      dueNow: true,
      attemptNumber: input.attemptCount + 1,
      idempotencyKey: dunningIdempotencyKey(input.invoiceId, input.attemptCount + 1),
      runAt: graceEndsAt,
      gracePeriodEndsAt: graceEndsAt,
      suspendSubscription: false,
      notification: null,
      reason:
        'The gateway owns the retry schedule for this invoice; recording the skip instead of charging, ' +
        'because our retry would be a second charge to the gateway.',
    };
  }

  // --- the customer has to act ---------------------------------------------

  if (blockedOnCustomer) {
    const reason =
      failure === 'hard'
        ? `The last decline (${input.lastFailureCode}) is permanent for this card.`
        : input.hasUsablePaymentMethod === false
          ? 'There is no usable payment method on file.'
          : `The last failure (${input.lastFailureCode}) needs the cardholder to act.`;

    return {
      action: 'request_payment_method',
      nextState: 'awaiting_action',
      stage: 'grace',
      dueNow: true,
      attemptNumber: null,
      idempotencyKey: null,
      // Nothing to do until either the customer acts or grace runs out.
      runAt: graceEndsAt,
      gracePeriodEndsAt: graceEndsAt,
      suspendSubscription: false,
      notification: {
        template: 'dunning.action_required',
        channels: ['in_app', 'email'],
        severity: 'danger',
        category: 'billing',
        title: 'Your card needs attention',
        body:
          `We could not collect ${money(input.amountDueCents)}. Retrying will not help — please add a working ` +
          `card. Your account stays active for ${graceDaysRemaining(now, graceEndsAt)} more day(s).`,
        href: BILLING_HREF,
      },
      reason: `${reason} Retries are not consumed; waiting on the customer until grace ends.`,
    };
  }

  // --- retries remain ------------------------------------------------------

  if (!retriesDone) {
    const attemptNumber = input.attemptCount + 1;
    const dueAt = scheduledAttemptAt(input.firstFailedAt, attemptNumber, policy) ?? now;

    if (now.getTime() < dueAt.getTime()) {
      return {
        action: 'wait',
        nextState: input.state === 'scheduled' ? 'scheduled' : 'retrying',
        stage: 'retrying',
        dueNow: false,
        attemptNumber,
        idempotencyKey: null,
        runAt: dueAt,
        gracePeriodEndsAt: graceEndsAt,
        suspendSubscription: false,
        notification: null,
        reason: `Attempt ${attemptNumber} of ${policy.maxAttempts} is not due until ${dueAt.toISOString()}.`,
      };
    }

    const isFinal = attemptNumber === policy.maxAttempts;
    return {
      action: 'retry_payment',
      nextState: 'retrying',
      stage: 'retrying',
      dueNow: true,
      attemptNumber,
      idempotencyKey: dunningIdempotencyKey(input.invoiceId, attemptNumber),
      runAt: scheduledAttemptAt(input.firstFailedAt, attemptNumber + 1, policy) ?? graceEndsAt,
      gracePeriodEndsAt: graceEndsAt,
      suspendSubscription: false,
      notification: {
        template: isFinal ? 'dunning.final_warning' : 'dunning.payment_failed',
        channels: attemptNumber === 1 ? ['in_app'] : ['in_app', 'email'],
        severity: isFinal ? 'danger' : 'warning',
        category: 'billing',
        title: isFinal ? 'Last attempt to collect your payment' : 'We could not collect your payment',
        body: isFinal
          ? `This is our final attempt at ${money(input.amountDueCents)}. If it fails, your account stays ` +
            `active for ${policy.graceDays} more day(s) while you update your card.`
          : `We are retrying ${money(input.amountDueCents)} now. Nothing is paused — attempt ${attemptNumber} ` +
            `of ${policy.maxAttempts}.`,
        href: BILLING_HREF,
      },
      reason: `Attempt ${attemptNumber} of ${policy.maxAttempts} is due (scheduled ${dueAt.toISOString()}).`,
    };
  }

  // --- retries are exhausted, grace is running -----------------------------

  return {
    action: 'enter_grace',
    nextState: 'grace',
    stage: 'grace',
    // Entering grace is a state change worth writing once; re-entering it is
    // idempotent and simply refreshes the same end date.
    dueNow: input.state !== 'grace',
    attemptNumber: null,
    idempotencyKey: null,
    runAt: graceEndsAt,
    gracePeriodEndsAt: graceEndsAt,
    suspendSubscription: false,
    notification:
      input.state === 'grace'
        ? null
        : {
            template: 'dunning.grace_started',
            channels: ['in_app', 'email'],
            severity: 'warning',
            category: 'billing',
            title: 'Update your payment method to keep applying',
            body:
              `All ${policy.maxAttempts} attempts to collect ${money(input.amountDueCents)} failed. Your account ` +
              `stays fully active for ${graceDaysRemaining(now, graceEndsAt)} more day(s) — update your card and ` +
              'nothing changes.',
            href: BILLING_HREF,
          },
    reason: `All ${policy.maxAttempts} retries are spent; access continues until ${graceEndsAt.toISOString()}.`,
  };
}

function stop(reason: string, nextState: DunningStateName, stage: DunningStage = 'none'): DunningDecision {
  return {
    action: 'stop',
    nextState,
    stage,
    dueNow: false,
    attemptNumber: null,
    idempotencyKey: null,
    runAt: null,
    gracePeriodEndsAt: null,
    suspendSubscription: false,
    notification: null,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Applying an attempt's result
// ---------------------------------------------------------------------------

export interface AttemptResultInput {
  invoiceId: string;
  attemptNumber: number;
  succeeded: boolean;
  failureCode?: string | null;
  firstFailedAt: Date;
  gatewayOwned?: boolean;
  policy?: Partial<DunningPolicy>;
}

export interface AttemptResultDecision {
  outcome: DunningOutcome;
  nextState: DunningStateName;
  stage: DunningStage;
  attemptCount: number;
  nextRetryAt: Date | null;
  gracePeriodEndsAt: Date | null;
  reason: string;
}

/**
 * Fold one attempt's result into the dunning cursor.
 *
 * Separate from `computeNextAction` because they answer different questions —
 * "what should I do?" versus "what did doing it mean?" — and conflating them
 * is how a retry loop ends up recording an attempt it never made.
 */
export function applyAttemptResult(input: AttemptResultInput): AttemptResultDecision {
  const policy = effectivePolicy(input.policy);
  const timeline = buildDunningTimeline(input.firstFailedAt, policy);

  if (input.succeeded) {
    return {
      outcome: 'succeeded',
      nextState: 'recovered',
      stage: 'recovered',
      attemptCount: input.attemptNumber,
      nextRetryAt: null,
      gracePeriodEndsAt: null,
      reason: `Attempt ${input.attemptNumber} collected the invoice.`,
    };
  }

  if (input.gatewayOwned) {
    return {
      outcome: 'skipped_gateway_owned',
      nextState: 'retrying',
      stage: 'retrying',
      // A skip is not an attempt: it must not consume one of our retries.
      attemptCount: input.attemptNumber - 1,
      nextRetryAt: timeline.graceEndsAt,
      gracePeriodEndsAt: timeline.graceEndsAt,
      reason: 'The gateway owns this retry; no charge was sent.',
    };
  }

  const failure = classifyFailure(input.failureCode);
  const outcome = outcomeForFailure(failure);

  if (!isRetryable(failure)) {
    return {
      outcome,
      nextState: 'awaiting_action',
      stage: 'grace',
      attemptCount: input.attemptNumber,
      nextRetryAt: timeline.graceEndsAt,
      gracePeriodEndsAt: timeline.graceEndsAt,
      reason: `${input.failureCode ?? 'The decline'} cannot be retried; waiting on the customer.`,
    };
  }

  const nextAttempt = input.attemptNumber + 1;
  const nextRetryAt = scheduledAttemptAt(input.firstFailedAt, nextAttempt, policy);

  if (!nextRetryAt) {
    return {
      outcome,
      nextState: 'grace',
      stage: 'grace',
      attemptCount: input.attemptNumber,
      nextRetryAt: timeline.graceEndsAt,
      gracePeriodEndsAt: timeline.graceEndsAt,
      reason: `Attempt ${input.attemptNumber} was the last; grace runs to ${timeline.graceEndsAt.toISOString()}.`,
    };
  }

  return {
    outcome,
    nextState: 'retrying',
    stage: 'retrying',
    attemptCount: input.attemptNumber,
    nextRetryAt,
    gracePeriodEndsAt: timeline.graceEndsAt,
    reason: `Soft decline on attempt ${input.attemptNumber}; retrying at ${nextRetryAt.toISOString()}.`,
  };
}

/** `DunningAttempt.notifiedChannels` — a JSON string column, per the schema. */
export function serializeChannels(channels: readonly NotificationChannel[]): string {
  return JSON.stringify([...channels]);
}

/**
 * The cron's query shape, in one place.
 *
 * `DunningState` carries a `[state, nextRetryAt]` index for exactly this scan,
 * and these are the states that can still do something. `recovered`,
 * `exhausted` and `canceled` are terminal and must stay out of the sweep.
 */
export const DUNNING_ACTIONABLE_STATES: readonly DunningStateName[] = [
  'scheduled',
  'retrying',
  'awaiting_action',
  'grace',
];
