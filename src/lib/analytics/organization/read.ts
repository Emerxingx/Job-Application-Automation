import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { dayKey } from '../time';
import { MIN_ORG_COHORT } from '../platform/dictionary';

/**
 * Stage 21 (ADR-0036) - the reads of `OrganizationDailyMart`, on the TENANT
 * path (the organisation's members, inside `run()`), shaped for the three
 * product pages. Every number here is a mart row; nothing reads a
 * submission, a placement or a case. The services keep their role gates and
 * call these.
 */
type Client = Prisma.TransactionClient | typeof db;

interface Row {
  day: string;
  metric: string;
  dimension: string;
  key: string;
  valueInt: number;
  valueCents: number;
  people: number;
}

async function rows(tx: Client, organizationId: string, product: 'employer' | 'staffing' | 'cases', range: { from: Date; to: Date }): Promise<Row[]> {
  return tx.organizationDailyMart.findMany({ where: { organizationId, product, day: { gte: dayKey(range.from), lte: dayKey(range.to) } }, select: { day: true, metric: true, dimension: true, key: true, valueInt: true, valueCents: true, people: true } });
}

const sum = (rs: Row[], metric: string, dimension = 'all', key = 'all') => rs.filter((r) => r.metric === metric && r.dimension === dimension && r.key === key).reduce((n, r) => n + r.valueInt, 0);
const sumCents = (rs: Row[], metric: string, dimension = 'all', key = 'all') => rs.filter((r) => r.metric === metric && r.dimension === dimension && r.key === key).reduce((n, r) => n + r.valueCents, 0);
const sumPeople = (rs: Row[], metric: string, dimension = 'all', key = 'all') => rs.filter((r) => r.metric === metric && r.dimension === dimension && r.key === key).reduce((n, r) => n + r.people, 0);
const keysOf = (rs: Row[], metric: string, dimension: string) => [...new Set(rs.filter((r) => r.metric === metric && r.dimension === dimension).map((r) => r.key))].sort();

export interface EmployerReport {
  range: { from: Date; to: Date };
  funnel: { submissions: number; consented: number; screening: number; interviewing: number; offered: number; hired: number; rejected: number; withdrawn: number };
  /** MEAN whole days from creation to the first time the stage was reached, over submissions created in the range; null when none reached it. */
  daysTo: { shortlist: number | null; interview: number | null; hire: number | null };
  sources: Record<string, { submissions: number; hires: number }>;
  recruiterActivity: { actorId: string; moves: number }[];
}

export async function readEmployerReport(tx: Client, organizationId: string, range: { from: Date; to: Date }): Promise<EmployerReport> {
  const rs = await rows(tx, organizationId, 'employer', range);
  const mean = (metric: string) => {
    const n = sumPeople(rs, metric);
    return n === 0 ? null : Math.round((sum(rs, metric) / n) * 10) / 10;
  };
  const sources: EmployerReport['sources'] = {};
  for (const k of keysOf(rs, 'submissions', 'source')) sources[k] = { submissions: sum(rs, 'submissions', 'source', k), hires: sum(rs, 'hired', 'source', k) };
  return {
    range,
    funnel: { submissions: sum(rs, 'submissions'), consented: sum(rs, 'consented'), screening: sum(rs, 'screening'), interviewing: sum(rs, 'interviewing'), offered: sum(rs, 'offered'), hired: sum(rs, 'hired'), rejected: sum(rs, 'rejected'), withdrawn: sum(rs, 'withdrawn') },
    daysTo: { shortlist: mean('days_to_screening'), interview: mean('days_to_interviewing'), hire: mean('days_to_hired') },
    sources,
    recruiterActivity: keysOf(rs, 'stage_moves', 'recruiter').map((actorId) => ({ actorId, moves: sum(rs, 'stage_moves', 'recruiter', actorId) })).sort((a, b) => b.moves - a.moves || a.actorId.localeCompare(b.actorId)),
  };
}

