import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  LIFECYCLE_THRESHOLDS,
  computeLifecycle,
  daysSince,
  daysUntil,
  stageForStatus,
  usagePercent,
  type LifecycleSignals,
} from '../src/lib/crm/lifecycle';
import {
  StaffAccessError,
  authorizeStaff,
  consoleRoute,
  effectiveStaffRole,
  isAllowlistedStaffEmail,
  isStaffRole,
  meetsStaffRole,
  parseStaffAllowlist,
  type StaffCandidate,
} from '../src/lib/crm/auth';
import { allowanceFor, mrrForSubscription, quotaSnapshot } from '../src/lib/crm/customers';
import { SLA_HOURS, formatTicketNumber, slaDueFor, visibleMessages } from '../src/lib/crm/tickets';

const NOW = new Date('2026-08-14T12:00:00.000Z');
const DAY = 86_400_000;

/** A date `days` before NOW. */
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
/** A date `days` after NOW. */
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY);

/**
 * A healthy active customer. Every lifecycle test starts here and changes one
 * signal, so a failure names the signal that broke rather than the fixture.
 */
function healthy(overrides: Partial<LifecycleSignals> = {}): LifecycleSignals {
  return {
    now: NOW,
    signedUpAt: ago(200),
    subscriptionStatus: 'active',
    cancelAtPeriodEnd: false,
    trialEndsAt: null,
    graceEndsAt: null,
    periodStart: ago(5),
    periodEnd: ahead(25),
    applicationsUsed: 12,
    applicationsLimit: 20,
    lastActivityAt: ago(1),
    failedPaymentsLast30Days: 0,
    overdueInvoices: 0,
    applicationsLast30Days: 9,
    ...overrides,
  };
}

const codes = (signals: LifecycleSignals) =>
  computeLifecycle(signals)
    .reasons.map((r) => r.code)
    .sort();

// ===========================================================================
// Date and usage helpers
// ===========================================================================

describe('lifecycle date helpers', () => {
  it('counts whole days elapsed and remaining', () => {
    assert.equal(daysSince(ago(3), NOW), 3);
    assert.equal(daysUntil(ahead(3), NOW), 3);
    assert.equal(daysSince(ahead(3), NOW), -3);
    assert.equal(daysUntil(ago(3), NOW), -3);
  });

  it('reports null for an absent date rather than pretending it is today', () => {
    assert.equal(daysSince(null, NOW), null);
    assert.equal(daysUntil(undefined, NOW), null);
  });

  it('floors partial days so "yesterday at 23:59" is not two days ago', () => {
    assert.equal(daysSince(new Date(NOW.getTime() - DAY - 1000), NOW), 1);
    assert.equal(daysSince(new Date(NOW.getTime() - DAY + 1000), NOW), 0);
  });
});

describe('usagePercent', () => {
  it('is integer percent of the allowance', () => {
    assert.equal(usagePercent(0, 20), 0);
    assert.equal(usagePercent(2, 20), 10);
    assert.equal(usagePercent(20, 20), 100);
  });

  it('treats a zero allowance as zero rather than dividing by it', () => {
    assert.equal(usagePercent(5, 0), 0);
  });
});

// ===========================================================================
// Stage — every value, including the ones that do not exist
// ===========================================================================

describe('stageForStatus', () => {
  it('maps each subscription status to its funnel stage', () => {
    assert.equal(stageForStatus('trialing'), 'trial');
    assert.equal(stageForStatus('active'), 'active');
    assert.equal(stageForStatus('past_due'), 'past_due');
    assert.equal(stageForStatus('grace'), 'past_due');
    assert.equal(stageForStatus('canceled'), 'churned');
    assert.equal(stageForStatus('suspended'), 'churned');
  });

  it('treats no subscription as a lead', () => {
    assert.equal(stageForStatus(null), 'lead');
    assert.equal(stageForStatus(undefined), 'lead');
  });

  it('fails safe on an unrecognised status — never reports it as paying', () => {
    // A typo in a status string must understate revenue, not invent it.
    assert.equal(stageForStatus('actve'), 'lead');
    assert.equal(stageForStatus(''), 'lead');
  });
});

