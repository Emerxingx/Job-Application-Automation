import { db } from '@/lib/db';
import { dayKey, eachDayKey, normalizeRange, snapToUtcDays } from '../time';
import type { DailyMetricRow, DateRange, RollupResult } from '../types';
import { PLATFORM_ACTIVITY_METRICS, PLATFORM_SNAPSHOT_METRICS } from './dictionary';

/**
 * Stage 21 (ADR-0036) - the platform rollup: every founder/platform,
 * financial-attention, AI-cost, connector-health and career-transition metric
 * the console reads, written to `DailyMetric` by the ONLY code that reads the
 * transactional tables for them.
 *
 * Two kinds of metric, two replace scopes:
 * - ACTIVITY metrics are attributed to the day the fact happened and the
 *   whole (days x metrics) scope is replaced, so any number of runs over any
 *   range converge on the same rows.
 * - SNAPSHOT metrics are point-in-time (open tickets, overdue invoices, live
 *   sessions, active organisations): they are computed for the AS-OF day of
 *   the run only, and earlier days keep what their own run recorded. A
 *   backfill cannot reconstruct what was open on a past day from today's
 *   state, and pretending otherwise would be a fabricated history.
 *
 * Stage 13's `rollupPlatformMetrics` (signups, applications, active users)
 * stays as the owner of those three; this job owns the rest, and the two
 * managed sets are disjoint so neither deletes the other's rows.
 */
export const PLATFORM_ROLLUP_JOB = 'platform_metrics';

/** The activity metrics THIS job owns (the Stage 13 job owns the first three of PLATFORM_ACTIVITY_METRICS). */
export const OWNED_ACTIVITY_METRICS: readonly string[] = PLATFORM_ACTIVITY_METRICS.filter((m) => !['signups', 'applications_submitted', 'active_users'].includes(m));

export interface PlatformFacts {
  failedPayments: Date[];
  aiRuns: { createdAt: Date; status: string; costCents: number | null }[];
  connectorRuns: { startedAt: Date; status: string; created: number }[];
  careerPlans: { createdAt: Date; supersedesId: string | null }[];
  organizationsVerified: Date[];
  ssoSignIns: Date[];
}

export interface PlatformSnapshot {
  openTickets: number;
  breachedTickets: number;
  overdueInvoices: number;
  overdueInvoiceCents: number;
  activeOrganizations: number;
  liveSessions: number;
}

export interface PlatformRollupDeps {
  loadFacts(range: DateRange): Promise<PlatformFacts>;
  loadSnapshot(asOf: Date): Promise<PlatformSnapshot>;
  replaceDailyMetrics(scope: { days: string[]; metrics: readonly string[] }, rows: DailyMetricRow[]): Promise<number>;
  startRun?(job: string, range: DateRange): Promise<string | null>;
  finishRun?(id: string | null, result: { status: 'succeeded' | 'failed'; rowsRead: number; rowsWritten: number; error?: string }): Promise<void>;
}

const row = (day: string, metric: string, valueInt: number, valueCents = 0): DailyMetricRow => ({ day, metric, dimension: 'all', valueInt, valueCents, valueParts: 0 });

