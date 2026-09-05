import { db } from '@/lib/db';
import { eachDayKey, normalizeRange, snapToUtcDays } from '../time';
import type { DateRange, RollupResult } from '../types';
import { buildCaseRows, buildEmployerRows, buildStaffingRows, type MartRow, type SubmissionFact } from './marts';

/**
 * Stage 21 (ADR-0036) - the organisation reporting rollup: the ONLY reader of
 * the employer, staffing and case tables for a metric. Loads the facts for
 * every organisation (or one) over a window on the SYSTEM client, folds them
 * with the pure builders, and REPLACES the (days x organisation x product)
 * scope. Case facts are ids, kinds and dates - never a note, a barrier or a
 * name - and the mart row for an outcome carries the distinct clients behind
 * it so the read can suppress a small cohort (ADR-0012).
 */
export const ORGANIZATION_ROLLUP_JOB = 'organization_reporting';
/** The RollupRun job name of a single-organisation run: it never counts as a rebuild of the mart. */
export const SCOPED_ROLLUP_JOB = 'organization_reporting:scoped';

export interface OrganizationRollupDeps {
  loadEmployer(range: DateRange, organizationId?: string): Promise<{ subs: SubmissionFact[]; moves: { organizationId: string; actorId: string; at: Date }[] }>;
  loadStaffing(range: DateRange, organizationId?: string): Promise<Parameters<typeof buildStaffingRows>[0]>;
  loadCases(range: DateRange, organizationId?: string): Promise<Parameters<typeof buildCaseRows>[0]>;
  replaceRows(scope: { days: string[]; organizationId?: string }, rows: MartRow[]): Promise<number>;
  startRun?(job: string, range: DateRange): Promise<string | null>;
  finishRun?(id: string | null, result: { status: 'succeeded' | 'failed'; rowsRead: number; rowsWritten: number; error?: string }): Promise<void>;
}