describe('computeLifecycle — stages', () => {
  it('lead: signed up, never subscribed', () => {
    const result = computeLifecycle(healthy({ subscriptionStatus: null, signedUpAt: ago(90) }));
    assert.equal(result.stage, 'lead');
    assert.equal(result.view, 'lead');
    assert.equal(result.risk, 'normal');
    assert.equal(result.healthScore, LIFECYCLE_THRESHOLDS.leadHealthScore);
  });

  it('trial: on trial and using it', () => {
    const result = computeLifecycle(
      healthy({ subscriptionStatus: 'trialing', trialEndsAt: ahead(10) }),
    );
    assert.equal(result.stage, 'trial');
    assert.equal(result.view, 'trial');
    assert.equal(result.risk, 'normal');
  });

  it('active: a healthy paying customer scores 100 with no reasons', () => {
    const result = computeLifecycle(healthy());
    assert.equal(result.stage, 'active');
    assert.equal(result.view, 'active');
    assert.equal(result.risk, 'normal');
    assert.equal(result.riskScore, 0);
    assert.equal(result.healthScore, 100);
    assert.deepEqual(result.reasons, []);
  });

  it('past_due: keeps its own name in the badge instead of the generic at_risk', () => {
    const result = computeLifecycle(healthy({ subscriptionStatus: 'past_due' }));
    assert.equal(result.stage, 'past_due');
    assert.equal(result.view, 'past_due');
    assert.ok(result.reasons.some((r) => r.code === 'payment_failure'));
  });

  it('churned: terminal, scored zero, and not carrying churn risk', () => {
    for (const status of ['canceled', 'suspended']) {
      const result = computeLifecycle(
        healthy({ subscriptionStatus: status, cancelAtPeriodEnd: true, lastActivityAt: ago(300) }),
      );
      assert.equal(result.stage, 'churned', status);
      assert.equal(result.view, 'churned', status);
      // Already gone: it does not belong in the retention queue.
      assert.equal(result.risk, 'normal', status);
      assert.equal(result.healthScore, 0, status);
      assert.deepEqual(result.reasons, [], status);
    }
  });

  it('does not risk-score leads either — there is no paying relationship to lose', () => {
    const result = computeLifecycle(
      healthy({ subscriptionStatus: null, lastActivityAt: ago(300), applicationsLast30Days: 0 }),
    );
    assert.equal(result.stage, 'lead');
    assert.deepEqual(result.reasons, []);
  });
});

// ===========================================================================
// Risk rules — boundaries
// ===========================================================================

describe('computeLifecycle — dormancy boundary', () => {
  const base = { applicationsLast30Days: 4 };

  it(`is quiet one day short of ${LIFECYCLE_THRESHOLDS.dormantDays} days`, () => {
    assert.deepEqual(
      codes(healthy({ ...base, lastActivityAt: ago(LIFECYCLE_THRESHOLDS.dormantDays - 1) })),
      [],
    );
  });

  it(`fires dormant exactly at ${LIFECYCLE_THRESHOLDS.dormantDays} days`, () => {
    const result = computeLifecycle(
      healthy({ ...base, lastActivityAt: ago(LIFECYCLE_THRESHOLDS.dormantDays) }),
    );
    assert.deepEqual(
      result.reasons.map((r) => r.code),
      ['dormant'],
    );
    assert.equal(result.risk, 'at_risk');
    assert.equal(result.view, 'at_risk');
    assert.equal(result.riskScore, 2);
    assert.equal(result.healthScore, 80);
  });

  it(`escalates to deep_dormant exactly at ${LIFECYCLE_THRESHOLDS.deepDormantDays} days`, () => {
    assert.deepEqual(
      codes(healthy({ ...base, lastActivityAt: ago(LIFECYCLE_THRESHOLDS.deepDormantDays - 1) })),
      ['dormant'],
    );
    assert.deepEqual(
      codes(healthy({ ...base, lastActivityAt: ago(LIFECYCLE_THRESHOLDS.deepDormantDays) })),
      ['deep_dormant'],
    );
  });

  it('never counts dormant and deep_dormant together', () => {
    const result = computeLifecycle(healthy({ ...base, lastActivityAt: ago(200) }));
    assert.equal(result.reasons.filter((r) => r.code.endsWith('dormant')).length, 1);
  });

  it('treats "never active" as silence since signup, not as silence forever', () => {
    const young = computeLifecycle(
      healthy({ ...base, signedUpAt: ago(20), lastActivityAt: null, periodStart: ago(3) }),
    );
    assert.deepEqual(
      young.reasons.map((r) => r.code),
      [],
      '20 days old with no events is still under the 21-day dormancy line',
    );

    const older = computeLifecycle(
      healthy({ ...base, signedUpAt: ago(30), lastActivityAt: null, periodStart: ago(3) }),
    );
    assert.ok(older.reasons.some((r) => r.code === 'dormant'));
  });
});