/** Pure: fold the facts into one row per (day, metric), zero-filled so a quiet day is a zero, not a gap. Deterministic order. */
export function computePlatformActivityRows(facts: PlatformFacts, range: DateRange): DailyMetricRow[] {
  const days = eachDayKey(range);
  const counts = new Map<string, { n: number; cents: number }>();
  const bump = (at: Date, metric: string, n = 1, cents = 0) => {
    const k = `${dayKey(at)}|${metric}`;
    const c = counts.get(k) ?? { n: 0, cents: 0 };
    c.n += n;
    c.cents += cents;
    counts.set(k, c);
  };
  for (const at of facts.failedPayments) bump(at, 'failed_payments');
  for (const r of facts.aiRuns) {
    bump(r.createdAt, 'ai_runs');
    if (r.status === 'refused') bump(r.createdAt, 'ai_refused');
    bump(r.createdAt, 'ai_cost_cents', 0, r.costCents ?? 0);
  }
  for (const r of facts.connectorRuns) {
    bump(r.startedAt, 'connector_runs');
    if (r.status === 'failed' || r.status === 'refused') bump(r.startedAt, 'connector_failures');
    bump(r.startedAt, 'jobs_captured', r.created);
  }
  for (const p of facts.careerPlans) bump(p.createdAt, p.supersedesId ? 'career_plans_refreshed' : 'career_plans_created');
  for (const at of facts.organizationsVerified) bump(at, 'organizations_verified');
  for (const at of facts.ssoSignIns) bump(at, 'sso_sign_ins');
  const rows: DailyMetricRow[] = [];
  for (const day of days) {
    for (const metric of OWNED_ACTIVITY_METRICS) {
      const c = counts.get(`${day}|${metric}`);
      rows.push(row(day, metric, metric === 'ai_cost_cents' ? 0 : (c?.n ?? 0), metric === 'ai_cost_cents' ? (c?.cents ?? 0) : 0));
    }
  }
  return rows;
}

export function computePlatformSnapshotRows(snapshot: PlatformSnapshot, asOfDay: string): DailyMetricRow[] {
  return [row(asOfDay, 'open_tickets', snapshot.openTickets), row(asOfDay, 'breached_tickets', snapshot.breachedTickets), row(asOfDay, 'overdue_invoices', snapshot.overdueInvoices), row(asOfDay, 'overdue_invoice_cents', 0, snapshot.overdueInvoiceCents), row(asOfDay, 'active_organizations', snapshot.activeOrganizations), row(asOfDay, 'live_sessions', snapshot.liveSessions)];
}

export const prismaPlatformDeps: PlatformRollupDeps = {
  async loadFacts(range) {
    const w = normalizeRange(range);
    const bounds = { gte: w.start, lt: w.end };
    const [failed, ai, runs, plans, orgs, sso] = await Promise.all([
      db.payment.findMany({ where: { status: 'failed', failedAt: bounds }, select: { failedAt: true } }),
      db.aiRun.findMany({ where: { createdAt: bounds }, select: { createdAt: true, status: true, costCents: true } }),
      db.jobSourceRun.findMany({ where: { startedAt: bounds }, select: { startedAt: true, status: true, created: true } }),
      db.careerPlan.findMany({ where: { createdAt: bounds }, select: { createdAt: true, supersedesId: true } }),
      db.organization.findMany({ where: { verifiedAt: bounds }, select: { verifiedAt: true } }),
      db.auditLog.findMany({ where: { action: 'auth.sso.succeeded', createdAt: bounds }, select: { createdAt: true } }),
    ]);
    return { failedPayments: failed.flatMap((p) => (p.failedAt ? [p.failedAt] : [])), aiRuns: ai, connectorRuns: runs, careerPlans: plans, organizationsVerified: orgs.flatMap((o) => (o.verifiedAt ? [o.verifiedAt] : [])), ssoSignIns: sso.map((r) => r.createdAt) };
  },
  async loadSnapshot(asOf) {
    const [openTickets, breachedTickets, overdue, activeOrganizations, liveSessions] = await Promise.all([
      db.supportTicket.count({ where: { status: { in: ['open', 'pending', 'on_hold'] } } }),
      db.supportTicket.count({ where: { status: { in: ['open', 'pending', 'on_hold'] }, breachedSla: true } }),
      db.invoice.aggregate({ where: { status: 'open', dueAt: { lt: asOf } }, _count: { _all: true }, _sum: { amountDueCents: true } }),
      db.organization.count({ where: { type: { not: 'personal' }, status: 'active' } }),
      db.session.count({ where: { revokedAt: null, expiresAt: { gt: asOf } } }),
    ]);
    return { openTickets, breachedTickets, overdueInvoices: overdue._count._all, overdueInvoiceCents: overdue._sum.amountDueCents ?? 0, activeOrganizations, liveSessions };
  },
  async replaceDailyMetrics(scope, rows) {
    if (scope.days.length === 0) return 0;
    return db.$transaction(async (tx) => {
      await tx.dailyMetric.deleteMany({ where: { day: { in: scope.days }, metric: { in: [...scope.metrics] } } });
      let written = 0;
      for (let i = 0; i < rows.length; i += 100) written += (await tx.dailyMetric.createMany({ data: rows.slice(i, i + 100) })).count;
      return written;
    }, { timeout: 60_000 });
  },
  async startRun(job, range) {
    return (await db.rollupRun.create({ data: { job, windowStart: range.start, windowEnd: range.end, status: 'running' }, select: { id: true } })).id;
  },
  async finishRun(id, result) {
    if (!id) return;
    await db.rollupRun.update({ where: { id }, data: { status: result.status, rowsRead: result.rowsRead, rowsWritten: result.rowsWritten, error: result.error ?? null, finishedAt: new Date() } });
  },
};