export const prismaOrganizationDeps: OrganizationRollupDeps = {
  async loadEmployer(range, organizationId) {
    const w = normalizeRange(range);
    const org = organizationId ? { organizationId } : {};
    const subs = await db.submission.findMany({ where: { ...org, createdAt: { gte: w.start, lt: w.end } }, select: { id: true, organizationId: true, source: true, createdAt: true } });
    const events = subs.length ? await db.submissionEvent.findMany({ where: { submissionId: { in: subs.map((s) => s.id) } }, orderBy: { at: 'asc' }, select: { submissionId: true, toStage: true, at: true } }) : [];
    const firstInto = new Map<string, Record<string, Date>>();
    for (const e of events) {
      const m = firstInto.get(e.submissionId) ?? {};
      if (!m[e.toStage]) m[e.toStage] = e.at;
      firstInto.set(e.submissionId, m);
    }
    // Stage moves on the day, by MEMBERS only: candidate-driven events carry the candidate as actor and must not count as recruiter activity.
    const moveRows = await db.submissionEvent.findMany({ where: { ...org, at: { gte: w.start, lt: w.end } }, select: { organizationId: true, actorId: true, at: true } });
    const orgIds = [...new Set(moveRows.map((m) => m.organizationId))];
    const members = orgIds.length ? await db.membership.findMany({ where: { organizationId: { in: orgIds }, acceptedAt: { not: null }, removedAt: null }, select: { organizationId: true, userId: true } }) : [];
    const memberSet = new Set(members.map((m) => `${m.organizationId}|${m.userId}`));
    return { subs: subs.map((s) => ({ ...s, firstInto: firstInto.get(s.id) ?? {} })), moves: moveRows.filter((m) => memberSet.has(`${m.organizationId}|${m.actorId}`)) };
  },
  async loadStaffing(range, organizationId) {
    const w = normalizeRange(range);
    const org = organizationId ? { organizationId } : {};
    const bounds = { gte: w.start, lt: w.end };
    const [engagements, representations, placements, invoices] = await Promise.all([
      db.engagement.findMany({ where: { ...org, createdAt: bounds }, select: { organizationId: true, createdAt: true, ownerRecruiterId: true } }),
      db.representationConsent.findMany({ where: { ...org, requestedAt: bounds }, select: { organizationId: true, requestedAt: true, requestedById: true, status: true } }),
      db.placement.findMany({ where: { ...org, createdAt: bounds }, select: { organizationId: true, createdAt: true, recruiterId: true, feeCents: true, status: true, fellOffAt: true, guaranteeEndsAt: true } }),
      db.placementInvoice.findMany({ where: { ...org, OR: [{ issuedAt: bounds }, { paidAt: bounds }] }, select: { organizationId: true, issuedAt: true, paidAt: true, amountCents: true, creditedCents: true, status: true } }),
    ]);
    return { engagements, representations, placements, invoices };
  },
  async loadCases(range, organizationId) {
    const w = normalizeRange(range);
    const org = organizationId ? { organizationId } : {};
    const bounds = { gte: w.start, lt: w.end };
    const [cases, outcomes, followUps] = await Promise.all([
      db.case.findMany({ where: { ...org, OR: [{ openedAt: bounds }, { closedAt: bounds }] }, select: { organizationId: true, openedAt: true, closedAt: true } }),
      db.caseOutcome.findMany({ where: { ...org, recordedAt: bounds }, select: { organizationId: true, caseId: true, kind: true, recordedAt: true } }),
      db.caseFollowUp.findMany({ where: { ...org, dueAt: bounds }, select: { organizationId: true, dueAt: true, completedAt: true } }),
    ]);
    return { cases, outcomes, followUps };
  },
  async replaceRows(scope, rows) {
    if (scope.days.length === 0) return 0;
    // Review M9: a whole-platform replace outgrows Prisma's 5 s default; the Stage 13 rollup sets the same ceiling.
    return db.$transaction(async (tx) => {
      await tx.organizationDailyMart.deleteMany({ where: { day: { in: scope.days }, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) } });
      let written = 0;
      for (let i = 0; i < rows.length; i += 100) written += (await tx.organizationDailyMart.createMany({ data: rows.slice(i, i + 100) })).count;
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

export async function rollupOrganizations(range: DateRange, options: { deps?: OrganizationRollupDeps; organizationId?: string } = {}): Promise<RollupResult & { organizations: number }> {
  const window = snapToUtcDays(range);
  const deps = options.deps ?? prismaOrganizationDeps;
  const days = eachDayKey(window);
  const daySet = new Set(days);
  // A run scoped to ONE organisation is recorded under its own job name so the
  // freshness line (the latest success of `organization_reporting`) counts
  // full sweeps only (review L11).
  const runId = (await deps.startRun?.(options.organizationId ? SCOPED_ROLLUP_JOB : ORGANIZATION_ROLLUP_JOB, window)) ?? null;
  try {
    const [employer, staffing, cases] = await Promise.all([deps.loadEmployer(window, options.organizationId), deps.loadStaffing(window, options.organizationId), deps.loadCases(window, options.organizationId)]);
    // A fact outside the window (a stage reached later than the creation day
    // is still attributed to the creation day, which IS in the window) never
    // lands on a day outside the scope: every builder attributes to a fact
    // date the loader bounded.
    const rows = [...buildEmployerRows(employer.subs, employer.moves), ...buildStaffingRows(staffing), ...buildCaseRows(cases)].filter((r) => daySet.has(r.day));
    const written = await deps.replaceRows({ days, organizationId: options.organizationId }, rows);
    const rowsRead = employer.subs.length + employer.moves.length + staffing.engagements.length + staffing.representations.length + staffing.placements.length + staffing.invoices.length + cases.cases.length + cases.outcomes.length + cases.followUps.length;
    await deps.finishRun?.(runId, { status: 'succeeded', rowsRead, rowsWritten: written });
    return { job: ORGANIZATION_ROLLUP_JOB, windowStart: window.start.toISOString(), windowEnd: window.end.toISOString(), days: days.length, rowsRead, rowsWritten: written, status: 'succeeded', organizations: new Set(rows.map((r) => r.organizationId)).size };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.finishRun?.(runId, { status: 'failed', rowsRead: 0, rowsWritten: 0, error: message });
    throw error;
  }
}