describe('computeLifecycle — new-account grace boundary', () => {
  const quiet = { applicationsLast30Days: 0, lastActivityAt: ago(1), periodStart: ago(1) };

  it(`does not flag an account younger than ${LIFECYCLE_THRESHOLDS.newAccountGraceDays} days`, () => {
    assert.deepEqual(
      codes(healthy({ ...quiet, signedUpAt: ago(LIFECYCLE_THRESHOLDS.newAccountGraceDays - 1) })),
      [],
    );
  });

  it(`flags zero applications once the account is ${LIFECYCLE_THRESHOLDS.newAccountGraceDays} days old`, () => {
    assert.deepEqual(
      codes(healthy({ ...quiet, signedUpAt: ago(LIFECYCLE_THRESHOLDS.newAccountGraceDays) })),
      ['no_applications'],
    );
  });

  it('does not invent a no_applications signal when the count was never measured', () => {
    const signals = healthy({ signedUpAt: ago(60), lastActivityAt: ago(1), periodStart: ago(1) });
    delete signals.applicationsLast30Days;
    assert.deepEqual(codes(signals), []);
  });
});

describe('computeLifecycle — unused allowance boundary', () => {
  it(`stays quiet until ${LIFECYCLE_THRESHOLDS.usageWindowGraceDays} days into the window`, () => {
    assert.deepEqual(
      codes(
        healthy({
          applicationsUsed: 0,
          applicationsLimit: 20,
          periodStart: ago(LIFECYCLE_THRESHOLDS.usageWindowGraceDays - 1),
        }),
      ),
      [],
    );
  });

  it(`fires exactly at ${LIFECYCLE_THRESHOLDS.usageWindowGraceDays} days into the window`, () => {
    assert.deepEqual(
      codes(
        healthy({
          applicationsUsed: 0,
          applicationsLimit: 20,
          periodStart: ago(LIFECYCLE_THRESHOLDS.usageWindowGraceDays),
        }),
      ),
      ['quota_unused'],
    );
  });

  it(`treats exactly ${LIFECYCLE_THRESHOLDS.lowUsagePercent}% as low usage, and one more as fine`, () => {
    const window = { periodStart: ago(15), applicationsLimit: 20 };
    // 2/20 is exactly 10% — integer arithmetic, no float wobble at the edge.
    assert.deepEqual(codes(healthy({ ...window, applicationsUsed: 2 })), ['quota_unused']);
    assert.deepEqual(codes(healthy({ ...window, applicationsUsed: 3 })), []);
  });

  it('does not fire when there is no allowance to leave unused', () => {
    assert.deepEqual(
      codes(healthy({ applicationsUsed: 0, applicationsLimit: 0, periodStart: ago(20) })),
      [],
    );
  });
});

