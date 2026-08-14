import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  average,
  formatCents,
  formatDurationHours,
  formatRate,
  median,
  percentile,
  rate,
} from '../src/lib/analytics/types';
import type {
  ApplicationRow,
  DateRange,
  InvoiceRow,
  PaymentRow,
  SubscriptionEventRow,
  SubscriptionRow,
  UsageEventRow,
  UsageRollupRow,
} from '../src/lib/analytics/types';
import {
  buildBuckets,
  dayKey,
  eachDayKey,
  parseDayKey,
  rangeOfDays,
  snapToUtcDays,
  startOfUtcWeek,
} from '../src/lib/analytics/time';
import {
  applicationsByCompany,
  computeApplicationMetrics,
  computeMatchMetrics,
  matchScoreDistribution,
  matchScoreTrend,
  stageOf,
  timeToFirstResponse,
  topMissingKeywords,
} from '../src/lib/analytics/metrics';
import {
  computeChurn,
  computeCustomerLtv,
  computeDunningRecovery,
  computeLtv,
  computeMovement,
  computeMrrSnapshot,
  computePaymentHealth,
  computeRevenueTotals,
  monthlyNormalizedCents,
  mrrAtInstant,
  subscriptionMrrCents,
} from '../src/lib/analytics/revenue';
import {
  aggregateUsageEvents,
  backfillUsageRollups,
  computeDailyMetricRows,
  computeDailyRevenueRows,
  rollupUsage,
} from '../src/lib/analytics/rollups';
import type { UsageRollupDeps } from '../src/lib/analytics/rollups';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const at = (iso: string) => new Date(iso);

/** A week in January 2026 that runs into February — the boundary cases. */
const JANUARY_END: DateRange = {
  start: at('2026-01-26T00:00:00.000Z'),
  end: at('2026-02-03T00:00:00.000Z'),
};

function application(overrides: Partial<ApplicationRow> = {}): ApplicationRow {
  return {
    id: 'app_1',
    status: 'submitted',
    matchScore: 80,
    createdAt: at('2026-01-27T12:00:00.000Z'),
    appliedAt: at('2026-01-27T12:00:00.000Z'),
    respondedAt: null,
    company: 'Acme',
    location: 'Toronto, ON',
    ...overrides,
  };
}

function subscription(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: 'sub_1',
    userId: 'user_1',
    status: 'active',
    planCode: 'professional',
    planName: 'Professional',
    interval: 'monthly',
    currency: 'CAD',
    mrrCents: 0,
    planPriceCents: 5900,
    startedAt: at('2026-01-01T00:00:00.000Z'),
    canceledAt: null,
    ...overrides,
  };
}

function event(overrides: Partial<SubscriptionEventRow> = {}): SubscriptionEventRow {
  return {
    userId: 'user_1',
    subscriptionId: 'sub_1',
    type: 'created',
    movement: 'new',
    mrrBeforeCents: 0,
    mrrAfterCents: 5900,
    deltaMrrCents: 5900,
    occurredAt: at('2026-01-27T00:00:00.000Z'),
    ...overrides,
  };
}

function payment(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: 'pay_1',
    userId: 'user_1',
    status: 'succeeded',
    currency: 'CAD',
    amountCents: 5900,
    amountRefundedCents: 0,
    feeCents: 201,
    failureCode: null,
    createdAt: at('2026-01-27T10:00:00.000Z'),
    succeededAt: at('2026-01-27T10:00:00.000Z'),
    failedAt: null,
    ...overrides,
  };
}

function invoice(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: 'inv_1',
    userId: 'user_1',
    status: 'paid',
    currency: 'CAD',
    subtotalCents: 5900,
    discountCents: 0,
    taxCents: 767,
    totalCents: 6667,
    amountPaidCents: 6667,
    amountRefundedCents: 0,
    amountCreditedCents: 0,
    issuedAt: at('2026-01-27T09:00:00.000Z'),
    createdAt: at('2026-01-27T09:00:00.000Z'),
    ...overrides,
  };
}

