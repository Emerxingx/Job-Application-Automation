import { dayKey } from '../time';

/**
 * Stage 21 (ADR-0036) - the PURE builders of `OrganizationDailyMart` rows for
 * the three organisation products. Each takes flat facts (what the rollup
 * loaded) and returns deterministic rows keyed by
 * (organizationId, day, product, metric, dimension, key). No database, no
 * dates other than the facts' own, so parity with the live engines can be
 * asserted over the same facts.
 */
export interface MartRow {
  organizationId: string;
  day: string;
  product: 'employer' | 'staffing' | 'cases';
  metric: string;
  dimension: string;
  key: string;
  valueInt: number;
  valueCents: number;
  people: number;
}

class Acc {
  private rows = new Map<string, MartRow>();
  private peopleSets = new Map<string, Set<string>>();
  constructor(private product: MartRow['product']) {}
  add(organizationId: string, day: string, metric: string, opts: { dimension?: string; key?: string; int?: number; cents?: number; person?: string } = {}) {
    const dimension = opts.dimension ?? 'all';
    const key = opts.key ?? 'all';
    const id = [organizationId, day, this.product, metric, dimension, key].join('|');
    const r = this.rows.get(id) ?? { organizationId, day, product: this.product, metric, dimension, key, valueInt: 0, valueCents: 0, people: 0 };
    r.valueInt += opts.int ?? 0;
    r.valueCents += opts.cents ?? 0;
    if (opts.person) {
      const set = this.peopleSets.get(id) ?? new Set<string>();
      set.add(opts.person);
      this.peopleSets.set(id, set);
      r.people = set.size;
    }
    this.rows.set(id, r);
  }
  done(): MartRow[] {
    return [...this.rows.values()].sort((a, b) => a.organizationId.localeCompare(b.organizationId) || a.day.localeCompare(b.day) || a.metric.localeCompare(b.metric) || a.dimension.localeCompare(b.dimension) || a.key.localeCompare(b.key));
  }
}

// --- Employer -----------------------------------------------------------------

export interface SubmissionFact {
  id: string;
  organizationId: string;
  source: string;
  createdAt: Date;
  /** First time the submission entered each stage. */
  firstInto: Record<string, Date>;
}
export interface StageMoveFact {
  organizationId: string;
  actorId: string;
  at: Date;
}
const EMPLOYER_STAGES = ['consented', 'screening', 'interviewing', 'offered', 'hired', 'rejected', 'withdrawn'] as const;

/** Funnel reach and source cuts attributed to the submission's creation day; stage moves attributed to their own day, cut by MEMBER actor (the rollup filters to members). */
export function buildEmployerRows(subs: SubmissionFact[], moves: StageMoveFact[]): MartRow[] {
  const acc = new Acc('employer');
  for (const s of subs) {
    const day = dayKey(s.createdAt);
    acc.add(s.organizationId, day, 'submissions', { int: 1 });
    acc.add(s.organizationId, day, 'submissions', { dimension: 'source', key: s.source, int: 1 });
    for (const stage of EMPLOYER_STAGES) {
      if (s.firstInto[stage]) acc.add(s.organizationId, day, stage, { int: 1 });
    }
    if (s.firstInto.hired) acc.add(s.organizationId, day, 'hired', { dimension: 'source', key: s.source, int: 1 });
    for (const [stage, metric] of [['screening', 'days_to_screening'], ['interviewing', 'days_to_interviewing'], ['hired', 'days_to_hired']] as const) {
      const at = s.firstInto[stage];
      if (at) acc.add(s.organizationId, day, metric, { int: Math.round((at.getTime() - s.createdAt.getTime()) / 86_400_000), person: s.id });
    }
  }
  for (const m of moves) {
    const day = dayKey(m.at);
    acc.add(m.organizationId, day, 'stage_moves', { int: 1 });
    acc.add(m.organizationId, day, 'stage_moves', { dimension: 'recruiter', key: m.actorId, int: 1 });
  }
  return acc.done();
}