describe('computeLifecycle — money signals', () => {
  it('a failed payment alone is at_risk, not critical', () => {
    const result = computeLifecycle(healthy({ failedPaymentsLast30Days: 1 }));
    assert.deepEqual(
      result.reasons.map((r) => r.code),
      ['payment_failure'],
    );
    assert.equal(result.riskScore, 3);
    assert.equal(result.risk, 'at_risk');
  });

  it('an overdue invoice fires the same signal without a failed payment row', () => {
    assert.deepEqual(codes(healthy({ overdueInvoices: 2 })), ['payment_failure']);
  });

  it('past_due status fires it even before any payment or invoice has synced', () => {
    assert.deepEqual(
      codes(
        healthy({
          subscriptionStatus: 'past_due',
          failedPaymentsLast30Days: 0,
          overdueInvoices: 0,
        }),
      ),
      ['payment_failure'],
    );
  });

  it('a scheduled cancellation is critical on its own — the decision is made', () => {
    const result = computeLifecycle(healthy({ cancelAtPeriodEnd: true }));
    assert.deepEqual(
      result.reasons.map((r) => r.code),
      ['cancel_scheduled'],
    );
    assert.equal(result.riskScore, LIFECYCLE_THRESHOLDS.criticalScore);
    assert.equal(result.risk, 'critical');
    assert.equal(result.view, 'at_risk');
  });

  it(`flags a grace period ending within ${LIFECYCLE_THRESHOLDS.endingSoonDays} days`, () => {
    const soon = healthy({ subscriptionStatus: 'grace', graceEndsAt: ahead(3) });
    assert.deepEqual(codes(soon), ['grace_ending', 'payment_failure']);

    const later = healthy({ subscriptionStatus: 'grace', graceEndsAt: ahead(4) });
    assert.deepEqual(codes(later), ['payment_failure']);
  });

  it('past due with the grace clock running out is critical', () => {
    const result = computeLifecycle(
      healthy({ subscriptionStatus: 'past_due', graceEndsAt: ahead(1) }),
    );
    assert.equal(result.riskScore, 6);
    assert.equal(result.risk, 'critical');
    // past_due still names itself: it is more useful than the generic badge.
    assert.equal(result.view, 'past_due');
  });
});

describe('computeLifecycle — trial signals', () => {
  const trial = { subscriptionStatus: 'trialing', applicationsLimit: 20, periodStart: ago(2) };

  it('flags a trial ending unused', () => {
    const result = computeLifecycle(
      healthy({ ...trial, trialEndsAt: ahead(2), applicationsUsed: 1 }),
    );
    assert.deepEqual(
      result.reasons.map((r) => r.code),
      ['trial_ending_unused'],
    );
    assert.equal(result.view, 'at_risk');
  });

  it('leaves a trial ending well-used alone', () => {
    assert.deepEqual(codes(healthy({ ...trial, trialEndsAt: ahead(2), applicationsUsed: 15 })), []);
  });

  it(`only counts a trial ending within ${LIFECYCLE_THRESHOLDS.endingSoonDays} days`, () => {
    assert.deepEqual(
      codes(
        healthy({
          ...trial,
          trialEndsAt: ahead(LIFECYCLE_THRESHOLDS.endingSoonDays),
          applicationsUsed: 0,
        }),
      ),
      ['trial_ending_unused'],
    );
    assert.deepEqual(
      codes(
        healthy({
          ...trial,
          trialEndsAt: ahead(LIFECYCLE_THRESHOLDS.endingSoonDays + 1),
          applicationsUsed: 0,
        }),
      ),
      [],
    );
  });
});