export interface RecruiterRow {
  recruiterId: string;
  engagements: number;
  requested: number;
  granted: number;
  placements: number;
  fellOffInGuarantee: number;
  /** Null when the caller may not read fees. */
  feeCents: number | null;
}

export async function readStaffingProductivity(tx: Client, organizationId: string, range: { from: Date; to: Date }, opts: { fees: boolean; onlyRecruiterId?: string }): Promise<RecruiterRow[]> {
  const rs = await rows(tx, organizationId, 'staffing', range);
  const ids = new Set<string>();
  for (const m of ['engagements_opened', 'representations_requested', 'placements']) for (const k of keysOf(rs, m, 'recruiter')) ids.add(k);
  const all = [...ids].map((recruiterId) => ({
    recruiterId,
    engagements: sum(rs, 'engagements_opened', 'recruiter', recruiterId),
    requested: sum(rs, 'representations_requested', 'recruiter', recruiterId),
    granted: sum(rs, 'representations_granted', 'recruiter', recruiterId),
    placements: sum(rs, 'placements', 'recruiter', recruiterId),
    fellOffInGuarantee: sum(rs, 'placements_fell_off_in_guarantee', 'recruiter', recruiterId),
    feeCents: opts.fees ? sumCents(rs, 'placement_fee_cents', 'recruiter', recruiterId) : null,
  }));
  const sorted = all.sort((a, b) => b.placements - a.placements || a.recruiterId.localeCompare(b.recruiterId));
  return opts.onlyRecruiterId ? sorted.filter((r) => r.recruiterId === opts.onlyRecruiterId) : sorted;
}

export interface StaffingInvoiceSummary {
  issued: { count: number; cents: number };
  paid: { count: number; cents: number };
  credited: { count: number; cents: number };
}

export async function readStaffingInvoices(tx: Client, organizationId: string, range: { from: Date; to: Date }): Promise<StaffingInvoiceSummary> {
  const rs = await rows(tx, organizationId, 'staffing', range);
  return { issued: { count: sum(rs, 'invoices_issued'), cents: sumCents(rs, 'invoices_issued') }, paid: { count: sum(rs, 'invoices_paid'), cents: sumCents(rs, 'invoices_paid') }, credited: { count: sum(rs, 'invoices_credited'), cents: sumCents(rs, 'invoices_credited') } };
}

export type Suppressed = { suppressed: false; value: number } | { suppressed: true; reason: string };

export interface CaseloadSummary {
  opened: number;
  closed: number;
  followUps: { due: number; completed: number };
  /** Outcomes in total and by kind, each suppressed when fewer than five distinct clients are behind it. */
  outcomes: Suppressed;
  outcomesByKind: { kind: string; count: Suppressed }[];
}

const suppress = (count: number, people: number): Suppressed => (people > 0 && people < MIN_ORG_COHORT ? { suppressed: true, reason: `Fewer than ${MIN_ORG_COHORT} clients; not shown.` } : { suppressed: false, value: count });

/** The supervisor's employment-outcome summary: counts only, and an outcome figure is withheld under five clients (ADR-0012; a caseload cut by anything could re-identify a client). */
export async function readCaseloadSummary(tx: Client, organizationId: string, range: { from: Date; to: Date }): Promise<CaseloadSummary> {
  const rs = await rows(tx, organizationId, 'cases', range);
  return {
    opened: sum(rs, 'cases_opened'),
    closed: sum(rs, 'cases_closed'),
    followUps: { due: sum(rs, 'follow_ups_due'), completed: sum(rs, 'follow_ups_completed') },
    outcomes: suppress(sum(rs, 'outcomes'), sumPeople(rs, 'outcomes')),
    outcomesByKind: keysOf(rs, 'outcomes', 'kind').map((kind) => ({ kind, count: suppress(sum(rs, 'outcomes', 'kind', kind), sumPeople(rs, 'outcomes', 'kind', kind)) })),
  };
}