// --- Staffing --------------------------------------------------------------------

export interface StaffingFacts {
  engagements: { organizationId: string; createdAt: Date; ownerRecruiterId: string | null }[];
  representations: { organizationId: string; requestedAt: Date; requestedById: string; status: string }[];
  placements: { organizationId: string; createdAt: Date; recruiterId: string | null; feeCents: number; status: string; fellOffAt: Date | null; guaranteeEndsAt: Date }[];
  invoices: { organizationId: string; issuedAt: Date | null; paidAt: Date | null; amountCents: number; creditedCents: number; status: string }[];
}

export function buildStaffingRows(f: StaffingFacts): MartRow[] {
  const acc = new Acc('staffing');
  const both = (organizationId: string, day: string, metric: string, recruiter: string | null, opts: { int?: number; cents?: number }) => {
    acc.add(organizationId, day, metric, opts);
    acc.add(organizationId, day, metric, { dimension: 'recruiter', key: recruiter ?? 'unassigned', ...opts });
  };
  for (const e of f.engagements) both(e.organizationId, dayKey(e.createdAt), 'engagements_opened', e.ownerRecruiterId, { int: 1 });
  for (const r of f.representations) {
    const day = dayKey(r.requestedAt);
    both(r.organizationId, day, 'representations_requested', r.requestedById, { int: 1 });
    if (r.status === 'granted') both(r.organizationId, day, 'representations_granted', r.requestedById, { int: 1 });
  }
  for (const p of f.placements) {
    const day = dayKey(p.createdAt);
    both(p.organizationId, day, 'placements', p.recruiterId, { int: 1 });
    both(p.organizationId, day, 'placement_fee_cents', p.recruiterId, { cents: p.feeCents });
    if (p.status === 'fell_off' && p.fellOffAt && p.fellOffAt <= p.guaranteeEndsAt) both(p.organizationId, day, 'placements_fell_off_in_guarantee', p.recruiterId, { int: 1 });
  }
  for (const i of f.invoices) {
    if (!i.issuedAt) continue;
    const day = dayKey(i.issuedAt);
    acc.add(i.organizationId, day, 'invoices_issued', { int: 1, cents: i.amountCents });
    if (i.paidAt) acc.add(i.organizationId, dayKey(i.paidAt), 'invoices_paid', { int: 1, cents: i.amountCents });
    if (i.creditedCents > 0) acc.add(i.organizationId, day, 'invoices_credited', { int: 1, cents: i.creditedCents });
  }
  return acc.done();
}

// --- Cases -------------------------------------------------------------------------

export interface CaseFacts {
  cases: { organizationId: string; openedAt: Date | null; closedAt: Date | null }[];
  outcomes: { organizationId: string; caseId: string; kind: string; recordedAt: Date }[];
  followUps: { organizationId: string; dueAt: Date; completedAt: Date | null }[];
}

/** No cut but outcome KIND, and every outcome row carries the distinct clients (cases) behind it so the read can suppress under five. */
export function buildCaseRows(f: CaseFacts): MartRow[] {
  const acc = new Acc('cases');
  for (const c of f.cases) {
    if (c.openedAt) acc.add(c.organizationId, dayKey(c.openedAt), 'cases_opened', { int: 1 });
    if (c.closedAt) acc.add(c.organizationId, dayKey(c.closedAt), 'cases_closed', { int: 1 });
  }
  for (const o of f.outcomes) {
    const day = dayKey(o.recordedAt);
    acc.add(o.organizationId, day, 'outcomes', { int: 1, person: o.caseId });
    acc.add(o.organizationId, day, 'outcomes', { dimension: 'kind', key: o.kind, int: 1, person: o.caseId });
  }
  for (const u of f.followUps) {
    const day = dayKey(u.dueAt);
    acc.add(u.organizationId, day, 'follow_ups_due', { int: 1 });
    if (u.completedAt) acc.add(u.organizationId, day, 'follow_ups_completed', { int: 1 });
  }
  return acc.done();
}