describe('computeLifecycle — risk banding', () => {
  it(`is normal below ${LIFECYCLE_THRESHOLDS.atRiskScore}`, () => {
    assert.equal(computeLifecycle(healthy()).risk, 'normal');
  });

  it(`is at_risk from ${LIFECYCLE_THRESHOLDS.atRiskScore} to ${LIFECYCLE_THRESHOLDS.criticalScore - 1}`, () => {
    const two = computeLifecycle(healthy({ lastActivityAt: ago(21), applicationsLast30Days: 3 }));
    assert.equal(two.riskScore, 2);
    assert.equal(two.risk, 'at_risk');

    const four = computeLifecycle(
      healthy({
        lastActivityAt: ago(21),
        applicationsLast30Days: 3,
        applicationsUsed: 0,
        applicationsLimit: 20,
        periodStart: ago(20),
      }),
    );
    assert.equal(four.riskScore, 4);
    assert.equal(four.risk, 'at_risk');
  });

  it(`is critical from ${LIFECYCLE_THRESHOLDS.criticalScore}`, () => {
    const five = computeLifecycle(
      healthy({ failedPaymentsLast30Days: 1, lastActivityAt: ago(25), applicationsLast30Days: 2 }),
    );
    assert.equal(five.riskScore, 5);
    assert.equal(five.risk, 'critical');
  });

  it('subtracts health in step with the risk score and never goes below zero', () => {
    const result = computeLifecycle(
      healthy({
        cancelAtPeriodEnd: true,
        failedPaymentsLast30Days: 3,
        lastActivityAt: ago(120),
        applicationsLast30Days: 0,
        applicationsUsed: 0,
        applicationsLimit: 20,
        periodStart: ago(28),
      }),
    );
    assert.ok(result.riskScore >= 10);
    assert.equal(result.healthScore, 0);
  });

  it('explains itself: every reason carries a label and concrete numbers', () => {
    const result = computeLifecycle(
      healthy({ applicationsUsed: 1, applicationsLimit: 20, periodStart: ago(12) }),
    );
    const reason = result.reasons[0]!;
    assert.equal(reason.code, 'quota_unused');
    assert.equal(reason.label, 'Allowance unused');
    assert.match(reason.detail, /1 of 20 applications used \(5%\), 12 days into the billing window/);
    assert.match(result.summary, /At risk: allowance unused\./);
  });
});

// ===========================================================================
// Staff authorization — the part that keeps customers out of /console
// ===========================================================================

const ORIGINAL_STAFF_EMAILS = process.env.STAFF_EMAILS;

afterEach(() => {
  if (ORIGINAL_STAFF_EMAILS === undefined) delete process.env.STAFF_EMAILS;
  else process.env.STAFF_EMAILS = ORIGINAL_STAFF_EMAILS;
});

const customer: StaffCandidate = {
  id: 'user_customer',
  email: 'jobseeker@example.com',
  fullName: 'Alex Morgan',
  role: 'member',
};

const supportStaff: StaffCandidate = {
  id: 'user_support',
  email: 'dana@jobpilot.ai',
  fullName: 'Dana Reyes',
  role: 'support',
};

const admin: StaffCandidate = {
  id: 'user_admin',
  email: 'root@jobpilot.ai',
  fullName: 'Root',
  role: 'admin',
};

const ALLOWLIST = 'dana@jobpilot.ai, root@jobpilot.ai, ops@jobpilot.ai';

describe('parseStaffAllowlist', () => {
  it('accepts commas, semicolons, spaces and newlines', () => {
    assert.deepEqual(parseStaffAllowlist('a@x.com, b@x.com;c@x.com\nd@x.com e@x.com'), [
      'a@x.com',
      'b@x.com',
      'c@x.com',
      'd@x.com',
      'e@x.com',
    ]);
  });

  it('normalises case and whitespace, and de-duplicates', () => {
    assert.deepEqual(parseStaffAllowlist('  Dana@JobPilot.ai , dana@jobpilot.ai '), [
      'dana@jobpilot.ai',
    ]);
  });

  it('is empty for unset, blank or separator-only values', () => {
    assert.deepEqual(parseStaffAllowlist(undefined), []);
    assert.deepEqual(parseStaffAllowlist(null), []);
    assert.deepEqual(parseStaffAllowlist(''), []);
    assert.deepEqual(parseStaffAllowlist('   '), []);
    assert.deepEqual(parseStaffAllowlist(' , ; '), []);
  });

  it('refuses wildcards and bare domains — an allowlist that matches a domain is not an allowlist', () => {
    assert.deepEqual(parseStaffAllowlist('*'), []);
    assert.deepEqual(parseStaffAllowlist('@jobpilot.ai'), []);
    assert.deepEqual(parseStaffAllowlist('dana@'), []);
    assert.deepEqual(parseStaffAllowlist('dana'), []);
    assert.deepEqual(parseStaffAllowlist('a@b@c.com'), []);
    assert.deepEqual(parseStaffAllowlist('*, @jobpilot.ai, real@jobpilot.ai'), [
      'real@jobpilot.ai',
    ]);
  });
});

