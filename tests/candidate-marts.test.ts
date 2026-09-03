/**
 * Stage 13 - the candidate marts, purely: the dictionary is complete and
 * mirrored in the governance document; reach is inferred from history, not
 * the current status; the builders are deterministic and idempotent over
 * the same facts; dimensions land where the dictionary says; the benchmark
 * counts distinct people; small cohorts are suppressed; and nothing under
 * the read path touches a transactional table.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DIMENSIONS, METRIC_DICTIONARY, METRIC_KEYS, MIN_COHORT, metric, rateOf, scoreBand, seniorityOf, suppressSmallCohort, valueOf } from '../src/lib/analytics/candidate/dictionary';
import { buildBenchmarkMart, buildMatchMart, buildOutcomeMart, countsOf, keysOf, type ApplicationFact } from '../src/lib/analytics/candidate/marts';
import { assembleOutcomes } from '../src/lib/analytics/candidate/read';

function fact(over: Partial<ApplicationFact> = {}): ApplicationFact {
  return {
    id: over.id ?? 'a1',
    userId: 'u1',
    createdAt: new Date('2026-08-10T12:00:00Z'),
    status: 'submitted',
    appliedAt: new Date('2026-08-10T13:00:00Z'),
    respondedAt: null,
    outcome: 'pending',
    matchScore: 78,
    reached: ['ready_to_submit', 'submitted'],
    interviewKinds: [],
    title: 'Senior Data Analyst',
    normalizedTitle: 'senior data analyst',
    company: 'Maple Analytics',
    location: 'Toronto, ON',
    country: 'CA',
    source: 'mock',
    resumeVersion: 2,
    ...over,
  };
}

describe('metric dictionary', () => {
  it('names every metric once, with a definition, a source in a mart, and a numerator/denominator for every rate', () => {
    assert.equal(new Set(METRIC_KEYS).size, METRIC_KEYS.length);
    for (const m of METRIC_DICTIONARY) {
      assert.ok(m.definition.length > 20, m.key);
      assert.match(m.source, /^Candidate\w+Mart\./, `${m.key} must source a mart, never a transactional table`);
      if (m.kind === 'rate') assert.ok(m.numerator && m.denominator, m.key);
    }
    assert.equal(metric('response_rate').denominator, 'sent');
  });

  it('is mirrored in docs/governance/METRIC_DICTIONARY.md - every key, label and definition', () => {
    const doc = readFileSync(path.join(__dirname, '..', 'docs', 'governance', 'METRIC_DICTIONARY.md'), 'utf8');
    for (const m of METRIC_DICTIONARY) {
      assert.ok(doc.includes(`\`${m.key}\``), `document lacks ${m.key}`);
      assert.ok(doc.includes(m.definition), `document definition differs for ${m.key}`);
    }
    for (const d of DIMENSIONS) assert.ok(doc.includes(`\`${d}\``), `document lacks dimension ${d}`);
    assert.ok(doc.includes(`${MIN_COHORT}`), 'the suppression threshold is documented');
  });

  it('computes every rate one way and every value one way', () => {
    const c = countsOf(fact({ respondedAt: new Date('2026-08-12T13:00:00Z'), reached: ['submitted', 'interviewing'], status: 'interviewing' }));
    assert.deepEqual(rateOf('response_rate', c), { numerator: 1, denominator: 1, parts: 1_000_000 });
    assert.deepEqual(rateOf('offer_rate', c), { numerator: 0, denominator: 1, parts: 0 });
    assert.deepEqual(rateOf('offer_from_interview', { ...c, interviews: 0 }), { numerator: 0, denominator: 0, parts: 0 }, 'no denominator, no rate - never NaN');
    assert.equal(valueOf('average_response_hours', c), 48);
    assert.equal(valueOf('average_match_score', c), 78);
  });

  it('score bands and seniority are deterministic and total', () => {
    assert.deepEqual([0, 49, 50, 69, 70, 84, 85, 100].map(scoreBand), ['0-49', '0-49', '50-69', '50-69', '70-84', '70-84', '85-100', '85-100']);
    assert.equal(seniorityOf('Senior Data Analyst'), 'senior');
    assert.equal(seniorityOf('Data Analyst'), 'unspecified');
    assert.equal(seniorityOf('Engineering Manager'), 'manager');
    assert.equal(seniorityOf('VP, Engineering'), 'executive');
    assert.equal(seniorityOf('Software Engineering Intern (Co-op)'), 'intern');
    assert.equal(seniorityOf('Staff Engineer'), 'lead');
  });
});

describe('outcome mart builder', () => {
  it('infers reach from the history, never from the current status alone', () => {
    const rejectedAfterInterview = countsOf(fact({ status: 'rejected', reached: ['submitted', 'interviewing', 'rejected'], respondedAt: new Date('2026-08-11T00:00:00Z') }));
    assert.equal(rejectedAfterInterview.interviews, 1, 'it interviewed, whatever happened after');
    assert.equal(rejectedAfterInterview.responded, 1);
    assert.equal(rejectedAfterInterview.rejected, 1);
    const withdrawnUnsent = countsOf(fact({ status: 'withdrawn', appliedAt: null, reached: ['ready_to_submit', 'withdrawn'] }));
    assert.equal(withdrawnUnsent.sent, 0, 'a withdrawal is not evidence of sending');
    assert.equal(withdrawnUnsent.withdrawn, 1);
    const failed = countsOf(fact({ status: 'failed', appliedAt: null, reached: ['failed'] }));
    assert.equal(failed.failed, 1);
    assert.equal(failed.sent, 0);
    const hired = countsOf(fact({ status: 'offer', outcome: 'hired', reached: ['submitted', 'interviewing', 'offer'], interviewKinds: ['phone', 'onsite'] }));
    assert.deepEqual([hired.sent, hired.responded, hired.screens, hired.interviews, hired.offers, hired.hires], [1, 1, 1, 1, 1, 1]);
    const unanswered = countsOf(fact());
    assert.equal(unanswered.responseSamples, 0, 'an unanswered application is not a zero-hour reply');
  });

  it('lands every fact on every dimension and folds facts into deterministic, idempotent rows', () => {
    const facts = [
      fact({ id: 'a1' }),
      fact({ id: 'a2', company: 'Birch Financial', title: 'Data Analyst', normalizedTitle: 'data analyst', matchScore: 91, resumeVersion: null, location: 'Vancouver, BC' }),
      fact({ id: 'a3', createdAt: new Date('2026-08-11T09:00:00Z'), status: 'interviewing', reached: ['submitted', 'interviewing'], respondedAt: new Date('2026-08-13T00:00:00Z') }),
    ];
    const keys = keysOf(facts[1]);
    assert.deepEqual(keys, { all: 'all', title: 'data analyst', company: 'birch financial', seniority: 'unspecified', geography: 'ca:vancouver', source: 'mock', resume_version: 'none', score_band: '85-100' });
    const rows = buildOutcomeMart(facts);
    const again = buildOutcomeMart([...facts].reverse());
    assert.deepEqual(rows, again, 'order of input never changes the output');
    const all10 = rows.find((r) => r.day === '2026-08-10' && r.dimension === 'all')!;
    assert.equal(all10.applications, 2);
    assert.equal(all10.sent, 2);
    const all11 = rows.find((r) => r.day === '2026-08-11' && r.dimension === 'all')!;
    assert.equal(all11.interviews, 1);
    assert.equal(all11.responseSamples, 1);
    const byTitle = rows.filter((r) => r.dimension === 'title').map((r) => `${r.day}:${r.key}=${r.applications}`);
    assert.deepEqual(byTitle, ['2026-08-10:data analyst=1', '2026-08-10:senior data analyst=1', '2026-08-11:senior data analyst=1']);
    // Every dimension sums to the same total as `all` on every day.
    for (const day of ['2026-08-10', '2026-08-11']) {
      const all = rows.find((r) => r.day === day && r.dimension === 'all')!.applications;
      for (const d of DIMENSIONS) if (d !== 'all') assert.equal(rows.filter((r) => r.day === day && r.dimension === d).reduce((n, r) => n + r.applications, 0), all, `${d} on ${day}`);
    }
  });

  it('assembles the dashboard shape from mart rows: totals, series, cuts, rates', () => {
    const rows = buildOutcomeMart([fact({ id: 'a1' }), fact({ id: 'a2', createdAt: new Date('2026-08-12T00:00:00Z'), status: 'offer', reached: ['submitted', 'interviewing', 'offer'], respondedAt: new Date('2026-08-12T10:00:00Z') })]);
    const view = assembleOutcomes(rows, { start: new Date('2026-08-09T00:00:00Z'), end: new Date('2026-08-14T00:00:00Z') }, 'day', 5);
    assert.equal(view.totals.applications, 2);
    assert.equal(view.totals.offers, 1);
    assert.equal(view.rates.responseRate.parts, 500_000);
    assert.equal(view.rates.offerFromInterview.parts, 1_000_000);
    assert.equal(view.overTime.length, 5, 'zero-filled per day');
    assert.deepEqual(view.overTime.map((p) => p.applications), [0, 1, 0, 1, 0]);
    assert.equal(view.cuts.company[0].key, 'maple analytics');
    assert.equal(view.cuts.company[0].parts, 1_000_000);
    assert.equal(view.averageMatchScore, 78);
    const outside = assembleOutcomes(rows, { start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-09-02T00:00:00Z') });
    assert.equal(outside.totals.applications, 2, 'assemble trusts its caller to have selected the days; the reader does that');
  });
});

describe('match mart and benchmark', () => {
  it('tallies bands and the top keywords per day, deterministically', () => {
    const rows = buildMatchMart([
      { userId: 'u1', createdAt: new Date('2026-08-10T00:00:00Z'), matchScore: 88, matchedKeywords: ['SQL', 'python'], missingKeywords: ['Tableau'] },
      { userId: 'u1', createdAt: new Date('2026-08-10T05:00:00Z'), matchScore: 62, matchedKeywords: ['sql'], missingKeywords: ['tableau', 'dbt'] },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].matches, 2);
    assert.equal(rows[0].band85to100, 1);
    assert.equal(rows[0].band50to69, 1);
    assert.deepEqual(rows[0].matchedKeywords[0], { keyword: 'sql', count: 2 });
    assert.deepEqual(rows[0].missingKeywords[0], { keyword: 'tableau', count: 2 });
  });

  it('counts DISTINCT people per cut and suppresses a cohort under the threshold', () => {
    const facts = ['u1', 'u2', 'u3', 'u4'].map((userId, i) => fact({ id: `a${i}`, userId }));
    const bench = buildBenchmarkMart(buildOutcomeMart(facts));
    const all = bench.find((b) => b.dimension === 'all')!;
    assert.equal(all.users, 4);
    assert.equal(all.applications, 4);
    assert.equal(suppressSmallCohort(all).suppressed, true, 'four people is below the threshold');
    const five = buildBenchmarkMart(buildOutcomeMart([...facts, fact({ id: 'a9', userId: 'u5' })])).find((b) => b.dimension === 'all')!;
    const shown = suppressSmallCohort(five);
    assert.equal(shown.suppressed, false);
    assert.equal(MIN_COHORT, 5);
    // One person with many applications is still one person.
    const one = buildBenchmarkMart(buildOutcomeMart(Array.from({ length: 12 }, (_, i) => fact({ id: `b${i}`, userId: 'u1' })))).find((b) => b.dimension === 'all')!;
    assert.equal(one.users, 1);
    assert.equal(suppressSmallCohort(one).suppressed, true);
  });
});

describe('dashboards read marts', () => {
  it('nothing under the candidate read path or the analytics page queries a transactional table', () => {
    const root = path.join(__dirname, '..', 'src');
    const files = [path.join(root, 'lib', 'analytics', 'candidate', 'read.ts'), path.join(root, 'app', '(app)', 'dashboard', 'analytics', 'page.tsx'), path.join(root, 'app', '(app)', 'dashboard', 'page.tsx'), path.join(root, 'app', '(app)', 'dashboard', 'applications', 'page.tsx')];
    // A COUNT or an aggregate is a metric; a findMany of matches or events is a list (what to do next), which ADR-0027 leaves operational.
    const transactional = /\b(tx|db)\.(applicationStatusHistory|applicationInterview|documentVersion|emailThread|job)\.(count|findMany|findFirst|aggregate|groupBy)\b|\b(tx|db)\.(application|jobMatch|activityEvent)\.(count|aggregate|groupBy)\b/;
    // Counting a list in memory by status is a metric variant too.
    const inMemoryVariant = /\.filter\([^)]*\.status[^)]*\)\s*\.length/;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      assert.ok(!transactional.test(src), `${path.relative(root, f)} reads a transactional table for a metric`);
      assert.ok(!inMemoryVariant.test(src), `${path.relative(root, f)} counts a status in memory - a metric variant`);
    }
    // The rollup is the one place that may.
    const rollup = readFileSync(path.join(root, 'lib', 'analytics', 'candidate', 'rollup.ts'), 'utf8');
    assert.ok(/db\.application\.findMany/.test(rollup));
    assert.ok(readdirSync(path.join(root, 'lib', 'analytics', 'candidate')).includes('dictionary.ts'));
  });
});
