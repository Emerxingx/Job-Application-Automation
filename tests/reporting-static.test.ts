/**
 * Stage 21 (ADR-0036) - advanced reporting, statically and purely: the
 * platform metric dictionary is complete, sourced from marts only and
 * mirrored in the governance document; the mart registry, the extraction
 * columns, the RLS classification and the operator sweep agree on every
 * mart; no reporting page or read module queries a transactional table
 * for a metric (the operational queues are the one allow-listed module and
 * may not count); the pure builders are deterministic; freshness, the CSV
 * boundary and the cohort mart round-trip behave.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  CASES_METRICS,
  EMPLOYER_METRICS,
  MART_NAMES,
  MART_REGISTRY,
  MIN_ORG_COHORT,
  PLATFORM_ACTIVITY_METRICS,
  PLATFORM_METRIC_DICTIONARY,
  PLATFORM_METRIC_KEYS,
  PLATFORM_SNAPSHOT_METRICS,
  STAFFING_METRICS,
  platformMetric,
} from '../src/lib/analytics/platform/dictionary';
import { OWNED_ACTIVITY_METRICS, computePlatformActivityRows, computePlatformSnapshotRows, rollupPlatform, type PlatformRollupDeps } from '../src/lib/analytics/platform/rollup';
import { buildCaseRows, buildEmployerRows, buildStaffingRows, type SubmissionFact } from '../src/lib/analytics/organization/marts';
import { rollupOrganizations, type OrganizationRollupDeps } from '../src/lib/analytics/organization/rollup';
import { cohortRowsOf, gridFromRows } from '../src/lib/analytics/finance/cohorts';
import { buildCohortGrid } from '../src/lib/analytics/finance/cohort-grid';
import { describeFreshness, isStale } from '../src/lib/analytics/freshness';
import { DEFAULT_EXPORT_MARTS, MART_COLUMNS, martCsv } from '../src/lib/analytics/warehouse/export';
import { RLS_TABLES } from '../src/lib/tenancy/rls-tables';

const root = path.join(__dirname, '..');
const read = (...p: string[]) => readFileSync(path.join(root, ...p), 'utf8');

describe('Stage 21 - the platform metric dictionary', () => {
  it('names every metric once, sourced from a registered mart, with a definition', () => {
    assert.equal(new Set(PLATFORM_METRIC_KEYS).size, PLATFORM_METRIC_KEYS.length);
    for (const m of PLATFORM_METRIC_DICTIONARY) {
      assert.ok(m.definition.length > 20, m.key);
      const mart = m.source.split('.')[0]!;
      assert.ok(MART_NAMES.includes(mart as never), `${m.key} sources ${mart}, which is not a registered mart`);
      assert.ok(!/\b(Submission|Placement|Payment|Invoice|Case|Session|SupportTicket|AiRun|JobSourceRun)\./.test(m.source), `${m.key} must source a mart, never a transactional table`);
    }
    assert.equal(platformMetric('mrr').source, 'DailyRevenueRollup.mrrCents');
    assert.throws(() => platformMetric('nope'), /Unknown platform metric/);
  });

  it('covers every metric the rollups write and the read modules read', () => {
    for (const k of [...PLATFORM_ACTIVITY_METRICS, ...PLATFORM_SNAPSHOT_METRICS, ...EMPLOYER_METRICS, ...STAFFING_METRICS, ...CASES_METRICS]) assert.ok(PLATFORM_METRIC_KEYS.includes(k), `dictionary lacks ${k}`);
    // The read modules and the rollups name metrics as string literals; every one must be defined.
    const sources = [read('src', 'lib', 'analytics', 'organization', 'read.ts'), read('src', 'lib', 'analytics', 'organization', 'marts.ts'), read('src', 'lib', 'analytics', 'platform', 'rollup.ts'), read('src', 'app', '(app)', 'console', 'page.tsx')];
    const names = new Set<string>();
    for (const src of sources) for (const m of src.matchAll(/'([a-z_]+)'/g)) names.add(m[1]!);
    for (const k of [...EMPLOYER_METRICS, ...STAFFING_METRICS, ...CASES_METRICS]) assert.ok(names.has(k), `${k} is defined but nothing writes or reads it`);
  });

  it('is mirrored in docs/governance/METRIC_DICTIONARY.md - every key, definition, mart and SLA', () => {
    const doc = read('docs', 'governance', 'METRIC_DICTIONARY.md');
    for (const m of PLATFORM_METRIC_DICTIONARY) {
      assert.ok(doc.includes(`\`${m.key}\``), `document lacks ${m.key}`);
      assert.ok(doc.includes(m.definition), `document definition differs for ${m.key}`);
    }
    for (const mart of MART_NAMES) {
      assert.ok(doc.includes(`\`${mart}\``), `document lacks mart ${mart}`);
      assert.ok(doc.includes(`${MART_REGISTRY[mart].slaHours}h`) || doc.includes(`${MART_REGISTRY[mart].slaHours} hours`), `document lacks the SLA of ${mart}`);
    }
    assert.ok(doc.includes(`${MIN_ORG_COHORT}`));
  });
});

describe('Stage 21 - the mart registry is one truth', () => {
  it('every mart is a Prisma model, classified under RLS as the registry says, extracted with its columns, and rebuilt by the operator sweep', () => {
    const schema = read('prisma', 'schema.prisma');
    const sweep = read('src', 'lib', 'analytics', 'rollups.ts');
    for (const mart of MART_NAMES) {
      assert.ok(schema.includes(`model ${mart} {`), `${mart} is not a model`);
      const rls = RLS_TABLES[mart];
      assert.ok(rls, `${mart} is not classified in rls-tables.ts`);
      const expected = MART_REGISTRY[mart].scope === 'system' ? 'system' : MART_REGISTRY[mart].scope === 'org' ? 'org' : 'user';
      assert.equal(rls.kind, expected, `${mart}: registry says ${MART_REGISTRY[mart].scope}, RLS says ${rls.kind}`);
      assert.ok(MART_COLUMNS[mart].includes('day'), `${mart} must be partitioned by day`);
      for (const job of MART_REGISTRY[mart].jobs) assert.ok(sweep.includes(`'${job}'`), `rollupAll does not run ${job}`);
      assert.ok(MART_REGISTRY[mart].jobs.length >= 1);
      assert.ok(MART_REGISTRY[mart].slaHours >= 24 && MART_REGISTRY[mart].slaHours <= 48, `${mart}: an SLA is daily, stated`);
    }
    assert.deepEqual(Object.keys(MART_COLUMNS).sort(), [...MART_NAMES].sort());
  });

  it('extracts system- and organisation-scoped marts by default and never a user-scoped one', () => {
    for (const mart of DEFAULT_EXPORT_MARTS) assert.notEqual(MART_REGISTRY[mart].scope, 'user', `${mart} is per person and must be opt-in (ADR-0015)`);
    for (const mart of MART_NAMES) if (MART_REGISTRY[mart].scope !== 'user') assert.ok(DEFAULT_EXPORT_MARTS.includes(mart), `${mart} is not extracted`);
  });

  it('the extraction columns are real columns of the model', () => {
    const schema = read('prisma', 'schema.prisma');
    for (const mart of MART_NAMES) {
      const block = schema.slice(schema.indexOf(`model ${mart} {`));
      const body = block.slice(0, block.indexOf('\n}'));
      for (const col of MART_COLUMNS[mart]) assert.ok(new RegExp(`^\\s+${col}\\s`, 'm').test(body), `${mart}.${col} is not a column`);
    }
  });
});

describe('Stage 21 - reporting pages and read modules touch no transactional table', () => {
  // A COUNT, a findMany, an aggregate or a groupBy on a source table is a metric computed on the page: refused.
  const transactional = /\b(tx|db)\.(payment|invoice|subscription|subscriptionEvent|submission|submissionEvent|requisition|placement|placementInvoice|engagement|representationConsent|case|caseOutcome|caseFollowUp|caseNote|aiRun|jobSourceRun|job|supportTicket|user|session|organization|application|usageEvent|activityEvent|auditLog|careerPlan|dunningAttempt)\.(count|findMany|findFirst|aggregate|groupBy)\b/;
  const inMemoryVariant = /\.filter\([^)]*\.status[^)]*\)\s*\.length/;
  const files = [
    ['src', 'app', '(app)', 'console', 'page.tsx'],
    ['src', 'app', '(app)', 'console', 'revenue', 'page.tsx'],
    ['src', 'app', '(app)', 'console', 'revenue', 'cohorts.ts'],
    ['src', 'app', '(app)', 'dashboard', 'employer', 'page.tsx'],
    ['src', 'app', '(app)', 'dashboard', 'cases', 'page.tsx'],
    ['src', 'app', '(app)', 'api', 'cases', 'summary', 'route.ts'],
    ['src', 'app', '(app)', 'api', 'staffing', 'productivity', 'route.ts'],
    ['src', 'lib', 'analytics', 'organization', 'read.ts'],
    ['src', 'lib', 'analytics', 'finance', 'summary.ts'],
    ['src', 'lib', 'analytics', 'freshness.ts'],
    ['src', 'lib', 'analytics', 'warehouse', 'export.ts'],
    ['src', 'components', 'mart-freshness.tsx'],
  ];

  it('refuses a transactional query and an in-memory status count on every reporting surface', () => {
    for (const f of files) {
      const src = read(...f);
      assert.ok(!transactional.test(src), `${f.join('/')} reads a transactional table for a metric`);
      assert.ok(!inMemoryVariant.test(src), `${f.join('/')} counts a status in memory - a metric variant`);
    }
  });

  it('the operational queues are the one allow-listed module, and they list - never count, sum or group', () => {
    const src = read('src', 'app', '(app)', 'console', 'queues.ts');
    assert.ok(/db\.payment\.findMany/.test(src) && /db\.user\.findMany/.test(src), 'the queues are the live reads');
    assert.ok(!/\.(count|aggregate|groupBy)\(/.test(src), 'a count or an aggregate in the queues is a metric and belongs in the dictionary');
    assert.match(src, /take/);
    // The overview reaches the live tables only through the queues.
    const overview = read('src', 'app', '(app)', 'console', 'page.tsx');
    assert.ok(!/from '@\/lib\/db'/.test(overview), 'the overview imports no database client');
    assert.match(overview, /from '\.\/queues'/);
  });

  it('the employer, staffing and case services report through the mart reads', () => {
    assert.match(read('src', 'lib', 'employer', 'service.ts'), /readEmployerReport\(/);
    assert.match(read('src', 'lib', 'staffing', 'service.ts'), /readStaffingProductivity\(/);
    assert.match(read('src', 'lib', 'cases', 'service.ts'), /readCaseloadSummary\(/);
    // The rollup is the one reader of the source tables for these metrics.
    const rollup = read('src', 'lib', 'analytics', 'organization', 'rollup.ts');
    for (const t of ['submission', 'submissionEvent', 'engagement', 'placement', 'placementInvoice', 'case', 'caseOutcome', 'caseFollowUp']) assert.ok(new RegExp(`db\\.${t}\\.findMany`).test(rollup), `rollup reads ${t}`);
    // Case facts are ids, kinds and dates: never a note, a barrier or a name.
    assert.ok(!/\b(note|barriers?|employerName|assessment|content)\s*:\s*true\b|db\.(caseNote|caseAssessment)\./.test(rollup), 'the case rollup must not read a restricted field');
  });

  it('every page that shows a mart shows its freshness', () => {
    for (const f of [['src', 'app', '(app)', 'console', 'page.tsx'], ['src', 'app', '(app)', 'console', 'revenue', 'page.tsx'], ['src', 'app', '(app)', 'dashboard', 'employer', 'page.tsx'], ['src', 'app', '(app)', 'dashboard', 'cases', 'page.tsx']]) {
      assert.ok(/martFreshness\(|MartFreshnessNote/.test(read(...f)), `${f.join('/')} shows no freshness`);
    }
  });
});

describe('Stage 21 - the pure organisation builders', () => {
  const d = (s: string) => new Date(s);
  const subs: SubmissionFact[] = [
    { id: 's1', organizationId: 'o1', source: 'applied', createdAt: d('2026-08-03T10:00:00Z'), firstInto: { consented: d('2026-08-03T11:00:00Z'), screening: d('2026-08-05T10:00:00Z'), interviewing: d('2026-08-10T10:00:00Z'), hired: d('2026-08-20T10:00:00Z') } },
    { id: 's2', organizationId: 'o1', source: 'sourced', createdAt: d('2026-08-03T15:00:00Z'), firstInto: { consented: d('2026-08-04T10:00:00Z'), screening: d('2026-08-09T10:00:00Z'), rejected: d('2026-08-12T10:00:00Z') } },
    { id: 's3', organizationId: 'o2', source: 'sourced', createdAt: d('2026-08-04T10:00:00Z'), firstInto: {} },
  ];
  const moves = [
    { organizationId: 'o1', actorId: 'r1', at: d('2026-08-05T10:00:00Z') },
    { organizationId: 'o1', actorId: 'r1', at: d('2026-08-05T12:00:00Z') },
    { organizationId: 'o1', actorId: 'r2', at: d('2026-08-09T10:00:00Z') },
  ];

  it('attributes the funnel to the creation day, cuts by source, sums whole days with the people behind them, and counts moves by recruiter', () => {
    const rows = buildEmployerRows(subs, moves);
    const find = (org: string, day: string, metric: string, dimension = 'all', key = 'all') => rows.find((r) => r.organizationId === org && r.day === day && r.metric === metric && r.dimension === dimension && r.key === key);
    assert.equal(find('o1', '2026-08-03', 'submissions')?.valueInt, 2);
    assert.equal(find('o1', '2026-08-03', 'submissions', 'source', 'applied')?.valueInt, 1);
    assert.equal(find('o1', '2026-08-03', 'consented')?.valueInt, 2);
    assert.equal(find('o1', '2026-08-03', 'screening')?.valueInt, 2);
    assert.equal(find('o1', '2026-08-03', 'interviewing')?.valueInt, 1);
    assert.equal(find('o1', '2026-08-03', 'hired')?.valueInt, 1);
    assert.equal(find('o1', '2026-08-03', 'hired', 'source', 'applied')?.valueInt, 1);
    assert.equal(find('o1', '2026-08-03', 'rejected')?.valueInt, 1);
    assert.equal(find('o1', '2026-08-03', 'days_to_screening')?.valueInt, 2 + 6, 'sum of whole days');
    assert.equal(find('o1', '2026-08-03', 'days_to_screening')?.people, 2, 'the people behind the sum - the mean is 4.0');
    assert.equal(find('o1', '2026-08-03', 'days_to_hired')?.valueInt, 17);
    assert.equal(find('o1', '2026-08-03', 'days_to_hired')?.people, 1);
    assert.equal(find('o1', '2026-08-05', 'stage_moves')?.valueInt, 2);
    assert.equal(find('o1', '2026-08-05', 'stage_moves', 'recruiter', 'r1')?.valueInt, 2);
    assert.equal(find('o1', '2026-08-09', 'stage_moves', 'recruiter', 'r2')?.valueInt, 1);
    assert.equal(find('o2', '2026-08-04', 'submissions')?.valueInt, 1);
    assert.equal(find('o2', '2026-08-04', 'consented'), undefined, 'a stage never reached writes no row');
    assert.ok(rows.every((r) => r.organizationId !== 'o2' || r.day === '2026-08-04'), 'an organisation never receives another organisation\'s rows');
  });

  it('is deterministic and idempotent over the same facts', () => {
    const a = buildEmployerRows(subs, moves);
    const b = buildEmployerRows([...subs].reverse(), [...moves].reverse());
    assert.deepEqual(a, b);
  });

  it('staffing: fell-off counts only inside the guarantee, fees are cents, an unassigned recruiter is named, credits attribute to the issue day', () => {
    const rows = buildStaffingRows({
      engagements: [{ organizationId: 'o1', createdAt: d('2026-08-01T10:00:00Z'), ownerRecruiterId: 'r1' }, { organizationId: 'o1', createdAt: d('2026-08-01T10:00:00Z'), ownerRecruiterId: null }],
      representations: [{ organizationId: 'o1', requestedAt: d('2026-08-02T10:00:00Z'), requestedById: 'r1', status: 'granted' }, { organizationId: 'o1', requestedAt: d('2026-08-02T10:00:00Z'), requestedById: 'r1', status: 'declined' }],
      placements: [
        { organizationId: 'o1', createdAt: d('2026-08-10T10:00:00Z'), recruiterId: 'r1', feeCents: 1_800_000, status: 'fell_off', fellOffAt: d('2026-09-01T00:00:00Z'), guaranteeEndsAt: d('2026-11-08T00:00:00Z') },
        { organizationId: 'o1', createdAt: d('2026-08-10T10:00:00Z'), recruiterId: 'r1', feeCents: 1_000_000, status: 'fell_off', fellOffAt: d('2026-12-01T00:00:00Z'), guaranteeEndsAt: d('2026-11-08T00:00:00Z') },
      ],
      invoices: [
        { organizationId: 'o1', issuedAt: d('2026-08-11T10:00:00Z'), paidAt: d('2026-08-20T10:00:00Z'), amountCents: 1_800_000, creditedCents: 600_000, status: 'paid' },
        { organizationId: 'o1', issuedAt: null, paidAt: null, amountCents: 5, creditedCents: 0, status: 'draft' },
      ],
    });
    const find = (day: string, metric: string, dimension = 'all', key = 'all') => rows.find((r) => r.day === day && r.metric === metric && r.dimension === dimension && r.key === key);
    assert.equal(find('2026-08-01', 'engagements_opened')?.valueInt, 2);
    assert.equal(find('2026-08-01', 'engagements_opened', 'recruiter', 'unassigned')?.valueInt, 1);
    assert.equal(find('2026-08-02', 'representations_requested', 'recruiter', 'r1')?.valueInt, 2);
    assert.equal(find('2026-08-02', 'representations_granted', 'recruiter', 'r1')?.valueInt, 1);
    assert.equal(find('2026-08-10', 'placements')?.valueInt, 2);
    assert.equal(find('2026-08-10', 'placements_fell_off_in_guarantee')?.valueInt, 1, 'a fall-off after the guarantee is not a guarantee event');
    assert.equal(find('2026-08-10', 'placement_fee_cents')?.valueCents, 2_800_000);
    assert.equal(find('2026-08-10', 'placement_fee_cents')?.valueInt, 0);
    assert.equal(find('2026-08-11', 'invoices_issued')?.valueInt, 1);
    assert.equal(find('2026-08-11', 'invoices_issued')?.valueCents, 1_800_000);
    assert.equal(find('2026-08-20', 'invoices_paid')?.valueCents, 1_800_000);
    assert.equal(find('2026-08-11', 'invoices_credited')?.valueCents, 600_000, 'the credit sits on the issue day');
    assert.ok(!rows.some((r) => r.metric === 'invoices_issued' && r.valueCents === 5), 'a draft is not issued');
  });

  it('cases: outcome rows carry the distinct clients behind them, cut by kind only', () => {
    const rows = buildCaseRows({
      cases: [{ organizationId: 'o1', openedAt: d('2026-08-01T10:00:00Z'), closedAt: d('2026-08-30T10:00:00Z') }, { organizationId: 'o1', openedAt: d('2026-08-01T11:00:00Z'), closedAt: null }],
      outcomes: [
        { organizationId: 'o1', caseId: 'c1', kind: 'employed', recordedAt: d('2026-08-15T10:00:00Z') },
        { organizationId: 'o1', caseId: 'c1', kind: 'training', recordedAt: d('2026-08-15T11:00:00Z') },
        { organizationId: 'o1', caseId: 'c2', kind: 'employed', recordedAt: d('2026-08-15T12:00:00Z') },
      ],
      followUps: [{ organizationId: 'o1', dueAt: d('2026-08-20T10:00:00Z'), completedAt: d('2026-08-21T10:00:00Z') }, { organizationId: 'o1', dueAt: d('2026-08-20T10:00:00Z'), completedAt: null }],
    });
    const find = (day: string, metric: string, dimension = 'all', key = 'all') => rows.find((r) => r.day === day && r.metric === metric && r.dimension === dimension && r.key === key);
    assert.equal(find('2026-08-01', 'cases_opened')?.valueInt, 2);
    assert.equal(find('2026-08-30', 'cases_closed')?.valueInt, 1);
    assert.equal(find('2026-08-15', 'outcomes')?.valueInt, 3);
    assert.equal(find('2026-08-15', 'outcomes')?.people, 2, 'two clients behind three outcomes');
    assert.equal(find('2026-08-15', 'outcomes', 'kind', 'employed')?.people, 2);
    assert.equal(find('2026-08-15', 'outcomes', 'kind', 'training')?.people, 1);
    assert.equal(find('2026-08-20', 'follow_ups_due')?.valueInt, 2);
    assert.equal(find('2026-08-20', 'follow_ups_completed')?.valueInt, 1);
    assert.ok(rows.every((r) => r.dimension === 'all' || r.dimension === 'kind'), 'no other cut of a caseload exists');
    assert.ok(rows.every((r) => r.metric !== 'outcomes' || r.people > 0), 'every outcome row names how many clients are behind it');
  });

  it('rollupOrganizations replaces the (days x organisation) scope, drops a fact attributed outside the window, and records a failed run', async () => {
    const calls: { scope: { days: string[]; organizationId?: string }; rows: number }[] = [];
    const runs: string[] = [];
    const deps: OrganizationRollupDeps = {
      loadEmployer: async () => ({ subs: [subs[0]!, { ...subs[0]!, id: 'late', createdAt: d('2026-09-15T10:00:00Z') }], moves }),
      loadStaffing: async () => ({ engagements: [], representations: [], placements: [], invoices: [] }),
      loadCases: async () => ({ cases: [], outcomes: [], followUps: [] }),
      replaceRows: async (scope, rows) => {
        calls.push({ scope, rows: rows.length });
        return rows.length;
      },
      startRun: async (job) => {
        runs.push(`start:${job}`);
        return 'run1';
      },
      finishRun: async (id, r) => {
        runs.push(`${r.status}:${id}`);
      },
    };
    const range = { start: d('2026-08-01T00:00:00Z'), end: d('2026-09-01T00:00:00Z') };
    const result = await rollupOrganizations(range, { deps, organizationId: 'o1' });
    assert.equal(result.status, 'succeeded');
    assert.equal(calls[0]!.scope.organizationId, 'o1');
    assert.equal(calls[0]!.scope.days.length, 31);
    assert.ok(calls[0]!.rows > 0);
    assert.deepEqual(runs, ['start:organization_reporting', 'succeeded:run1']);
    // The September fact never lands in an August scope.
    assert.equal(result.organizations, 1);

    const failing: OrganizationRollupDeps = { ...deps, loadStaffing: async () => { throw new Error('boom'); } };
    runs.length = 0;
    await assert.rejects(rollupOrganizations(range, { deps: failing }), /boom/);
    assert.deepEqual(runs, ['start:organization_reporting', 'failed:run1']);
  });
});

describe('Stage 21 - the platform rollup', () => {
  const d = (s: string) => new Date(s);
  const range = { start: d('2026-08-01T00:00:00Z'), end: d('2026-08-04T00:00:00Z') };

  it('owns every activity metric except the three Stage 13 writes, and zero-fills each day', () => {
    assert.ok(!OWNED_ACTIVITY_METRICS.includes('signups') && !OWNED_ACTIVITY_METRICS.includes('applications_submitted') && !OWNED_ACTIVITY_METRICS.includes('active_users'));
    const rows = computePlatformActivityRows({
      failedPayments: [d('2026-08-02T10:00:00Z')],
      aiRuns: [{ createdAt: d('2026-08-02T10:00:00Z'), status: 'succeeded', costCents: 3 }, { createdAt: d('2026-08-02T11:00:00Z'), status: 'refused', costCents: null }],
      connectorRuns: [{ startedAt: d('2026-08-03T10:00:00Z'), status: 'failed', created: 0 }, { startedAt: d('2026-08-03T10:00:00Z'), status: 'succeeded', created: 12 }],
      careerPlans: [{ createdAt: d('2026-08-01T10:00:00Z'), supersedesId: null }, { createdAt: d('2026-08-01T10:00:00Z'), supersedesId: 'x' }],
      organizationsVerified: [d('2026-08-01T10:00:00Z')],
      ssoSignIns: [d('2026-08-03T10:00:00Z'), d('2026-08-03T10:00:00Z')],
    }, range);
    assert.equal(rows.length, 3 * OWNED_ACTIVITY_METRICS.length, 'one row per day per owned metric');
    const v = (day: string, metric: string) => rows.find((r) => r.day === day && r.metric === metric)!;
    assert.equal(v('2026-08-02', 'failed_payments').valueInt, 1);
    assert.equal(v('2026-08-01', 'failed_payments').valueInt, 0, 'a quiet day is a zero, not a gap');
    assert.equal(v('2026-08-02', 'ai_runs').valueInt, 2);
    assert.equal(v('2026-08-02', 'ai_refused').valueInt, 1);
    assert.equal(v('2026-08-02', 'ai_cost_cents').valueCents, 3);
    assert.equal(v('2026-08-03', 'connector_runs').valueInt, 2);
    assert.equal(v('2026-08-03', 'connector_failures').valueInt, 1);
    assert.equal(v('2026-08-03', 'jobs_captured').valueInt, 12);
    assert.equal(v('2026-08-01', 'career_plans_created').valueInt, 1);
    assert.equal(v('2026-08-01', 'career_plans_refreshed').valueInt, 1);
    assert.equal(v('2026-08-01', 'organizations_verified').valueInt, 1);
    assert.equal(v('2026-08-03', 'sso_sign_ins').valueInt, 2);
    assert.ok(rows.every((r) => r.dimension === 'all' && r.valueParts === 0));
  });

  it('writes snapshot metrics for the as-of day only, and replaces the two scopes separately', async () => {
    const scopes: { days: string[]; metrics: readonly string[] }[] = [];
    const deps: PlatformRollupDeps = {
      loadFacts: async () => ({ failedPayments: [], aiRuns: [], connectorRuns: [], careerPlans: [], organizationsVerified: [], ssoSignIns: [] }),
      loadSnapshot: async () => ({ openTickets: 4, breachedTickets: 1, overdueInvoices: 2, overdueInvoiceCents: 5_800, activeOrganizations: 3, liveSessions: 9 }),
      replaceDailyMetrics: async (scope, rows) => {
        scopes.push(scope);
        return rows.length;
      },
    };
    const result = await rollupPlatform(range, { deps, asOf: d('2026-08-03T15:00:00Z') });
    assert.equal(result.status, 'succeeded');
    assert.equal(scopes.length, 2);
    assert.deepEqual(scopes[0]!.days, ['2026-08-01', '2026-08-02', '2026-08-03']);
    assert.deepEqual([...scopes[0]!.metrics], [...OWNED_ACTIVITY_METRICS]);
    assert.deepEqual(scopes[1]!.days, ['2026-08-03'], 'a snapshot is never backfilled onto a past day');
    assert.deepEqual([...scopes[1]!.metrics], [...PLATFORM_SNAPSHOT_METRICS]);
    const snap = computePlatformSnapshotRows(await deps.loadSnapshot(new Date()), '2026-08-03');
    assert.equal(snap.length, PLATFORM_SNAPSHOT_METRICS.length);
    assert.equal(snap.find((r) => r.metric === 'overdue_invoice_cents')!.valueCents, 5_800);
    assert.equal(snap.find((r) => r.metric === 'breached_tickets')!.valueInt, 1);
    assert.ok(snap.every((r) => r.day === '2026-08-03'));
    assert.equal(result.rowsWritten, 3 * OWNED_ACTIVITY_METRICS.length + PLATFORM_SNAPSHOT_METRICS.length);
  });
});

describe('Stage 21 - freshness', () => {
  it('a mart never rebuilt is stale; within the SLA fresh; past it stale', () => {
    const now = new Date('2026-09-05T12:00:00Z');
    assert.equal(isStale(null, 26, now), true);
    assert.equal(isStale(new Date('2026-09-04T12:00:00Z'), 26, now), false);
    assert.equal(isStale(new Date('2026-09-04T09:59:00Z'), 26, now), true);
  });

  it('describes the state in words a founder can act on', () => {
    assert.match(describeFreshness({ mart: 'DailyMetric', jobs: ['platform_metrics'], slaHours: 26, asOf: null, stale: true, lastError: null }), /never rebuilt - run npm run analytics:rollup/);
    assert.equal(describeFreshness({ mart: 'DailyMetric', jobs: ['platform_metrics'], slaHours: 26, asOf: new Date('2026-09-05T03:10:00Z'), stale: false, lastError: null }), 'DailyMetric: data as of 2026-09-05 03:10 UTC');
    assert.match(describeFreshness({ mart: 'DailyMetric', jobs: ['platform_metrics'], slaHours: 26, asOf: new Date('2026-09-01T03:10:00Z'), stale: true, lastError: null }), /^DailyMetric: STALE - last rebuilt 2026-09-01 03:10 UTC \(SLA 26h\)$/);
  });
});

describe('Stage 21 - the warehouse extraction boundary', () => {
  it('writes the documented columns in order, CRLF, quoting what needs it and neutralising a formula cell', () => {
    const csv = martCsv('OrganizationDailyMart', [{ day: '2026-08-01', organizationId: 'o1', product: 'employer', metric: 'submissions', dimension: 'source', key: '=cmd|"x", y', valueInt: 1, valueCents: 0, people: 0, createdAt: new Date('2026-09-05T00:00:00Z') }]);
    const lines = csv.split('\r\n');
    assert.equal(lines[0], MART_COLUMNS.OrganizationDailyMart.join(','));
    assert.equal(lines[1], `2026-08-01,o1,employer,submissions,source,"'=cmd|""x"", y",1,0,0`);
    assert.equal(lines[2], '', 'ends with a line break');
    assert.ok(!csv.includes('createdAt'), 'a column outside the contract is not extracted');
    const dated = martCsv('SubscriptionCohortMart', [{ day: '2026-09-05', currency: 'CAD', cohortMonth: '2026-08', monthOffset: 0, subscribers: 3, retained: 3 }]);
    assert.equal(dated.split('\r\n')[1], '2026-09-05,CAD,2026-08,0,3,3');
    const nulls = martCsv('DailyMetric', [{ day: '2026-09-05', metric: 'x', dimension: 'all', valueInt: null, valueCents: undefined, valueParts: 0 }]);
    assert.equal(nulls.split('\r\n')[1], '2026-09-05,x,all,,,0');
  });

  it('the recipe document names every mart and the key layout', () => {
    const doc = read('docs', 'architecture', 'WAREHOUSE_EXTRACTION.md');
    for (const mart of MART_NAMES) assert.ok(doc.includes(`\`${mart}\``), `WAREHOUSE_EXTRACTION.md lacks ${mart}`);
    assert.match(doc, /warehouse\/<mart>\/<day>\.csv/);
    assert.match(doc, /NOT VERIFIED/);
  });
});

describe('Stage 21 - the cohort mart round-trips the grid', () => {
  it('rows -> grid equals the grid the pure builder draws, with parts recomputed one way', () => {
    const now = new Date('2026-09-05T12:00:00Z');
    const s = (startedAt: string, canceledAt: string | null = null) => ({ startedAt: new Date(startedAt), canceledAt: canceledAt ? new Date(canceledAt) : null, suspendedAt: null, status: canceledAt ? 'canceled' : 'active', currency: 'CAD' });
    const subs = [s('2026-06-03T00:00:00Z'), s('2026-06-20T00:00:00Z', '2026-08-02T00:00:00Z'), s('2026-07-10T00:00:00Z'), s('2026-09-01T00:00:00Z')];
    const grid = buildCohortGrid(subs, now);
    const rows = cohortRowsOf('CAD', grid, '2026-09-05');
    assert.ok(rows.every((r) => r.currency === 'CAD' && r.day === '2026-09-05'));
    const back = gridFromRows(rows, now);
    assert.deepEqual(back.rows, grid.rows);
    assert.deepEqual(back.offsets, grid.offsets);
    assert.equal(back.totalSubscriptions, grid.totalSubscriptions);
    const june = back.rows.find((r) => r.key === '2026-06')!;
    assert.equal(june.size, 2);
    assert.equal(june.cells.find((c) => c.offset === 2)!.retained, 2, 'still alive on 1 August; cancelled on the 2nd');
    assert.equal(june.cells.find((c) => c.offset === 3)!.retained, 1);
    assert.equal(june.cells.find((c) => c.offset === 3)!.parts, 500_000);
  });
});