describe('isAllowlistedStaffEmail', () => {
  it('matches case-insensitively and ignores surrounding whitespace', () => {
    assert.equal(isAllowlistedStaffEmail(' DANA@jobpilot.ai ', ALLOWLIST), true);
  });

  it('does not match a lookalike address', () => {
    assert.equal(isAllowlistedStaffEmail('dana@jobpilot.ai.evil.com', ALLOWLIST), false);
    assert.equal(isAllowlistedStaffEmail('adana@jobpilot.ai', ALLOWLIST), false);
  });

  it('denies everyone when the allowlist is unset', () => {
    assert.equal(isAllowlistedStaffEmail('dana@jobpilot.ai', undefined), false);
    assert.equal(isAllowlistedStaffEmail('dana@jobpilot.ai', ''), false);
  });
});

describe('role ladder', () => {
  it('recognises exactly the three staff roles', () => {
    assert.equal(isStaffRole('support'), true);
    assert.equal(isStaffRole('billing_ops'), true);
    assert.equal(isStaffRole('admin'), true);
    assert.equal(isStaffRole('member'), false);
    assert.equal(isStaffRole('superuser'), false);
  });

  it('collapses an unknown or default role to the weakest staff level, never the strongest', () => {
    assert.equal(effectiveStaffRole('member'), 'support');
    assert.equal(effectiveStaffRole(''), 'support');
    assert.equal(effectiveStaffRole(null), 'support');
    assert.equal(effectiveStaffRole('root'), 'support');
    assert.equal(effectiveStaffRole('admin'), 'admin');
  });

  it('compares ranks in one direction only', () => {
    assert.equal(meetsStaffRole('admin', 'support'), true);
    assert.equal(meetsStaffRole('billing_ops', 'support'), true);
    assert.equal(meetsStaffRole('support', 'support'), true);
    assert.equal(meetsStaffRole('support', 'billing_ops'), false);
    assert.equal(meetsStaffRole('billing_ops', 'admin'), false);
  });
});

describe('authorizeStaff — default deny', () => {
  it('REFUSES EVERYONE when STAFF_EMAILS is unset, including an admin', () => {
    // Passing `undefined` does not bypass the parameter default — it triggers
    // it — so the ambient environment has to be cleared for this to test what
    // its name says. Without this the case silently inverts on any machine
    // whose .env sets STAFF_EMAILS, asserting 'allowlist_unset' against a
    // configured allowlist and passing only by accident. afterEach restores it.
    delete process.env.STAFF_EMAILS;
    for (const candidate of [customer, supportStaff, admin]) {
      const decision = authorizeStaff(candidate, 'support', undefined);
      assert.equal(decision.ok, false, candidate.email);
      assert.equal(decision.ok === false && decision.reason, 'allowlist_unset');
      assert.equal(decision.ok === false && decision.status, 403);
    }
  });

  it('reads process.env.STAFF_EMAILS by default, and denies when it is missing', () => {
    delete process.env.STAFF_EMAILS;
    const decision = authorizeStaff(admin, 'support');
    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.reason, 'allowlist_unset');
  });

  it('still denies when STAFF_EMAILS is present but empty or junk', () => {
    for (const value of ['', '   ', ' , ; ', '*', '@jobpilot.ai']) {
      const decision = authorizeStaff(admin, 'support', value);
      assert.equal(decision.ok, false, `value=${JSON.stringify(value)}`);
      assert.equal(decision.ok === false && decision.reason, 'allowlist_unset');
    }
  });
});

describe('authorizeStaff — a signed-in customer is refused', () => {
  it('refuses an ordinary customer even with the allowlist configured', () => {
    const decision = authorizeStaff(customer, 'support', ALLOWLIST);
    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.reason, 'not_allowlisted');
    assert.equal(decision.ok === false && decision.status, 403);
  });

  it('refuses a customer whose role column says admin — the database is not the gate', () => {
    // The exact failure the schema notes warned about: a mis-set role must not
    // be enough on its own to reach other people's data.
    const escalated: StaffCandidate = { ...customer, role: 'admin' };
    const decision = authorizeStaff(escalated, 'support', ALLOWLIST);
    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.reason, 'not_allowlisted');
  });

  it('refuses when there is no signed-in user at all, with 401 not 403', () => {
    const decision = authorizeStaff(null, 'support', ALLOWLIST);
    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.status, 401);
  });

  it('gives every denial the same message, so probing cannot map the org chart', () => {
    const messages = new Set(
      [
        authorizeStaff(customer, 'support', ALLOWLIST),
        authorizeStaff(admin, 'support', undefined),
        authorizeStaff(supportStaff, 'admin', ALLOWLIST),
        authorizeStaff({ ...admin, anonymizedAt: new Date() }, 'support', ALLOWLIST),
      ].map((d) => (d.ok === false ? d.message : 'ALLOWED')),
    );
    assert.deepEqual([...messages], ['This area is restricted to JobPilot staff.']);
  });
});