function usage(overrides: Partial<UsageEventRow> = {}): UsageEventRow {
  return {
    userId: 'user_1',
    name: 'application.submitted',
    quantity: 1,
    valueCents: 0,
    occurredAt: at('2026-01-27T08:00:00.000Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

describe('rate', () => {
  it('guards division by zero instead of returning NaN', () => {
    const result = rate(5, 0);
    assert.equal(result.parts, 0);
    assert.equal(result.denominator, 0);
    assert.ok(Number.isFinite(result.parts));
  });

  it('treats a negative denominator as no data', () => {
    assert.equal(rate(5, -3).parts, 0);
  });

  it('expresses a ratio in parts per million', () => {
    assert.equal(rate(1, 4).parts, 250_000);
    assert.equal(rate(3, 3).parts, 1_000_000);
  });

  it('keeps the sign on a negative numerator', () => {
    assert.equal(rate(-1, 2).parts, -500_000);
  });

  it('renders an em dash rather than 0% when there is no denominator', () => {
    assert.equal(formatRate(rate(0, 0)), '—');
    assert.equal(formatRate(rate(1, 8)), '12.5%');
  });
});

describe('summary statistics', () => {
  it('returns zero for empty input rather than NaN', () => {
    assert.equal(average([]), 0);
    assert.equal(median([]), 0);
    assert.equal(percentile([], 0.9), 0);
  });

  it('averages the two middle values on an even count', () => {
    assert.equal(median([2, 4]), 3);
    assert.equal(median([1, 2, 3]), 2);
  });

  it('takes the nearest rank for a percentile, unsorted input allowed', () => {
    assert.equal(percentile([10, 1, 5, 3, 9, 7, 2, 8, 6, 4], 0.9), 9);
    assert.equal(percentile([5], 0.5), 5);
  });
});

describe('formatters', () => {
  it('renders integer cents with grouping and two decimals', () => {
    assert.equal(formatCents(0), '$0.00');
    assert.equal(formatCents(5900), '$59.00');
    assert.equal(formatCents(123_456_789), '$1,234,567.89');
    assert.equal(formatCents(-123_456), '-$1,234.56');
  });

  it('distinguishes USD from CAD without converting either', () => {
    assert.equal(formatCents(5900, 'USD'), 'US$59.00');
  });

  it('renders durations, and a dash when there is nothing to show', () => {
    assert.equal(formatDurationHours(0), '—');
    assert.equal(formatDurationHours(6), '6h');
    assert.equal(formatDurationHours(48), '2d');
    assert.equal(formatDurationHours(52), '2d 4h');
  });
});

// ---------------------------------------------------------------------------
// Time and bucketing
// ---------------------------------------------------------------------------

describe('day keys', () => {
  it('round-trips through UTC regardless of the host timezone', () => {
    assert.equal(dayKey(at('2026-01-31T23:59:59.999Z')), '2026-01-31');
    assert.equal(dayKey(at('2026-02-01T00:00:00.000Z')), '2026-02-01');
    assert.equal(parseDayKey('2026-02-01').toISOString(), '2026-02-01T00:00:00.000Z');
  });

  it('rejects a malformed key rather than inventing a date', () => {
    assert.throws(() => parseDayKey('2026-2-1'), /Invalid day key/);
  });

  it('enumerates whole days across a month boundary', () => {
    const days = eachDayKey({ start: at('2026-01-30T00:00:00.000Z'), end: at('2026-02-02T00:00:00.000Z') });
    assert.deepEqual(days, ['2026-01-30', '2026-01-31', '2026-02-01']);
  });
});

describe('buildBuckets', () => {
  it('returns an empty series for a reversed or empty range', () => {
    assert.deepEqual(buildBuckets({ start: at('2026-02-01T00:00:00.000Z'), end: at('2026-01-01T00:00:00.000Z') }, 'day'), []);
    assert.deepEqual(buildBuckets({ start: at('2026-02-01T00:00:00.000Z'), end: at('2026-02-01T00:00:00.000Z') }, 'day'), []);
  });

  it('emits one bucket per day', () => {
    const buckets = buildBuckets(JANUARY_END, 'day');
    assert.equal(buckets.length, 8);
    assert.equal(buckets[0]?.key, '2026-01-26');
    assert.equal(buckets[7]?.key, '2026-02-02');
  });

  it('splits a range that straddles a month boundary into two month buckets', () => {
    const buckets = buildBuckets(JANUARY_END, 'month');
    assert.deepEqual(
      buckets.map((bucket) => bucket.key),
      ['2026-01', '2026-02'],
    );
    // The January bucket starts on the 1st even though the range starts on the
    // 26th — the bucket states its own real span so a chart can flag it.
    assert.equal(buckets[0]?.start.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(buckets[0]?.end.toISOString(), '2026-02-01T00:00:00.000Z');
    assert.equal(buckets[0]?.label, 'Jan 2026');
  });

  it('keeps a week that straddles a month boundary in one bucket', () => {
    // 2026-01-26 is a Monday; that ISO week runs through Sunday 2026-02-01.
    assert.equal(startOfUtcWeek(at('2026-02-01T00:00:00.000Z')).toISOString(), '2026-01-26T00:00:00.000Z');
    const buckets = buildBuckets(JANUARY_END, 'week');
    assert.deepEqual(
      buckets.map((bucket) => bucket.key),
      ['2026-01-26', '2026-02-02'],
    );
  });
});

describe('rangeOfDays and snapToUtcDays', () => {
  it('covers the last N whole UTC days including today', () => {
    const range = rangeOfDays(7, at('2026-01-30T15:00:00.000Z'));
    assert.equal(range.start.toISOString(), '2026-01-24T00:00:00.000Z');
    assert.equal(range.end.toISOString(), '2026-01-31T00:00:00.000Z');
    assert.equal(eachDayKey(range).length, 7);
  });

  it('widens a partial day so a rollup never rewrites a day from a fragment', () => {
    const snapped = snapToUtcDays({
      start: at('2026-01-27T09:00:00.000Z'),
      end: at('2026-01-27T17:00:00.000Z'),
    });
    assert.equal(snapped.start.toISOString(), '2026-01-27T00:00:00.000Z');
    assert.equal(snapped.end.toISOString(), '2026-01-28T00:00:00.000Z');
  });

  it('leaves an already-whole range alone', () => {
    const snapped = snapToUtcDays(JANUARY_END);
    assert.equal(snapped.start.toISOString(), JANUARY_END.start.toISOString());
    assert.equal(snapped.end.toISOString(), JANUARY_END.end.toISOString());
  });
});

// ---------------------------------------------------------------------------
// Application metrics
// ---------------------------------------------------------------------------

describe('stageOf', () => {
  it('places each status on the funnel ladder', () => {
    assert.equal(stageOf(application({ status: 'queued', appliedAt: null })), 'not_sent');
    assert.equal(stageOf(application({ status: 'ready_to_submit', appliedAt: null })), 'not_sent');
    assert.equal(stageOf(application({ status: 'submitted' })), 'sent');
    assert.equal(stageOf(application({ status: 'rejected' })), 'responded');
    assert.equal(stageOf(application({ status: 'interviewing' })), 'interview');
    assert.equal(stageOf(application({ status: 'offer' })), 'offer');
  });

  it('treats a failed submission as never sent, even with an appliedAt', () => {
    assert.equal(stageOf(application({ status: 'failed' })), 'not_sent');
  });

  it('reads respondedAt as a response even when the status has not caught up', () => {
    assert.equal(
      stageOf(application({ status: 'submitted', respondedAt: at('2026-01-29T00:00:00.000Z') })),
      'responded',
    );
  });

  it('counts a withdrawn application that went out as sent', () => {
    assert.equal(stageOf(application({ status: 'withdrawn' })), 'sent');
    assert.equal(stageOf(application({ status: 'withdrawn', appliedAt: null })), 'not_sent');
  });
});

describe('computeApplicationMetrics — empty data', () => {
  const metrics = computeApplicationMetrics([], { range: JANUARY_END, granularity: 'day' });

  it('returns a fully zeroed series rather than an empty array', () => {
    assert.equal(metrics.overTime.length, 8);
    for (const point of metrics.overTime) {
      assert.equal(point.applications, 0);
      assert.equal(point.sent, 0);
      assert.equal(point.offers, 0);
    }
  });

  it('zeroes every total without producing NaN', () => {
    assert.equal(metrics.totals.applications, 0);
    assert.equal(metrics.totals.averageMatchScore, 0);
    assert.ok(Number.isFinite(metrics.totals.averageMatchScore));
  });

  it('reports every rate as no-data rather than 0%', () => {
    for (const value of Object.values(metrics.funnel)) {
      assert.equal(value.parts, 0);
      assert.equal(value.denominator, 0);
    }
  });

  it('returns empty groups and a zeroed response time', () => {
    assert.deepEqual(metrics.byCompany, []);
    assert.deepEqual(metrics.byLocation, []);
    assert.equal(metrics.timeToFirstResponse.samples, 0);
    assert.equal(metrics.timeToFirstResponse.medianHours, 0);
  });
});

describe('computeApplicationMetrics — a single data point', () => {
  const metrics = computeApplicationMetrics([application()], {
    range: JANUARY_END,
    granularity: 'day',
  });

  it('lands the row in exactly one bucket', () => {
    const filled = metrics.overTime.filter((point) => point.applications > 0);
    assert.equal(filled.length, 1);
    assert.equal(filled[0]?.bucket, '2026-01-27');
    assert.equal(filled[0]?.applications, 1);
  });

  it('counts it as sent but not yet answered', () => {
    assert.equal(metrics.totals.applications, 1);
    assert.equal(metrics.totals.sent, 1);
    assert.equal(metrics.totals.responded, 0);
    assert.equal(metrics.funnel.responseRate.parts, 0);
    assert.equal(metrics.funnel.responseRate.denominator, 1);
  });

  it('guards the downstream rates whose denominators are still zero', () => {
    assert.equal(metrics.funnel.interviewFromResponse.denominator, 0);
    assert.equal(metrics.funnel.interviewFromResponse.parts, 0);
    assert.equal(metrics.funnel.offerFromInterview.parts, 0);
  });
});

describe('computeApplicationMetrics — funnel arithmetic', () => {
  const rows = [
    application({ id: 'a', status: 'submitted' }),
    application({ id: 'b', status: 'rejected', respondedAt: at('2026-01-29T12:00:00.000Z') }),
    application({ id: 'c', status: 'interviewing', respondedAt: at('2026-01-28T12:00:00.000Z') }),
    application({ id: 'd', status: 'offer', respondedAt: at('2026-01-28T12:00:00.000Z') }),
    application({ id: 'e', status: 'queued', appliedAt: null }),
  ];
  const metrics = computeApplicationMetrics(rows, { range: JANUARY_END });

  it('counts the funnel cumulatively so it decreases monotonically', () => {
    assert.equal(metrics.totals.applications, 5);
    assert.equal(metrics.totals.sent, 4);
    assert.equal(metrics.totals.responded, 3);
    assert.equal(metrics.totals.interviews, 2);
    assert.equal(metrics.totals.offers, 1);
    assert.ok(metrics.totals.sent >= metrics.totals.responded);
    assert.ok(metrics.totals.responded >= metrics.totals.interviews);
    assert.ok(metrics.totals.interviews >= metrics.totals.offers);
  });

  it('excludes never-sent applications from every denominator', () => {
    assert.equal(metrics.funnel.responseRate.denominator, 4);
    assert.equal(metrics.funnel.responseRate.parts, 750_000);
    assert.equal(metrics.funnel.offerFromInterview.parts, 500_000);
  });
});

describe('applicationsByCompany', () => {
  it('ranks by volume and labels a blank company Unknown', () => {
    const rows = [
      application({ id: 'a', company: 'Acme' }),
      application({ id: 'b', company: 'Acme' }),
      application({ id: 'c', company: '  ' }),
    ];
    const groups = applicationsByCompany(rows);
    assert.equal(groups[0]?.key, 'Acme');
    assert.equal(groups[0]?.applications, 2);
    assert.equal(groups[0]?.parts, 666_667);
    assert.equal(groups[1]?.key, 'Unknown');
  });

  it('returns nothing for no rows instead of a zero-count group', () => {
    assert.deepEqual(applicationsByCompany([]), []);
  });
});

describe('bucketing across a month boundary', () => {
  const rows = [
    application({ id: 'jan', createdAt: at('2026-01-30T06:00:00.000Z') }),
    application({ id: 'feb', createdAt: at('2026-02-01T06:00:00.000Z') }),
  ];

  it('files each application in its own month', () => {
    const metrics = computeApplicationMetrics(rows, { range: JANUARY_END, granularity: 'month' });
    assert.deepEqual(
      metrics.overTime.map((point) => [point.bucket, point.applications]),
      [
        ['2026-01', 1],
        ['2026-02', 1],
      ],
    );
  });

  it('keeps them in the same week when they share an ISO week', () => {
    const metrics = computeApplicationMetrics(rows, { range: JANUARY_END, granularity: 'week' });
    assert.deepEqual(
      metrics.overTime.map((point) => [point.bucket, point.applications]),
      [
        ['2026-01-26', 2],
        ['2026-02-02', 0],
      ],
    );
  });

  it('drops rows outside the requested range', () => {
    const metrics = computeApplicationMetrics(
      [...rows, application({ id: 'march', createdAt: at('2026-03-01T00:00:00.000Z') })],
      { range: JANUARY_END, granularity: 'month' },
    );
    assert.equal(metrics.totals.applications, 2);
  });
});

describe('timeToFirstResponse', () => {
  it('reports zeros, not a zero-hour response, when nobody has replied', () => {
    const stats = timeToFirstResponse([application()]);
    assert.equal(stats.samples, 0);
    assert.equal(stats.averageHours, 0);
    assert.equal(stats.medianHours, 0);
  });

  it('measures from appliedAt to respondedAt', () => {
    const stats = timeToFirstResponse([
      application({
        appliedAt: at('2026-01-27T00:00:00.000Z'),
        respondedAt: at('2026-01-29T00:00:00.000Z'),
      }),
    ]);
    assert.equal(stats.samples, 1);
    assert.equal(stats.medianHours, 48);
    assert.equal(stats.fastestHours, 48);
    assert.equal(stats.slowestHours, 48);
  });

  it('ignores a response recorded before the application went out', () => {
    const stats = timeToFirstResponse([
      application({
        appliedAt: at('2026-01-29T00:00:00.000Z'),
        respondedAt: at('2026-01-27T00:00:00.000Z'),
      }),
    ]);
    assert.equal(stats.samples, 0);
  });
});

// ---------------------------------------------------------------------------
// Match metrics
// ---------------------------------------------------------------------------

describe('matchScoreDistribution', () => {
  it('always returns all ten bands, zeroed when there is no data', () => {
    const buckets = matchScoreDistribution([]);
    assert.equal(buckets.length, 10);
    assert.equal(buckets[0]?.key, '0-9');
    assert.equal(buckets[9]?.key, '90-100');
    for (const bucket of buckets) {
      assert.equal(bucket.count, 0);
      assert.equal(bucket.parts, 0);
    }
  });

  it('places a perfect score in the top band, not off the end', () => {
    const buckets = matchScoreDistribution([{ matchScore: 100, createdAt: at('2026-01-27T00:00:00.000Z') }]);
    assert.equal(buckets[9]?.count, 1);
    assert.equal(buckets[9]?.parts, 1_000_000);
  });

  it('clamps a nonsensical score instead of throwing', () => {
    const buckets = matchScoreDistribution([
      { matchScore: -20, createdAt: at('2026-01-27T00:00:00.000Z') },
      { matchScore: 900, createdAt: at('2026-01-27T00:00:00.000Z') },
    ]);
    assert.equal(buckets[0]?.count, 1);
    assert.equal(buckets[9]?.count, 1);
  });
});

describe('matchScoreTrend', () => {
  it('reports an empty bucket as count 0 with no average, never NaN', () => {
    const points = matchScoreTrend([], JANUARY_END, 'day');
    assert.equal(points.length, 8);
    for (const point of points) {
      assert.equal(point.count, 0);
      assert.equal(point.averageScore, 0);
      assert.ok(Number.isFinite(point.averageScore));
    }
  });

  it('averages within the bucket', () => {
    const points = matchScoreTrend(
      [
        { matchScore: 70, createdAt: at('2026-01-27T01:00:00.000Z') },
        { matchScore: 85, createdAt: at('2026-01-27T23:00:00.000Z') },
      ],
      JANUARY_END,
      'day',
    );
    const filled = points.find((point) => point.count > 0);
    assert.equal(filled?.bucket, '2026-01-27');
    assert.equal(filled?.averageScore, 77.5);
  });
});

describe('topMissingKeywords', () => {
  it('counts once per match, not once per mention', () => {
    const ranked = topMissingKeywords([
      { matchedKeywords: [], missingKeywords: ['Terraform', 'terraform', 'Kubernetes'] },
      { matchedKeywords: [], missingKeywords: ['Terraform'] },
    ]);
    assert.equal(ranked[0]?.keyword, 'Terraform');
    assert.equal(ranked[0]?.count, 2);
    assert.equal(ranked[0]?.parts, 1_000_000);
    assert.equal(ranked[1]?.count, 1);
  });

  it('ignores blank entries and returns nothing for no matches', () => {
    assert.deepEqual(topMissingKeywords([]), []);
    assert.deepEqual(topMissingKeywords([{ matchedKeywords: [], missingKeywords: ['', '  '] }]), []);
  });

  it('respects the limit', () => {
    const ranked = topMissingKeywords(
      [{ matchedKeywords: [], missingKeywords: ['a', 'b', 'c', 'd'] }],
      2,
    );
    assert.equal(ranked.length, 2);
  });
});

describe('computeMatchMetrics — empty', () => {
  it('zeroes every field without dividing by zero', () => {
    const metrics = computeMatchMetrics([], { range: JANUARY_END });
    assert.equal(metrics.totalMatches, 0);
    assert.equal(metrics.averageMatchScore, 0);
    assert.equal(metrics.distribution.length, 10);
    assert.equal(metrics.trend.length, 8);
    assert.deepEqual(metrics.topMatchedKeywords, []);
    assert.deepEqual(metrics.topMissingKeywords, []);
  });
});

// ---------------------------------------------------------------------------
// Revenue
// ---------------------------------------------------------------------------

describe('monthlyNormalizedCents', () => {
  it('spreads an interval price across its months', () => {
    assert.equal(monthlyNormalizedCents(5900, 'monthly'), 5900);
    assert.equal(monthlyNormalizedCents(15930, 'quarterly'), 5310);
    assert.equal(monthlyNormalizedCents(56640, 'annual'), 4720);
  });

  it('returns integer cents, never a float', () => {
    const value = monthlyNormalizedCents(10000, 'quarterly');
    assert.equal(value, 3333);
    assert.equal(Number.isInteger(value), true);
  });

  it('treats an unrecognised interval as monthly rather than throwing', () => {
    assert.equal(monthlyNormalizedCents(5900, 'weekly'), 5900);
  });
});

describe('subscriptionMrrCents', () => {
  it('falls back to the plan price while the cache column is still zero', () => {
    assert.equal(subscriptionMrrCents(subscription({ mrrCents: 0 })), 5900);
  });

  it('prefers the cache when it has been written', () => {
    assert.equal(subscriptionMrrCents(subscription({ mrrCents: 4900 })), 4900);
  });

  it('excludes trials and cancellations, includes dunning states', () => {
    assert.equal(subscriptionMrrCents(subscription({ status: 'trialing' })), 0);
    assert.equal(subscriptionMrrCents(subscription({ status: 'canceled' })), 0);
    assert.equal(subscriptionMrrCents(subscription({ status: 'suspended' })), 0);
    assert.equal(subscriptionMrrCents(subscription({ status: 'past_due' })), 5900);
    assert.equal(subscriptionMrrCents(subscription({ status: 'grace' })), 5900);
  });
});

describe('computeMrrSnapshot', () => {
  it('zeroes everything, including ARPU, with no subscribers', () => {
    const snapshot = computeMrrSnapshot([]);
    assert.equal(snapshot.mrrCents, 0);
    assert.equal(snapshot.arrCents, 0);
    assert.equal(snapshot.arpuCents, 0);
    assert.equal(snapshot.payingSubscribers, 0);
    assert.deepEqual(snapshot.byPlan, []);
  });

  it('computes MRR, ARR and ARPU from a single subscriber', () => {
    const snapshot = computeMrrSnapshot([subscription()]);
    assert.equal(snapshot.mrrCents, 5900);
    assert.equal(snapshot.arrCents, 70800);
    assert.equal(snapshot.arpuCents, 5900);
    assert.equal(snapshot.payingSubscribers, 1);
    assert.equal(snapshot.byPlan[0]?.planCode, 'professional');
    assert.equal(snapshot.byPlan[0]?.parts, 1_000_000);
  });

  it('never mixes currencies', () => {
    const snapshot = computeMrrSnapshot(
      [subscription(), subscription({ id: 'sub_2', userId: 'user_2', currency: 'USD' })],
      'CAD',
    );
    assert.equal(snapshot.payingSubscribers, 1);
    assert.equal(snapshot.mrrCents, 5900);
  });

  it('keeps a trialing subscriber out of ARPU but still counts them', () => {
    const snapshot = computeMrrSnapshot([
      subscription(),
      subscription({ id: 'sub_2', userId: 'user_2', status: 'trialing' }),
    ]);
    assert.equal(snapshot.trialingSubscribers, 1);
    assert.equal(snapshot.payingSubscribers, 1);
    assert.equal(snapshot.arpuCents, 5900);
  });
});

describe('mrrAtInstant', () => {
  const events = [
    event({ subscriptionId: 'sub_1', occurredAt: at('2026-01-05T00:00:00.000Z'), mrrAfterCents: 5900 }),
    event({
      subscriptionId: 'sub_2',
      userId: 'user_2',
      occurredAt: at('2026-01-10T00:00:00.000Z'),
      mrrAfterCents: 2900,
    }),
    event({
      subscriptionId: 'sub_1',
      type: 'canceled',
      movement: 'churn',
      occurredAt: at('2026-01-20T00:00:00.000Z'),
      mrrBeforeCents: 5900,
      mrrAfterCents: 0,
      deltaMrrCents: -5900,
    }),
  ];

  it('is zero before any event exists', () => {
    const balance = mrrAtInstant(events, at('2026-01-01T00:00:00.000Z'));
    assert.equal(balance.mrrCents, 0);
    assert.equal(balance.subscriptions, 0);
  });

  it('sums the latest event per subscription at that instant', () => {
    assert.equal(mrrAtInstant(events, at('2026-01-15T00:00:00.000Z')).mrrCents, 8800);
    assert.equal(mrrAtInstant(events, at('2026-01-15T00:00:00.000Z')).subscriptions, 2);
  });

  it('drops a subscription once it has churned to zero', () => {
    const balance = mrrAtInstant(events, at('2026-01-25T00:00:00.000Z'));
    assert.equal(balance.mrrCents, 2900);
    assert.equal(balance.subscriptions, 1);
  });
});

describe('computeMovement', () => {
  const range: DateRange = {
    start: at('2026-01-01T00:00:00.000Z'),
    end: at('2026-02-01T00:00:00.000Z'),
  };

  it('is all zeros with no events', () => {
    const movement = computeMovement([], range);
    assert.equal(movement.newMrrCents, 0);
    assert.equal(movement.netNewMrrCents, 0);
    assert.equal(movement.churnedSubscribers, 0);
  });

  it('reports churn and contraction as positive magnitudes', () => {
    const movement = computeMovement(
      [
        event({ movement: 'new', deltaMrrCents: 5900 }),
        event({ subscriptionId: 'sub_2', movement: 'churn', deltaMrrCents: -2900 }),
        event({ subscriptionId: 'sub_3', movement: 'contraction', deltaMrrCents: -1000 }),
        event({ subscriptionId: 'sub_4', movement: 'expansion', deltaMrrCents: 2000 }),
      ],
      range,
    );
    assert.equal(movement.churnedMrrCents, 2900);
    assert.equal(movement.contractionMrrCents, 1000);
    assert.equal(movement.netNewMrrCents, 5900 + 2000 - 1000 - 2900);
  });

  it('counts a subscription once however many times it moved', () => {
    const movement = computeMovement(
      [
        event({ subscriptionId: 'sub_9', movement: 'churn', deltaMrrCents: -1000 }),
        event({ subscriptionId: 'sub_9', movement: 'churn', deltaMrrCents: -500 }),
      ],
      range,
    );
    assert.equal(movement.churnedSubscribers, 1);
  });

  it('ignores events outside the range', () => {
    const movement = computeMovement(
      [event({ movement: 'new', deltaMrrCents: 5900, occurredAt: at('2025-12-31T00:00:00.000Z') })],
      range,
    );
    assert.equal(movement.newMrrCents, 0);
  });
});

describe('computeChurn', () => {
  it('reports no-data rather than dividing by a zero opening balance', () => {
    const churn = computeChurn({
      subscribersAtStart: 0,
      mrrAtStartCents: 0,
      movement: computeMovement([], JANUARY_END),
    });
    for (const value of Object.values(churn)) {
      assert.equal(value.parts, 0);
      assert.equal(value.denominator, 0);
    }
  });

  it('measures churn against the opening balance and excludes new business', () => {
    const movement = computeMovement(
      [
        event({ subscriptionId: 'sub_a', movement: 'churn', deltaMrrCents: -1000 }),
        event({ subscriptionId: 'sub_b', movement: 'expansion', deltaMrrCents: 500 }),
        event({ subscriptionId: 'sub_c', movement: 'new', deltaMrrCents: 9000 }),
      ],
      JANUARY_END,
    );
    const churn = computeChurn({
      subscribersAtStart: 10,
      mrrAtStartCents: 10_000,
      movement,
    });
    assert.equal(churn.logoChurn.parts, 100_000);
    assert.equal(churn.grossMrrChurn.parts, 100_000);
    assert.equal(churn.netMrrChurn.parts, 50_000);
    // 10000 + 500 - 1000 = 9500 retained; the 9000 of new MRR is excluded.
    assert.equal(churn.netRevenueRetention.parts, 950_000);
  });
});

describe('computeLtv', () => {
  it('caps the horizon instead of dividing by a zero churn rate', () => {
    const estimate = computeLtv(5900, rate(0, 0));
    assert.equal(estimate.capped, true);
    assert.equal(estimate.expectedLifetimeMonths, 36);
    assert.equal(estimate.ltvCents, 5900 * 36);
    assert.ok(Number.isFinite(estimate.ltvCents));
  });

  it('inverts the churn rate when it is high enough to bind', () => {
    const estimate = computeLtv(5900, rate(1, 2));
    assert.equal(estimate.expectedLifetimeMonths, 2);
    assert.equal(estimate.ltvCents, 11800);
    assert.equal(estimate.capped, false);
  });

  it('caps an implausibly small churn rate', () => {
    const estimate = computeLtv(5900, rate(1, 1000));
    assert.equal(estimate.capped, true);
    assert.equal(estimate.expectedLifetimeMonths, 36);
  });

  it('returns integer cents', () => {
    assert.equal(Number.isInteger(computeLtv(3333, rate(1, 7)).ltvCents), true);
  });
});

describe('computeCustomerLtv', () => {
  it('nets refunds and fees off collected cash', () => {
    const values = computeCustomerLtv([
      payment({ id: 'p1', amountCents: 5900, feeCents: 201 }),
      payment({ id: 'p2', amountCents: 5900, feeCents: 201, amountRefundedCents: 5900 }),
      payment({ id: 'p3', status: 'failed', amountCents: 5900 }),
    ]);
    assert.equal(values.length, 1);
    assert.equal(values[0]?.grossCents, 11800);
    assert.equal(values[0]?.netCents, 11800 - 5900 - 402);
    assert.equal(values[0]?.payments, 2);
  });

  it('returns nothing when nobody has paid', () => {
    assert.deepEqual(computeCustomerLtv([]), []);
  });
});

describe('computeRevenueTotals', () => {
  it('is zeroed with no rows', () => {
    const totals = computeRevenueTotals([], []);
    assert.equal(totals.invoicedCents, 0);
    assert.equal(totals.netCents, 0);
  });

  it('excludes drafts and voids from billed revenue', () => {
    const totals = computeRevenueTotals(
      [invoice(), invoice({ id: 'inv_2', status: 'draft' }), invoice({ id: 'inv_3', status: 'void' })],
      [],
    );
    assert.equal(totals.invoices, 1);
    assert.equal(totals.invoicedCents, 6667);
  });

  it('nets cash of refunds and gateway fees', () => {
    const totals = computeRevenueTotals([], [payment({ amountRefundedCents: 1000 })]);
    assert.equal(totals.paidCents, 5900);
    assert.equal(totals.netCents, 5900 - 1000 - 201);
  });

  it('ignores rows in another currency', () => {
    const totals = computeRevenueTotals(
      [invoice({ currency: 'USD' })],
      [payment({ currency: 'USD' })],
      'CAD',
    );
    assert.equal(totals.invoicedCents, 0);
    assert.equal(totals.paidCents, 0);
  });
});

describe('computePaymentHealth', () => {
  it('reports a zero failure rate with no data, not NaN', () => {
    const health = computePaymentHealth([], JANUARY_END);
    assert.equal(health.failureRate.parts, 0);
    assert.equal(health.failureRate.denominator, 0);
    assert.equal(health.overTime.length, 8);
  });

  it('excludes pending charges from both sides of the rate', () => {
    const health = computePaymentHealth(
      [
        payment({ id: 'p1' }),
        payment({
          id: 'p2',
          status: 'failed',
          failureCode: 'card_declined',
          succeededAt: null,
          failedAt: at('2026-01-27T11:00:00.000Z'),
        }),
        payment({ id: 'p3', status: 'pending', succeededAt: null }),
      ],
      JANUARY_END,
    );
    assert.equal(health.succeeded, 1);
    assert.equal(health.failed, 1);
    assert.equal(health.pending, 1);
    assert.equal(health.failureRate.denominator, 2);
    assert.equal(health.failureRate.parts, 500_000);
    assert.equal(health.topFailureCodes[0]?.key, 'card_declined');
  });

  it('labels a failure with no code rather than dropping it', () => {
    const health = computePaymentHealth(
      [payment({ status: 'failed', succeededAt: null, failedAt: at('2026-01-27T11:00:00.000Z') })],
      JANUARY_END,
    );
    assert.equal(health.topFailureCodes[0]?.key, 'unknown');
  });
});

describe('computeDunningRecovery', () => {
  it('ignores attempts the gateway owned and attempts still pending', () => {
    const recovery = computeDunningRecovery(
      [
        { outcome: 'succeeded', scheduledFor: at('2026-01-27T00:00:00.000Z') },
        { outcome: 'hard_decline', scheduledFor: at('2026-01-27T00:00:00.000Z') },
        { outcome: 'skipped_gateway_owned', scheduledFor: at('2026-01-27T00:00:00.000Z') },
        { outcome: 'pending', scheduledFor: at('2026-01-27T00:00:00.000Z') },
      ],
      JANUARY_END,
    );
    assert.equal(recovery.denominator, 2);
    assert.equal(recovery.parts, 500_000);
  });

  it('is no-data when nothing was attempted', () => {
    assert.equal(computeDunningRecovery([], JANUARY_END).denominator, 0);
  });
});

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

describe('aggregateUsageEvents', () => {
  it('returns nothing for no events', () => {
    assert.deepEqual(aggregateUsageEvents([]), []);
  });

  it('sums quantity per (day, user, metric)', () => {
    const rows = aggregateUsageEvents([
      usage({ occurredAt: at('2026-01-27T01:00:00.000Z') }),
      usage({ occurredAt: at('2026-01-27T23:59:59.000Z'), quantity: 2 }),
      usage({ occurredAt: at('2026-01-28T00:00:00.000Z') }),
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      day: '2026-01-27',
      userId: 'user_1',
      metric: 'applications_submitted',
      count: 3,
      valueCents: 0,
    });
    assert.equal(rows[1]?.day, '2026-01-28');
  });

  it('skips anonymous events, which have no row to belong to', () => {
    assert.deepEqual(aggregateUsageEvents([usage({ userId: null })]), []);
  });

  it('skips event names with no mapping rather than inventing a metric', () => {
    assert.deepEqual(aggregateUsageEvents([usage({ name: 'something.new' })]), []);
  });

  it('is deterministic — same input, byte-identical output', () => {
    const events = [
      usage({ userId: 'user_2', name: 'job.scanned' }),
      usage({ userId: 'user_1' }),
      usage({ userId: 'user_1', name: 'login' }),
    ];
    assert.deepEqual(aggregateUsageEvents(events), aggregateUsageEvents([...events].reverse()));
  });

  it('honours a range filter', () => {
    const rows = aggregateUsageEvents([usage({ occurredAt: at('2026-03-01T00:00:00.000Z') })], {
      range: JANUARY_END,
    });
    assert.deepEqual(rows, []);
  });
});

/** In-memory rollup store, so idempotency is provable without a database. */
function memoryUsageDeps(events: UsageEventRow[]) {
  const store = new Map<string, UsageRollupRow>();
  let replaceCalls = 0;

  const deps: UsageRollupDeps = {
    async loadUsageEvents(range, userId) {
      return events.filter(
        (item) =>
          item.occurredAt >= range.start &&
          item.occurredAt < range.end &&
          (!userId || item.userId === userId),
      );
    },
    async replaceUsageRollups(scope, rows) {
      replaceCalls += 1;
      // Mirrors the Prisma implementation: delete everything in scope first.
      for (const [key, row] of [...store]) {
        if (!scope.days.includes(row.day)) continue;
        if (!scope.metrics.includes(row.metric)) continue;
        if (scope.userId && row.userId !== scope.userId) continue;
        store.delete(key);
      }
      for (const row of rows) {
        store.set(`${row.day}|${row.userId}|${row.metric}`, { ...row });
      }
      return rows.length;
    },
  };

  const snapshot = () =>
    [...store.values()].sort((a, b) =>
      `${a.day}${a.userId}${a.metric}` < `${b.day}${b.userId}${b.metric}` ? -1 : 1,
    );

  return { deps, store, snapshot, calls: () => replaceCalls };
}

describe('rollupUsage — idempotency', () => {
  const events = [
    usage({ occurredAt: at('2026-01-27T01:00:00.000Z') }),
    usage({ occurredAt: at('2026-01-27T02:00:00.000Z') }),
    usage({ occurredAt: at('2026-01-28T02:00:00.000Z'), name: 'job.scanned', quantity: 12 }),
  ];

  it('produces the same rows however many times it runs', async () => {
    const { deps, snapshot } = memoryUsageDeps(events);

    await rollupUsage(JANUARY_END, { deps });
    const first = snapshot();

    await rollupUsage(JANUARY_END, { deps });
    await rollupUsage(JANUARY_END, { deps });
    const third = snapshot();

    assert.deepEqual(third, first);
  });

  it('does not double-count on a second run', async () => {
    const { deps, snapshot } = memoryUsageDeps(events);
    await rollupUsage(JANUARY_END, { deps });
    await rollupUsage(JANUARY_END, { deps });

    const submitted = snapshot().find((row) => row.metric === 'applications_submitted');
    assert.equal(submitted?.count, 2);
    const scanned = snapshot().find((row) => row.metric === 'jobs_scanned');
    assert.equal(scanned?.count, 12);
  });

  it('drops a stale row when the underlying events are gone', async () => {
    const { deps, snapshot } = memoryUsageDeps(events);
    await rollupUsage(JANUARY_END, { deps });
    assert.equal(snapshot().length, 2);

    // Same window, no events: the day must end up empty, not frozen at the
    // previous value.
    const { deps: emptyDeps, store } = memoryUsageDeps([]);
    for (const row of snapshot()) store.set(`${row.day}|${row.userId}|${row.metric}`, row);
    await rollupUsage(JANUARY_END, { deps: emptyDeps });
    assert.equal(store.size, 0);
  });

  it('scopes the replace to one user, leaving other users untouched', async () => {
    const { deps, store, snapshot } = memoryUsageDeps([
      usage({ userId: 'user_1' }),
      usage({ userId: 'user_2' }),
    ]);
    await rollupUsage(JANUARY_END, { deps });
    assert.equal(snapshot().length, 2);

    await rollupUsage(JANUARY_END, { deps, userId: 'user_1' });
    assert.equal(store.size, 2, 'a single-user re-run must not delete other users rows');
    assert.ok(snapshot().some((row) => row.userId === 'user_2'));
  });

  it('widens a partial-day window instead of rewriting a day from a fragment', async () => {
    const { deps, snapshot } = memoryUsageDeps(events);
    await rollupUsage(
      { start: at('2026-01-27T09:00:00.000Z'), end: at('2026-01-27T17:00:00.000Z') },
      { deps },
    );
    // Both 01:00 and 02:00 events are inside the snapped day, though neither is
    // inside the requested 09:00-17:00 window.
    const submitted = snapshot().find((row) => row.metric === 'applications_submitted');
    assert.equal(submitted?.count, 2);
  });

  it('reports what it read and wrote', async () => {
    const { deps } = memoryUsageDeps(events);
    const result = await rollupUsage(JANUARY_END, { deps });
    assert.equal(result.job, 'daily_usage');
    assert.equal(result.status, 'succeeded');
    assert.equal(result.days, 8);
    assert.equal(result.rowsRead, 3);
    assert.equal(result.rowsWritten, 2);
  });
});

describe('backfillUsageRollups', () => {
  const events = [
    usage({ occurredAt: at('2026-01-26T01:00:00.000Z') }),
    usage({ occurredAt: at('2026-01-29T01:00:00.000Z') }),
    usage({ occurredAt: at('2026-02-02T01:00:00.000Z') }),
  ];

  it('chunking produces exactly the same rows as one pass', async () => {
    const single = memoryUsageDeps(events);
    await rollupUsage(JANUARY_END, { deps: single.deps });

    const chunked = memoryUsageDeps(events);
    await backfillUsageRollups(JANUARY_END, { deps: chunked.deps, chunkDays: 2 });

    assert.deepEqual(chunked.snapshot(), single.snapshot());
    assert.equal(chunked.calls() > single.calls(), true, 'the chunked run should write in batches');
  });

  it('is idempotent across differently sized chunks', async () => {
    const a = memoryUsageDeps(events);
    await backfillUsageRollups(JANUARY_END, { deps: a.deps, chunkDays: 1 });
    await backfillUsageRollups(JANUARY_END, { deps: a.deps, chunkDays: 3 });
    await backfillUsageRollups(JANUARY_END, { deps: a.deps, chunkDays: 30 });

    const b = memoryUsageDeps(events);
    await backfillUsageRollups(JANUARY_END, { deps: b.deps, chunkDays: 7 });

    assert.deepEqual(a.snapshot(), b.snapshot());
  });

  it('handles an empty range without writing anything', async () => {
    const { deps, store } = memoryUsageDeps(events);
    const result = await backfillUsageRollups(
      { start: at('2026-02-01T00:00:00.000Z'), end: at('2026-02-01T00:00:00.000Z') },
      { deps },
    );
    assert.equal(result.days, 0);
    assert.equal(result.rowsWritten, 0);
    assert.equal(store.size, 0);
  });
});

describe('computeDailyMetricRows', () => {
  it('emits a zeroed row per metric per day with no input', () => {
    const rows = computeDailyMetricRows({ signups: [], submissions: [], activity: [] }, {
      start: at('2026-01-27T00:00:00.000Z'),
      end: at('2026-01-29T00:00:00.000Z'),
    });
    assert.equal(rows.length, 6);
    for (const row of rows) {
      assert.equal(row.valueInt, 0);
      assert.equal(row.dimension, 'all');
    }
  });

  it('counts active users distinctly, not once per event', () => {
    const rows = computeDailyMetricRows(
      {
        signups: [at('2026-01-27T05:00:00.000Z')],
        submissions: [],
        activity: [
          { userId: 'user_1', occurredAt: at('2026-01-27T05:00:00.000Z') },
          { userId: 'user_1', occurredAt: at('2026-01-27T06:00:00.000Z') },
          { userId: 'user_2', occurredAt: at('2026-01-27T07:00:00.000Z') },
        ],
      },
      { start: at('2026-01-27T00:00:00.000Z'), end: at('2026-01-28T00:00:00.000Z') },
    );
    const actives = rows.find((row) => row.metric === 'active_users');
    assert.equal(actives?.valueInt, 2);
    assert.equal(rows.find((row) => row.metric === 'signups')?.valueInt, 1);
  });
});

describe('computeDailyRevenueRows', () => {
  const range: DateRange = {
    start: at('2026-01-27T00:00:00.000Z'),
    end: at('2026-01-29T00:00:00.000Z'),
  };

  it('writes a base-currency row per day even with no activity', () => {
    const rows = computeDailyRevenueRows({ invoices: [], payments: [], events: [] }, range);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => [row.day, row.currency]),
      [
        ['2026-01-27', 'CAD'],
        ['2026-01-28', 'CAD'],
      ],
    );
    assert.equal(rows[0]?.mrrCents, 0);
    assert.equal(rows[0]?.arpuCents, 0);
    assert.equal(rows[0]?.logoChurnParts, 0);
  });

  it('splits cash by currency and never mixes it', () => {
    const rows = computeDailyRevenueRows(
      {
        invoices: [invoice(), invoice({ id: 'inv_2', currency: 'USD', totalCents: 5000 })],
        payments: [],
        events: [],
      },
      range,
    );
    const cad = rows.find((row) => row.day === '2026-01-27' && row.currency === 'CAD');
    const usd = rows.find((row) => row.day === '2026-01-27' && row.currency === 'USD');
    assert.equal(cad?.invoicedCents, 6667);
    assert.equal(usd?.invoicedCents, 5000);
  });

  it('keeps normalised MRR on the base row only, so summing cannot double it', () => {
    const rows = computeDailyRevenueRows(
      {
        invoices: [invoice({ currency: 'USD' })],
        payments: [],
        events: [event({ occurredAt: at('2026-01-27T00:00:00.000Z') })],
      },
      range,
    );
    const cad = rows.find((row) => row.day === '2026-01-27' && row.currency === 'CAD');
    const usd = rows.find((row) => row.day === '2026-01-27' && row.currency === 'USD');
    assert.equal(cad?.mrrCents, 5900);
    assert.equal(cad?.arrCents, 70800);
    assert.equal(usd?.mrrCents, 0);
  });

  it('nets cash and carries the movement onto the right day', () => {
    const rows = computeDailyRevenueRows(
      {
        invoices: [invoice()],
        payments: [payment({ amountRefundedCents: 900 })],
        events: [
          event({ occurredAt: at('2026-01-27T00:00:00.000Z') }),
          event({
            subscriptionId: 'sub_2',
            movement: 'churn',
            deltaMrrCents: -2900,
            mrrAfterCents: 0,
            occurredAt: at('2026-01-28T00:00:00.000Z'),
          }),
        ],
      },
      range,
    );
    const first = rows[0];
    const second = rows[1];
    assert.equal(first?.paidCents, 5900);
    assert.equal(first?.netCents, 5900 - 900 - 201);
    assert.equal(first?.newMrrCents, 5900);
    assert.equal(second?.churnedMrrCents, 2900);
    assert.equal(second?.newMrrCents, 0);
    // Day two opened with one paying subscription, and one churned.
    assert.equal(second?.logoChurnParts, 1_000_000);
  });

  it('is a pure function — running it twice gives identical rows', () => {
    const input = { invoices: [invoice()], payments: [payment()], events: [event()] };
    assert.deepEqual(
      computeDailyRevenueRows(input, range),
      computeDailyRevenueRows(input, range),
    );
  });
});