/** Rebuild the platform activity metrics for a range and the snapshot metrics for `asOf`'s day. Replace semantics; a `RollupRun` per run. */
export async function rollupPlatform(range: DateRange, options: { deps?: PlatformRollupDeps; asOf?: Date } = {}): Promise<RollupResult> {
  const window = snapToUtcDays(range);
  const deps = options.deps ?? prismaPlatformDeps;
  const asOf = options.asOf ?? new Date();
  const days = eachDayKey(window);
  const runId = (await deps.startRun?.(PLATFORM_ROLLUP_JOB, window)) ?? null;
  try {
    const [facts, snapshot] = await Promise.all([deps.loadFacts(window), deps.loadSnapshot(asOf)]);
    const activity = computePlatformActivityRows(facts, window);
    const snapshotRows = computePlatformSnapshotRows(snapshot, dayKey(asOf));
    const written = (await deps.replaceDailyMetrics({ days, metrics: OWNED_ACTIVITY_METRICS }, activity)) + (await deps.replaceDailyMetrics({ days: [dayKey(asOf)], metrics: PLATFORM_SNAPSHOT_METRICS }, snapshotRows));
    const rowsRead = facts.failedPayments.length + facts.aiRuns.length + facts.connectorRuns.length + facts.careerPlans.length + facts.organizationsVerified.length + facts.ssoSignIns.length;
    await deps.finishRun?.(runId, { status: 'succeeded', rowsRead, rowsWritten: written });
    return { job: PLATFORM_ROLLUP_JOB, windowStart: window.start.toISOString(), windowEnd: window.end.toISOString(), days: days.length, rowsRead, rowsWritten: written, status: 'succeeded' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.finishRun?.(runId, { status: 'failed', rowsRead: 0, rowsWritten: 0, error: message });
    throw error;
  }
}

/** The console's read: one metric over a range, zero-filled per day, from the mart. */
export async function readDailyMetric(metric: string, range: DateRange): Promise<{ day: string; valueInt: number; valueCents: number }[]> {
  const days = eachDayKey(normalizeRange(range));
  const rows = await db.dailyMetric.findMany({ where: { metric, dimension: 'all', day: { in: days } }, select: { day: true, valueInt: true, valueCents: true } });
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return days.map((day) => ({ day, valueInt: byDay.get(day)?.valueInt ?? 0, valueCents: byDay.get(day)?.valueCents ?? 0 }));
}

/** The latest snapshot value written for a point-in-time metric (the as-of day of the last run), or null when none was ever written. */
export async function readLatestSnapshot(metric: string): Promise<{ day: string; valueInt: number; valueCents: number } | null> {
  const r = await db.dailyMetric.findFirst({ where: { metric, dimension: 'all' }, orderBy: { day: 'desc' }, select: { day: true, valueInt: true, valueCents: true } });
  return r ?? null;
}