describe('authorizeStaff — admitting staff', () => {
  it('admits an allowlisted staff member at their stored role', () => {
    const decision = authorizeStaff(supportStaff, 'support', ALLOWLIST);
    assert.equal(decision.ok, true);
    assert.equal(decision.ok === true && decision.staff.role, 'support');
    assert.equal(decision.ok === true && decision.staff.id, 'user_support');
  });

  it('admits an allowlisted account whose role is still "member" at the weakest level', () => {
    const notYetPromoted: StaffCandidate = { ...supportStaff, role: 'member' };
    const decision = authorizeStaff(notYetPromoted, 'support', ALLOWLIST);
    assert.equal(decision.ok, true);
    assert.equal(decision.ok === true && decision.staff.role, 'support');
    assert.equal(decision.ok === true && decision.staff.storedRole, 'member');
  });

  it('refuses that same person anything above the weakest level', () => {
    const notYetPromoted: StaffCandidate = { ...supportStaff, role: 'member' };
    const decision = authorizeStaff(notYetPromoted, 'billing_ops', ALLOWLIST);
    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.reason, 'insufficient_role');
  });

  it('enforces the ladder for every rung', () => {
    const billing: StaffCandidate = { ...supportStaff, role: 'billing_ops' };
    assert.equal(authorizeStaff(billing, 'billing_ops', ALLOWLIST).ok, true);
    assert.equal(authorizeStaff(billing, 'admin', ALLOWLIST).ok, false);
    assert.equal(authorizeStaff(admin, 'admin', ALLOWLIST).ok, true);
  });

  it('refuses an anonymised account even when it is on the allowlist', () => {
    const erased: StaffCandidate = { ...admin, anonymizedAt: new Date('2026-01-01') };
    const decision = authorizeStaff(erased, 'support', ALLOWLIST);
    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.reason, 'anonymized');
  });
});

describe('consoleRoute', () => {
  it('turns a staff refusal into a 403 instead of a 500', async () => {
    const handler = consoleRoute(async () => {
      throw new StaffAccessError('not_allowlisted', 403, 'This area is restricted to JobPilot staff.');
    });
    const response = await handler();
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: 'This area is restricted to JobPilot staff.',
    });
  });

  it('passes a successful handler through untouched', async () => {
    const handler = consoleRoute(async () => Response.json({ ok: true }));
    const response = await handler();
    assert.equal(response.status, 200);
  });
});

// ===========================================================================
// Customer read helpers — the pure ones
// ===========================================================================

const PLAN = {
  code: 'professional',
  name: 'Professional',
  applicationsPerMonth: 60,
  monthlyPriceCents: 5900,
  quarterlyPriceCents: 15930,
  annualPriceCents: 56640,
};

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    status: 'active',
    interval: 'monthly',
    periodStart: ago(5),
    periodEnd: ahead(25),
    applicationsUsed: 10,
    bonusApplications: 0,
    trialEndsAt: null,
    graceEndsAt: null,
    cancelAtPeriodEnd: false,
    plan: PLAN,
    ...overrides,
  };
}

describe('mrrForSubscription', () => {
  it('normalises longer commitments down to a monthly figure', () => {
    assert.equal(mrrForSubscription(subscription()), 5900);
    assert.equal(mrrForSubscription(subscription({ interval: 'quarterly' })), 5310);
    assert.equal(mrrForSubscription(subscription({ interval: 'annual' })), 4720);
  });

  it('counts a past-due or grace subscription — the contract is still live', () => {
    assert.equal(mrrForSubscription(subscription({ status: 'past_due' })), 5900);
    assert.equal(mrrForSubscription(subscription({ status: 'grace' })), 5900);
  });

  it('counts nothing for a trial, a cancellation or no subscription at all', () => {
    assert.equal(mrrForSubscription(subscription({ status: 'trialing' })), 0);
    assert.equal(mrrForSubscription(subscription({ status: 'canceled' })), 0);
    assert.equal(mrrForSubscription(subscription({ status: 'suspended' })), 0);
    assert.equal(mrrForSubscription(null), 0);
  });

  it('treats an unrecognised interval as monthly rather than throwing', () => {
    assert.equal(mrrForSubscription(subscription({ interval: 'fortnightly' })), 5900);
  });
});

describe('allowanceFor', () => {
  it('adds bonus applications on top of the plan allowance', () => {
    assert.equal(allowanceFor(subscription()), 60);
    assert.equal(allowanceFor(subscription({ bonusApplications: 15 })), 75);
    assert.equal(allowanceFor(null), 0);
  });
});

describe('quotaSnapshot', () => {
  it('reports usage without rolling the window forward', () => {
    const snapshot = quotaSnapshot(subscription({ applicationsUsed: 15 }), NOW);
    assert.ok(snapshot);
    assert.equal(snapshot.used, 15);
    assert.equal(snapshot.limit, 60);
    assert.equal(snapshot.remaining, 45);
    assert.equal(snapshot.percentUsed, 25);
    assert.equal(snapshot.windowExpired, false);
  });

  it('reports an elapsed window as expired instead of resetting the counter', () => {
    // getQuota() would WRITE here, handing the customer a fresh month because
    // a staff member opened their record. This must only ever report.
    const snapshot = quotaSnapshot(
      subscription({ periodStart: ago(40), periodEnd: ago(10), applicationsUsed: 60 }),
      NOW,
    );
    assert.ok(snapshot);
    assert.equal(snapshot.windowExpired, true);
    assert.equal(snapshot.used, 0);
    assert.equal(snapshot.remaining, 60);
  });

  it('is null when there is no subscription', () => {
    assert.equal(quotaSnapshot(null, NOW), null);
  });
});

// ===========================================================================
// Ticket helpers
// ===========================================================================

describe('ticket numbering', () => {
  it('formats to the documented TKT-YYYY-NNNNNN shape', () => {
    assert.equal(formatTicketNumber(2026, 1), 'TKT-2026-000001');
    assert.equal(formatTicketNumber(2026, 123), 'TKT-2026-000123');
    assert.equal(formatTicketNumber(2026, 1_000_000), 'TKT-2026-1000000');
  });
});

describe('ticket SLA', () => {
  it('stamps a first-response target from the priority', () => {
    assert.equal(slaDueFor('urgent', NOW).getTime(), NOW.getTime() + SLA_HOURS.urgent * 3_600_000);
    assert.equal(slaDueFor('low', NOW).getTime(), NOW.getTime() + 72 * 3_600_000);
  });

  it('promises a faster response as priority rises', () => {
    assert.ok(SLA_HOURS.urgent < SLA_HOURS.high);
    assert.ok(SLA_HOURS.high < SLA_HOURS.normal);
    assert.ok(SLA_HOURS.normal < SLA_HOURS.low);
  });
});

describe('visibleMessages', () => {
  it('drops staff-only notes from a thread', () => {
    const messages = [
      {
        id: '1',
        authorType: 'customer',
        authorName: 'Alex',
        authorStaffId: null,
        body: 'My agent stopped.',
        internal: false,
        attachments: [],
        createdAt: NOW,
      },
      {
        id: '2',
        authorType: 'staff',
        authorName: 'Dana',
        authorStaffId: 'user_support',
        body: 'Refund risk — check the card on file.',
        internal: true,
        attachments: [],
        createdAt: NOW,
      },
    ];
    assert.deepEqual(
      visibleMessages(messages).map((m) => m.id),
      ['1'],
    );
  });
});
