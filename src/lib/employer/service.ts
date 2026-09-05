/**
 * Stage 18 (ADR-0033) - employer-side hiring: requisitions published as
 * first-party postings, disclosures (the candidate's consent to be shown to
 * ONE employer), the pipeline with its stage machine, talent pools,
 * interviews, notes, offers and hires.
 *
 * The rule the whole module bends around: NO candidate is disclosed to an
 * employer without a granted Disclosure. A submission cannot enter a stage
 * that shows the candidate (stage-machine.ts DISCLOSED_STAGES) without one;
 * the identity and the profile reach the employer only through
 * candidate-view.ts, behind the same check and an audit row; a candidate
 * whose recruiter visibility is `hidden` cannot even be asked. Sensitive
 * attributes are never read (ADR-0007; a static test holds this module to
 * it). Every write is the organisation's, on the tenant path in its
 * context; the candidate answers on the system client, as with cases.
 */
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { grantConsent } from '@/lib/consent';
import { ensureSourceRegistry, requireEnabledSource } from '@/lib/connectors/registry';
import { upsertPosting } from '@/lib/connectors/pipeline';
import { EMPLOYER_SOURCE_KEY, requisitionToPosting } from '@/lib/connectors/employer';
import { recordSecurityEvent, type RequestMeta, type SecurityEvent } from '@/lib/security-audit';
import { findActiveMembership } from '@/lib/tenancy/organizations';
import { canCreateRequisition, canDecideOffer, canMovePipeline, canReadReporting, canReadSourcing, canSource, canWriteInterview, canWriteRequisition, employerRoleOf, isEmployerRole, type EmployerRole, type EmployerServiceRole } from './roles';
import { canTransition, isSubmissionStage, requiresDisclosure, type SubmissionStage } from './stage-machine';

type Client = Prisma.TransactionClient | typeof db;

export class EmployerError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'EmployerError';
    this.status = status;
  }
}

export interface EmployerActor {
  user: { id: string; email: string };
  organizationId: string;
  role: EmployerRole;
  meta?: RequestMeta;
  /**
   * When present, audit rows are BUFFERED here and written by
   * `flushEmployerAudit` after the tenant transaction commits (the Stage 10
   * pattern): a row for a move the transaction then rolled back would be a
   * lie, and a strict write that fails must not undo a committed move. A
   * caller without a buffer (a test, a script) gets the strict immediate
   * write.
   */
  pending?: PendingAudit[];
}

export interface PendingAudit {
  event: SecurityEvent;
  entityType: string;
  entityId: string;
  summary: string;
  detail: Record<string, string | number | boolean | null>;
}

/** An actor whose audit rows wait for the commit. Routes build one; `flushEmployerAudit` empties it. */
export function bufferedActor(actor: EmployerActor): EmployerActor {
  return { ...actor, pending: [] };
}

export async function flushEmployerAudit(actor: EmployerActor): Promise<void> {
  if (!actor.pending) return;
  const entries = actor.pending.splice(0, actor.pending.length);
  for (const e of entries) {
    await recordSecurityEvent(
      { event: e.event, actor: { type: 'user', id: actor.user.id, email: actor.user.email, role: `employer:${actor.role}` }, entityType: e.entityType, entityId: e.entityId, summary: e.summary, detail: { organizationId: actor.organizationId, ...e.detail }, meta: actor.meta },
      db,
      { strict: true },
    );
  }
}

export const REQUISITION_STATUSES = ['draft', 'open', 'on_hold', 'filled', 'closed'] as const;
export const OFFER_STATUSES = ['draft', 'extended', 'accepted', 'declined', 'withdrawn'] as const;
export const INTERVIEW_OUTCOMES = ['scheduled', 'completed', 'cancelled'] as const;

export async function requireEmployerActor(user: { id: string; email: string }, organizationId: string, meta?: RequestMeta): Promise<EmployerActor> {
  const membership = await findActiveMembership(db, organizationId, user.id);
  if (!membership) throw new EmployerError('Organization not found.', 404);
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { type: true } });
  if (!org || org.type !== 'employer') throw new EmployerError('Organization not found.', 404);
  return { user, organizationId, role: employerRoleOf(membership), meta };
}

export async function employerMemberships(userId: string) {
  const rows = await db.membership.findMany({ where: { userId, acceptedAt: { not: null }, removedAt: null, organization: { type: 'employer' } }, include: { organization: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } });
  return rows.map((m) => ({ organizationId: m.organization.id, name: m.organization.name, role: employerRoleOf(m) }));
}

async function audit(event: SecurityEvent, actor: EmployerActor, entityType: string, entityId: string, summary: string, detail: Record<string, string | number | boolean | null> = {}): Promise<void> {
  if (actor.pending) {
    actor.pending.push({ event, entityType, entityId, summary, detail });
    return;
  }
  await recordSecurityEvent(
    { event, actor: { type: 'user', id: actor.user.id, email: actor.user.email, role: `employer:${actor.role}` }, entityType, entityId, summary, detail: { organizationId: actor.organizationId, ...detail }, meta: actor.meta },
    db,
    { strict: true },
  );
}

export async function setEmployerRole(actor: EmployerActor, memberUserId: string, serviceRole: EmployerServiceRole | null): Promise<void> {
  if (actor.role !== 'admin') throw new EmployerError('Only an administrator sets roles.', 403);
  if (serviceRole !== null && !isEmployerRole(serviceRole)) throw new EmployerError('Unknown role.', 422);
  const m = await findActiveMembership(db, actor.organizationId, memberUserId);
  if (!m) throw new EmployerError('No such member.', 404);
  await db.membership.update({ where: { id: m.id }, data: { serviceRole } });
}

// --- Requisitions ------------------------------------------------------------

export interface RequisitionInput {
  title: string;
  department?: string;
  location: string;
  country?: 'CA' | 'US';
  workMode?: 'onsite' | 'hybrid' | 'remote';
  jobType?: 'full_time' | 'part_time' | 'contract' | 'internship';
  description?: string;
  requiredSkills?: string[];
  preferredSkills?: string[];
  certificationRequirements?: string[];
  experienceYearsMin?: number | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string;
  hiringManagerId?: string | null;
  recruiterId?: string | null;
}

async function ownedRequisition(tx: Client, actor: EmployerActor, id: string) {
  const r = await tx.requisition.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!r) throw new EmployerError('Requisition not found.', 404);
  return r;
}

function requisitionData(input: RequisitionInput) {
  const clean = (xs?: string[]) => JSON.stringify((xs ?? []).map((s) => s.trim()).filter(Boolean));
  return {
    title: input.title.trim(),
    department: input.department?.trim() ?? '',
    location: input.location.trim(),
    country: input.country ?? 'CA',
    workMode: input.workMode ?? 'onsite',
    jobType: input.jobType ?? 'full_time',
    description: input.description?.trim() ?? '',
    requiredSkills: clean(input.requiredSkills),
    preferredSkills: clean(input.preferredSkills),
    certificationRequirements: clean(input.certificationRequirements),
    experienceYearsMin: input.experienceYearsMin ?? null,
    salaryMin: input.salaryMin ?? null,
    salaryMax: input.salaryMax ?? null,
    salaryCurrency: input.salaryCurrency ?? 'CAD',
  };
}

async function assertMember(client: Client, organizationId: string, userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  const m = await findActiveMembership(client, organizationId, userId);
  if (!m) throw new EmployerError('That person is not a member of the organisation.', 422);
}

export async function createRequisition(tx: Client, actor: EmployerActor, input: RequisitionInput) {
  if (!canCreateRequisition(actor.role)) throw new EmployerError('Only a recruiter, a hiring manager or an administrator creates a requisition.', 403);
  if (input.salaryMin !== null && input.salaryMin !== undefined && input.salaryMax !== null && input.salaryMax !== undefined && input.salaryMin > input.salaryMax) throw new EmployerError('The salary range is inverted.', 422);
  await assertMember(tx, actor.organizationId, input.hiringManagerId);
  await assertMember(tx, actor.organizationId, input.recruiterId);
  const hiringManagerId = actor.role === 'hiring_manager' ? actor.user.id : (input.hiringManagerId ?? null);
  return tx.requisition.create({ data: { organizationId: actor.organizationId, ...requisitionData(input), hiringManagerId, recruiterId: input.recruiterId ?? (actor.role === 'recruiter' ? actor.user.id : null), createdById: actor.user.id } });
}

export async function updateRequisition(tx: Client, actor: EmployerActor, id: string, input: Partial<RequisitionInput>) {
  const r = await ownedRequisition(tx, actor, id);
  if (!canWriteRequisition(actor.role, r, actor.user.id)) throw new EmployerError('You may not change this requisition.', 403);
  if (r.status === 'filled' || r.status === 'closed') throw new EmployerError('A filled or closed requisition is not edited; open a new one.', 409);
  await assertMember(tx, actor.organizationId, input.hiringManagerId);
  await assertMember(tx, actor.organizationId, input.recruiterId);
  const merged: RequisitionInput = { title: input.title ?? r.title, location: input.location ?? r.location, department: input.department ?? r.department, country: (input.country ?? r.country) as 'CA' | 'US', workMode: (input.workMode ?? r.workMode) as RequisitionInput['workMode'], jobType: (input.jobType ?? r.jobType) as RequisitionInput['jobType'], description: input.description ?? r.description, requiredSkills: input.requiredSkills ?? (JSON.parse(r.requiredSkills) as string[]), preferredSkills: input.preferredSkills ?? (JSON.parse(r.preferredSkills) as string[]), certificationRequirements: input.certificationRequirements ?? (JSON.parse(r.certificationRequirements) as string[]), experienceYearsMin: input.experienceYearsMin === undefined ? r.experienceYearsMin : input.experienceYearsMin, salaryMin: input.salaryMin === undefined ? r.salaryMin : input.salaryMin, salaryMax: input.salaryMax === undefined ? r.salaryMax : input.salaryMax, salaryCurrency: input.salaryCurrency ?? r.salaryCurrency };
  if (merged.salaryMin != null && merged.salaryMax != null && merged.salaryMin > merged.salaryMax) throw new EmployerError('The salary range is inverted.', 422);
  // The WRITE is on the system client, deliberately: publication runs the
  // Stage 06 pipeline, which is system-only and reads the requisition on its
  // own connection - a row updated inside the tenant transaction would be
  // invisible to it (or, worse, lock it until the transaction times out).
  // The read and every check above ran on the tenant path; the write is
  // filtered by the organisation id the actor was resolved for.
  const updated = await db.requisition.update({ where: { id: r.id, organizationId: actor.organizationId }, data: { ...requisitionData(merged), ...(input.hiringManagerId !== undefined ? { hiringManagerId: input.hiringManagerId } : {}), ...(input.recruiterId !== undefined ? { recruiterId: input.recruiterId } : {}) } });
  if (updated.status === 'open') await publishRequisition(updated.id);
  return updated;
}

/**
 * Publish (or re-publish) an open requisition as a first-party posting
 * through the Stage 05 gate and the Stage 06 pipeline: the same canonical
 * `Job` every candidate's agent matches. System client: the pipeline is.
 */
export async function publishRequisition(requisitionId: string): Promise<{ jobId: string }> {
  const row = await db.requisition.findUniqueOrThrow({ where: { id: requisitionId }, include: { organization: { select: { name: true } } } });
  // The first-party register row is seeded idempotently (the console and the
  // freshness script do the same); the GATE still decides - a staff member
  // who disabled the employer source stops every publication.
  await ensureSourceRegistry();
  const { source, connector } = await requireEnabledSource(EMPLOYER_SOURCE_KEY);
  const posting = connector.normalize(requisitionToPosting(row));
  const v = connector.validate(posting);
  if (!v.ok) throw new EmployerError(`The requisition cannot be published: ${v.reasons.join(', ')}.`, 422);
  const result = await upsertPosting(source, posting);
  if (row.jobId !== result.id) await db.requisition.update({ where: { id: row.id }, data: { jobId: result.id } });
  return { jobId: result.id };
}

/** draft -> open publishes; open -> on_hold | filled | closed; closure is stated on the Job by this row (the source) at once, not inferred later. */
export async function setRequisitionStatus(tx: Client, actor: EmployerActor, id: string, status: (typeof REQUISITION_STATUSES)[number]) {
  const r = await ownedRequisition(tx, actor, id);
  if (!canWriteRequisition(actor.role, r, actor.user.id)) throw new EmployerError('You may not change this requisition.', 403);
  const allowed: Record<string, string[]> = { draft: ['open', 'closed'], open: ['on_hold', 'filled', 'closed'], on_hold: ['open', 'closed'], filled: [], closed: [] };
  if (!allowed[r.status]?.includes(status)) throw new EmployerError(`A ${r.status} requisition cannot become ${status}.`, 409);
  // Publish FIRST, on the system client (see updateRequisition for why the
  // pipeline cannot run inside the tenant transaction): if the connector
  // gate refuses, the requisition stays a draft and nothing was published.
  // A posting that exists for a requisition whose status write then fails is
  // re-published idempotently (same source, same external id) on the next
  // attempt, never duplicated.
  if (status === 'open') await publishRequisition(r.id);
  // The status write is on the tenant path with the status it was read at as
  // a precondition: two concurrent moves cannot both win (Stage 18 review).
  const moved = await tx.requisition.updateMany({ where: { id: r.id, organizationId: actor.organizationId, status: r.status }, data: { status, openedAt: status === 'open' ? (r.openedAt ?? new Date()) : r.openedAt, closedAt: status === 'filled' || status === 'closed' ? new Date() : null } });
  if (moved.count === 0) throw new EmployerError('The requisition changed underneath you; reload and try again.', 409);
  const updated = await tx.requisition.findFirstOrThrow({ where: { id: r.id } });
  if (status !== 'open' && updated.jobId) {
    // Closure is stated by THIS source. A job whose primary source is another
    // one (the pipeline merged the requisition into an existing capture by
    // hash) is not closed here: that source may still list it, and Stage 06
    // closes a job only when no source does (freshness decides).
    const job = await db.job.findUnique({ where: { id: updated.jobId }, select: { source: true, externalId: true } });
    if (job && job.source === EMPLOYER_SOURCE_KEY && job.externalId === r.id) await db.job.update({ where: { id: updated.jobId }, data: { activeState: status === 'on_hold' ? 'unknown' : 'closed', closedAt: status === 'on_hold' ? null : new Date() } });
  }
  return updated;
}

export async function listRequisitions(tx: Client, actor: EmployerActor) {
  return tx.requisition.findMany({ where: { organizationId: actor.organizationId }, orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }], include: { _count: { select: { submissions: true } } } });
}

// --- Disclosures: the candidate's consent -------------------------------------

/** Whether a candidate may be approached at all: their Stage 02 recruiter-visibility preference. `hidden` cannot be asked. */
async function sourceable(candidateUserId: string): Promise<{ visibility: 'anonymous' | 'visible' } | null> {
  const [user, prefs] = await Promise.all([db.user.findUnique({ where: { id: candidateUserId }, select: { anonymizedAt: true, onboardedAt: true } }), db.careerPreferences.findUnique({ where: { userId: candidateUserId }, select: { recruiterVisibility: true } })]);
  if (!user || user.anonymizedAt) return null;
  const v = prefs?.recruiterVisibility;
  return v === 'anonymous' || v === 'visible' ? { visibility: v } : null;
}

/** Ask a candidate for disclosure, optionally for one requisition (a submission at `consent_requested`). Refused for a hidden candidate, and never says why beyond that. */
export async function requestDisclosure(actor: EmployerActor, input: { candidateUserId: string; requisitionId?: string | null; message?: string }) {
  if (!canSource(actor.role)) throw new EmployerError('Only a recruiter or an administrator asks a candidate for disclosure.', 403);
  const s = await sourceable(input.candidateUserId);
  if (!s) throw new EmployerError('This candidate is not open to recruiters.', 404);
  if (input.requisitionId) await ownedRequisition(db, actor, input.requisitionId);
  const existing = await db.disclosure.findUnique({ where: { organizationId_candidateUserId: { organizationId: actor.organizationId, candidateUserId: input.candidateUserId } } });
  if (existing && existing.status === 'granted') throw new EmployerError('This candidate has already granted disclosure to your organisation.', 409);
  if (existing && existing.status === 'requested') throw new EmployerError('A request is already waiting for this candidate.', 409);
  // The candidate said no: the platform does not let the same employer ask
  // again (the Stage 17 rule for a declined invitation). The candidate can
  // still apply to that employer's posting themselves, which grants anew.
  if (existing && existing.status === 'declined') throw new EmployerError('This candidate declined a disclosure request from your organisation; the platform does not ask again.', 409);
  const message = (input.message ?? '').trim().slice(0, 500);
  const disclosure = existing
    ? await db.disclosure.update({ where: { id: existing.id }, data: { status: 'requested', requisitionId: input.requisitionId ?? null, message, requestedById: actor.user.id, requestedAt: new Date(), respondedAt: null, consentRecordId: null } })
    : await db.disclosure.create({ data: { organizationId: actor.organizationId, candidateUserId: input.candidateUserId, requisitionId: input.requisitionId ?? null, message, requestedById: actor.user.id } });
  if (input.requisitionId) {
    // A submission that exists is moved ONLY from `sourced` (the stage
    // machine's own edge); a terminal or later row keeps its stage and just
    // learns which disclosure it now waits on (Stage 18 review, H2).
    const existingSubmission = await db.submission.findUnique({ where: { requisitionId_candidateUserId: { requisitionId: input.requisitionId, candidateUserId: input.candidateUserId } } });
    if (!existingSubmission) {
      await db.submission.create({ data: { organizationId: actor.organizationId, requisitionId: input.requisitionId, candidateUserId: input.candidateUserId, disclosureId: disclosure.id, stage: 'consent_requested', source: 'sourced', createdById: actor.user.id, events: { create: { organizationId: actor.organizationId, fromStage: 'sourced', toStage: 'consent_requested', actorId: actor.user.id } } } });
    } else if (existingSubmission.stage === 'sourced') {
      await db.submission.update({ where: { id: existingSubmission.id }, data: { disclosureId: disclosure.id, stage: 'consent_requested', events: { create: { organizationId: actor.organizationId, fromStage: 'sourced', toStage: 'consent_requested', actorId: actor.user.id } } } });
    } else {
      await db.submission.update({ where: { id: existingSubmission.id }, data: { disclosureId: disclosure.id } });
    }
  }
  await audit('disclosure.requested', actor, 'Disclosure', disclosure.id, 'Disclosure requested from a candidate', { candidateUserId: input.candidateUserId, requisitionId: input.requisitionId ?? null, visibility: s.visibility });
  return disclosure;
}

/** The candidate's own view: requests and grants, with the organisation's name (system client, as with cases). */
export async function listCandidateDisclosures(tx: Client, candidateUserId: string) {
  const rows = await tx.disclosure.findMany({ where: { candidateUserId }, orderBy: { requestedAt: 'desc' } });
  const orgs = rows.length ? await db.organization.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.organizationId))] } }, select: { id: true, name: true } }) : [];
  const reqIds = rows.map((r) => r.requisitionId).filter((x): x is string => Boolean(x));
  const reqs = reqIds.length ? await db.requisition.findMany({ where: { id: { in: reqIds } }, select: { id: true, title: true } }) : [];
  return rows.map((r) => ({ ...r, organization: { name: orgs.find((o) => o.id === r.organizationId)?.name ?? 'An employer' }, requisitionTitle: reqs.find((q) => q.id === r.requisitionId)?.title ?? null }));
}

/**
 * The candidate answers a request. Granting writes a `ConsentRecord`
 * (`employer_disclosure`, one per grant) and moves every waiting submission
 * of that employer to `consented`; declining moves them to `withdrawn`.
 */
export async function respondToDisclosure(candidate: { id: string; email: string }, disclosureId: string, grant: boolean, meta?: RequestMeta) {
  const d = await db.disclosure.findFirst({ where: { id: disclosureId, candidateUserId: candidate.id } });
  if (!d) throw new EmployerError('Request not found.', 404);
  if (d.status !== 'requested') throw new EmployerError('This request has already been answered.', 409);
  if (!grant) {
    await db.$transaction(async (tx) => {
      await tx.disclosure.update({ where: { id: d.id }, data: { status: 'declined', respondedAt: new Date() } });
      await moveAllForCandidate(tx, d.organizationId, candidate.id, ['consent_requested', 'sourced'], 'withdrawn', candidate.id, 'declined disclosure');
    });
    await recordSecurityEvent({ event: 'disclosure.declined', user: candidate, entityType: 'Disclosure', entityId: d.id, summary: 'Candidate declined disclosure', detail: { organizationId: d.organizationId }, meta }, db, { strict: true });
    return { status: 'declined' as const };
  }
  // One transaction: a grant is never recorded without its consent record, nor
  // the reverse; the status it was read at is the precondition, so two
  // concurrent grants cannot write two consent records. Every waiting row of
  // this employer - asked (`consent_requested`) or merely added (`sourced`) -
  // becomes `consented`: the candidate's grant is to the employer, not to one
  // requisition.
  const consent = await db.$transaction(async (tx) => {
    const c = await grantConsent(tx, candidate, 'employer_disclosure', { source: 'settings', meta });
    const won = await tx.disclosure.updateMany({ where: { id: d.id, status: 'requested' }, data: { status: 'granted', respondedAt: new Date(), consentRecordId: c.id } });
    if (won.count === 0) throw new EmployerError('This request has already been answered.', 409);
    await tx.submission.updateMany({ where: { organizationId: d.organizationId, candidateUserId: candidate.id, disclosureId: null }, data: { disclosureId: d.id } });
    await moveAllForCandidate(tx, d.organizationId, candidate.id, ['consent_requested', 'sourced'], 'consented', candidate.id, 'granted disclosure');
    return c;
  });
  await recordSecurityEvent({ event: 'disclosure.granted', user: candidate, entityType: 'Disclosure', entityId: d.id, summary: 'Candidate granted disclosure to an employer', detail: { organizationId: d.organizationId, consentRecordId: consent.id }, meta }, db, { strict: true });
  return { status: 'granted' as const };
}

/** The candidate takes it back: the consent record is revoked, disclosed submissions are withdrawn, pool memberships go. */
export async function revokeDisclosure(candidate: { id: string; email: string }, disclosureId: string, meta?: RequestMeta) {
  const d = await db.disclosure.findFirst({ where: { id: disclosureId, candidateUserId: candidate.id } });
  if (!d) throw new EmployerError('Request not found.', 404);
  if (d.status !== 'granted') throw new EmployerError('This disclosure is not granted.', 409);
  await db.$transaction(async (tx) => {
    await tx.disclosure.update({ where: { id: d.id }, data: { status: 'revoked', respondedAt: new Date() } });
    if (d.consentRecordId) await tx.consentRecord.updateMany({ where: { id: d.consentRecordId, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.talentPoolMember.deleteMany({ where: { disclosureId: d.id } });
    await moveAllForCandidate(tx, d.organizationId, candidate.id, ['consented', 'screening', 'interviewing', 'offered'], 'withdrawn', candidate.id, 'revoked disclosure');
  });
  await recordSecurityEvent({ event: 'disclosure.revoked', user: candidate, entityType: 'Disclosure', entityId: d.id, summary: 'Candidate revoked disclosure', detail: { organizationId: d.organizationId }, meta }, db, { strict: true });
}

async function moveAllForCandidate(tx: Prisma.TransactionClient, organizationId: string, candidateUserId: string, from: SubmissionStage[], to: SubmissionStage, actorId: string, note: string): Promise<void> {
  const rows = await tx.submission.findMany({ where: { organizationId, candidateUserId, stage: { in: from } } });
  for (const s of rows) {
    await tx.submission.update({ where: { id: s.id }, data: { stage: to, events: { create: { organizationId, fromStage: s.stage, toStage: to, actorId, note } } } });
  }
}

/** A GRANTED disclosure with a current consent, or null. The one question every employer-visible read asks. */
export async function grantedDisclosure(client: Client, organizationId: string, candidateUserId: string) {
  const d = await client.disclosure.findUnique({ where: { organizationId_candidateUserId: { organizationId, candidateUserId } } });
  if (!d || d.status !== 'granted' || !d.consentRecordId) return null;
  // System client by necessity: `ConsentRecord` is the candidate's row, which
  // the employer's tenant context cannot see. The record must be THIS
  // candidate's, for THIS purpose, and unrevoked - a row pointing at any other
  // consent id (a member's own terms consent, say) grants nothing.
  const consent = await db.consentRecord.findFirst({ where: { id: d.consentRecordId, userId: candidateUserId, purpose: 'employer_disclosure', revokedAt: null }, select: { id: true } });
  return consent ? d : null;
}

/**
 * The candidate applies to an employer's posting on this platform: their
 * own act grants disclosure to that employer (a consent record) and enters
 * the pipeline at `consented`, source `applied`.
 */
export async function applyThroughPlatform(candidate: { id: string; email: string }, jobId: string, meta?: RequestMeta) {
  const job = await db.job.findUnique({ where: { id: jobId }, select: { id: true, source: true, requisition: { select: { id: true, organizationId: true, status: true } } } });
  if (!job || job.source !== EMPLOYER_SOURCE_KEY || !job.requisition) throw new EmployerError('This posting is not an employer requisition on this platform.', 404);
  if (job.requisition.status !== 'open') throw new EmployerError('This requisition is not open.', 409);
  const { organizationId, id: requisitionId } = job.requisition;
  const existing = await db.submission.findUnique({ where: { requisitionId_candidateUserId: { requisitionId, candidateUserId: candidate.id } } });
  // A row the RECRUITER made (sourced, asked, or rejected/withdrawn before the
  // candidate ever applied) does not stop the candidate applying; a row the
  // candidate's own application made does, unless they withdrew it.
  const candidateApplied = existing?.source === 'applied' && existing.stage !== 'withdrawn';
  if (candidateApplied) throw new EmployerError('You have already applied to this requisition.', 409);
  if (existing && ['screening', 'interviewing', 'offered', 'hired'].includes(existing.stage)) throw new EmployerError('You are already in this employer\'s process for this requisition.', 409);
  const { submission, granted } = await db.$transaction(async (tx) => {
    let disclosure = await grantedDisclosure(tx, organizationId, candidate.id);
    let newConsentId: string | null = null;
    if (!disclosure) {
      const consent = await grantConsent(tx, candidate, 'employer_disclosure', { source: 'settings', meta });
      newConsentId = consent.id;
      disclosure = await tx.disclosure.upsert({
        where: { organizationId_candidateUserId: { organizationId, candidateUserId: candidate.id } },
        create: { organizationId, candidateUserId: candidate.id, requisitionId, status: 'granted', requestedById: candidate.id, respondedAt: new Date(), consentRecordId: consent.id, message: 'Applied through the platform' },
        update: { status: 'granted', requisitionId, respondedAt: new Date(), consentRecordId: consent.id },
      });
    }
    const row = existing
      ? await tx.submission.update({ where: { id: existing.id }, data: { stage: 'consented', source: 'applied', disclosureId: disclosure.id, events: { create: { organizationId, fromStage: existing.stage, toStage: 'consented', actorId: candidate.id, note: 'applied' } } } })
      : await tx.submission.create({ data: { organizationId, requisitionId, candidateUserId: candidate.id, disclosureId: disclosure.id, stage: 'consented', source: 'applied', createdById: candidate.id, events: { create: { organizationId, fromStage: 'sourced', toStage: 'consented', actorId: candidate.id, note: 'applied' } } } });
    return { submission: row, granted: newConsentId ? { disclosureId: disclosure.id, consentId: newConsentId } : null };
  });
  if (granted) await recordSecurityEvent({ event: 'disclosure.granted', user: candidate, entityType: 'Disclosure', entityId: granted.disclosureId, summary: 'Candidate applied to an employer posting on the platform (disclosure granted by their own act)', detail: { organizationId, requisitionId, consentRecordId: granted.consentId }, meta }, db, { strict: true });
  return submission;
}

// --- Pipeline -------------------------------------------------------------------

async function ownedSubmission(tx: Client, actor: EmployerActor, id: string) {
  const s = await tx.submission.findFirst({ where: { id, organizationId: actor.organizationId }, include: { requisition: { select: { id: true, hiringManagerId: true, recruiterId: true, status: true } } } });
  if (!s) throw new EmployerError('Submission not found.', 404);
  return s;
}

/** Add a sourced candidate to a requisition's pipeline at `sourced` (identity still undisclosed). */
export async function addSubmission(tx: Client, actor: EmployerActor, requisitionId: string, candidateUserId: string, source: 'sourced' | 'pool' | 'referred' = 'sourced') {
  const r = await ownedRequisition(tx, actor, requisitionId);
  if (!canMovePipeline(actor.role, r, actor.user.id)) throw new EmployerError('You may not change this pipeline.', 403);
  if (!(await sourceable(candidateUserId))) throw new EmployerError('This candidate is not open to recruiters.', 404);
  const disclosure = await grantedDisclosure(tx, actor.organizationId, candidateUserId);
  const stage: SubmissionStage = disclosure ? 'consented' : 'sourced';
  const existing = await tx.submission.findUnique({ where: { requisitionId_candidateUserId: { requisitionId, candidateUserId } } });
  if (!existing) {
    return tx.submission.create({ data: { organizationId: actor.organizationId, requisitionId, candidateUserId, disclosureId: disclosure?.id ?? null, stage, source, createdById: actor.user.id, ownerId: actor.user.id, events: { create: { organizationId: actor.organizationId, fromStage: 'sourced', toStage: stage, actorId: actor.user.id, note: source } } } });
  }
  // Already in the pipeline: a `sourced` row whose candidate has since granted disclosure moves on; anything else is left as it is.
  if (existing.stage === 'sourced' && disclosure) {
    return tx.submission.update({ where: { id: existing.id }, data: { disclosureId: disclosure.id, stage: 'consented', events: { create: { organizationId: actor.organizationId, fromStage: 'sourced', toStage: 'consented', actorId: actor.user.id, note: 'disclosure already granted' } } } });
  }
  return existing;
}

export async function moveSubmission(tx: Client, actor: EmployerActor, submissionId: string, to: string, note = '') {
  if (!isSubmissionStage(to)) throw new EmployerError('Unknown stage.', 422);
  const s = await ownedSubmission(tx, actor, submissionId);
  if (!canMovePipeline(actor.role, s.requisition, actor.user.id)) throw new EmployerError('You may not change this pipeline.', 403);
  const from = s.stage as SubmissionStage;
  if (!canTransition(from, to)) throw new EmployerError(`A submission at ${from} cannot move to ${to}.`, 409);
  if (to === 'consented' || to === 'consent_requested') throw new EmployerError('Consent is the candidate\'s to give; ask for disclosure instead.', 409);
  if (requiresDisclosure(to) && !(await grantedDisclosure(tx, actor.organizationId, s.candidateUserId))) throw new EmployerError('The candidate has not granted disclosure to your organisation; nothing past consent is possible.', 403);
  const updated = await tx.submission.update({ where: { id: s.id }, data: { stage: to, ...(to === 'hired' ? { hiredAt: new Date() } : {}), ...(to === 'rejected' ? { rejectedReason: note.trim().slice(0, 500) } : {}), events: { create: { organizationId: actor.organizationId, fromStage: from, toStage: to, actorId: actor.user.id, note: note.trim().slice(0, 500) } } } });
  await audit('employer.submission.moved', actor, 'Submission', s.id, `Submission moved ${from} -> ${to}`, { requisitionId: s.requisitionId, from, to });
  return updated;
}

export async function loadRequisition(tx: Client, actor: EmployerActor, id: string) {
  const r = await ownedRequisition(tx, actor, id);
  const submissions = await tx.submission.findMany({ where: { requisitionId: r.id }, orderBy: [{ stage: 'asc' }, { updatedAt: 'desc' }], include: { disclosure: { select: { status: true } }, _count: { select: { interviews: true, notes: true, offers: true } } } });
  const disclosed = await Promise.all(submissions.map(async (s) => (await grantedDisclosure(tx, actor.organizationId, s.candidateUserId)) !== null));
  // Identity for disclosed submissions only; anything else is a number.
  const ids = submissions.filter((_, i) => disclosed[i]).map((s) => s.candidateUserId);
  const users = ids.length ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, headline: true, city: true } }) : [];
  return {
    requisition: r,
    canWrite: canWriteRequisition(actor.role, r, actor.user.id),
    submissions: submissions.map((s, i) => {
      const u = disclosed[i] ? users.find((x) => x.id === s.candidateUserId) : undefined;
      return { id: s.id, stage: s.stage, source: s.source, disclosed: disclosed[i], candidate: u ? { name: u.fullName, headline: u.headline, city: u.city } : { name: null, headline: null, city: null }, counts: s._count, updatedAt: s.updatedAt };
    }),
  };
}

/** An interviewer opens only a submission they are named on; a viewer reads without offers (the matrix: Offers "—" for both). */
export async function loadSubmission(tx: Client, actor: EmployerActor, id: string) {
  const s = await ownedSubmission(tx, actor, id);
  const interviews = await tx.employerInterview.findMany({ where: { submissionId: s.id }, orderBy: { scheduledAt: 'asc' } });
  if (actor.role === 'interviewer' && !interviews.some((i) => (JSON.parse(i.interviewerIds) as string[]).includes(actor.user.id))) throw new EmployerError('Submission not found.', 404);
  const seesOffers = actor.role !== 'interviewer' && actor.role !== 'viewer';
  const [events, notes, offers] = await Promise.all([
    tx.submissionEvent.findMany({ where: { submissionId: s.id }, orderBy: { at: 'asc' } }),
    tx.employerNote.findMany({ where: { submissionId: s.id }, orderBy: { createdAt: 'desc' } }),
    seesOffers ? tx.offer.findMany({ where: { submissionId: s.id }, orderBy: { createdAt: 'desc' } }) : Promise.resolve([]),
  ]);
  return { submission: s, events, interviews, notes, offers, disclosed: (await grantedDisclosure(tx, actor.organizationId, s.candidateUserId)) !== null, canWrite: canMovePipeline(actor.role, s.requisition, actor.user.id) };
}

/** Whether this actor may see a disclosed candidate's identity and profile: admin, recruiter and hiring manager; an interviewer only for a candidate whose interview names them; never a viewer. */
export async function canSeeCandidate(client: Client, actor: EmployerActor, candidateUserId: string): Promise<boolean> {
  if (actor.role === 'admin' || actor.role === 'recruiter' || actor.role === 'hiring_manager') return true;
  if (actor.role !== 'interviewer') return false;
  const interviews = await client.employerInterview.findMany({ where: { organizationId: actor.organizationId, submission: { candidateUserId } }, select: { interviewerIds: true } });
  return interviews.some((i) => (JSON.parse(i.interviewerIds) as string[]).includes(actor.user.id));
}

// --- Talent pools ------------------------------------------------------------------

export async function createPool(tx: Client, actor: EmployerActor, input: { name: string; description?: string }) {
  if (!canSource(actor.role)) throw new EmployerError('Only a recruiter or an administrator manages talent pools.', 403);
  return tx.talentPool.create({ data: { organizationId: actor.organizationId, name: input.name.trim(), description: input.description?.trim() ?? '', createdById: actor.user.id } });
}

/** A pool holds consented candidates only: the membership cites the granted disclosure and is deleted with its revocation. */
export async function addToPool(tx: Client, actor: EmployerActor, poolId: string, candidateUserId: string) {
  if (!canSource(actor.role)) throw new EmployerError('Only a recruiter or an administrator manages talent pools.', 403);
  const pool = await tx.talentPool.findFirst({ where: { id: poolId, organizationId: actor.organizationId } });
  if (!pool) throw new EmployerError('Pool not found.', 404);
  const d = await grantedDisclosure(tx, actor.organizationId, candidateUserId);
  if (!d) throw new EmployerError('Only a candidate who granted disclosure can be in a pool.', 403);
  return tx.talentPoolMember.upsert({ where: { poolId_candidateUserId: { poolId, candidateUserId } }, create: { poolId, organizationId: actor.organizationId, candidateUserId, disclosureId: d.id, addedById: actor.user.id }, update: {} });
}

export async function listPools(tx: Client, actor: EmployerActor) {
  if (!canReadSourcing(actor.role)) throw new EmployerError('You may not read talent pools.', 403);
  return tx.talentPool.findMany({ where: { organizationId: actor.organizationId }, include: { _count: { select: { members: true } } }, orderBy: { name: 'asc' } });
}

// --- Interviews, notes, offers -------------------------------------------------------

export async function scheduleInterview(tx: Client, actor: EmployerActor, submissionId: string, input: { kind?: string; scheduledAt: Date; durationMinutes?: number | null; interviewerIds?: string[] }) {
  const s = await ownedSubmission(tx, actor, submissionId);
  if (!canMovePipeline(actor.role, s.requisition, actor.user.id)) throw new EmployerError('You may not change this pipeline.', 403);
  if (!(await grantedDisclosure(tx, actor.organizationId, s.candidateUserId))) throw new EmployerError('The candidate has not granted disclosure; no interview can be scheduled.', 403);
  if (!['consented', 'screening', 'interviewing'].includes(s.stage)) throw new EmployerError(`No interview is scheduled at stage ${s.stage}.`, 409);
  for (const id of input.interviewerIds ?? []) await assertMember(tx, actor.organizationId, id);
  const interview = await tx.employerInterview.create({ data: { submissionId: s.id, requisitionId: s.requisitionId, organizationId: actor.organizationId, kind: input.kind?.trim() || 'screen', scheduledAt: input.scheduledAt, durationMinutes: input.durationMinutes ?? null, interviewerIds: JSON.stringify(input.interviewerIds ?? []), createdById: actor.user.id } });
  if (s.stage !== 'interviewing') await moveSubmission(tx, actor, s.id, 'interviewing', 'interview scheduled');
  return interview;
}

export async function recordInterview(tx: Client, actor: EmployerActor, interviewId: string, input: { outcome: (typeof INTERVIEW_OUTCOMES)[number]; feedback?: string }) {
  const i = await tx.employerInterview.findFirst({ where: { id: interviewId, organizationId: actor.organizationId } });
  if (!i) throw new EmployerError('Interview not found.', 404);
  const s = await ownedSubmission(tx, actor, i.submissionId);
  if (!canWriteInterview(actor.role, s.requisition, JSON.parse(i.interviewerIds) as string[], actor.user.id)) throw new EmployerError('Only a named interviewer or the pipeline\'s owner records an interview.', 403);
  return tx.employerInterview.update({ where: { id: i.id }, data: { outcome: input.outcome, ...(input.feedback !== undefined ? { feedback: input.feedback.trim().slice(0, 5000) } : {}) } });
}

export async function addEmployerNote(tx: Client, actor: EmployerActor, submissionId: string, body: string) {
  const s = await ownedSubmission(tx, actor, submissionId);
  // Interviewers write their interview's feedback, not pipeline notes (the matrix: pipeline R for an interviewer).
  if (!canMovePipeline(actor.role, s.requisition, actor.user.id)) throw new EmployerError('You may not add a note here.', 403);
  const text = body.trim();
  if (!text) throw new EmployerError('Write the note.', 422);
  return tx.employerNote.create({ data: { submissionId: s.id, organizationId: actor.organizationId, authorId: actor.user.id, authorEmail: actor.user.email, body: text.slice(0, 5000) } });
}

export async function extendOffer(tx: Client, actor: EmployerActor, submissionId: string, input: { salaryCents?: number | null; currency?: string; startDate?: Date | null; note?: string }) {
  const s = await ownedSubmission(tx, actor, submissionId);
  if (!canDecideOffer(actor.role, s.requisition, actor.user.id)) throw new EmployerError('Only the requisition\'s hiring manager or an administrator extends an offer.', 403);
  if (!(await grantedDisclosure(tx, actor.organizationId, s.candidateUserId))) throw new EmployerError('The candidate has not granted disclosure; no offer can be extended.', 403);
  if (!['screening', 'interviewing'].includes(s.stage)) throw new EmployerError(`No offer is extended at stage ${s.stage}.`, 409);
  const offer = await tx.offer.create({ data: { submissionId: s.id, requisitionId: s.requisitionId, organizationId: actor.organizationId, salaryCents: input.salaryCents ?? null, currency: input.currency ?? 'CAD', startDate: input.startDate ?? null, note: input.note?.trim() ?? '', status: 'extended', extendedAt: new Date(), createdById: actor.user.id } });
  await moveSubmission(tx, actor, s.id, 'offered', 'offer extended');
  return offer;
}

/** The employer records the candidate's answer (or withdraws). Accepted is a hire (and fills the requisition when asked); declined or withdrawn closes the submission as `rejected`. */
export async function decideOffer(tx: Client, actor: EmployerActor, offerId: string, input: { status: 'accepted' | 'declined' | 'withdrawn'; fillRequisition?: boolean }) {
  const o = await tx.offer.findFirst({ where: { id: offerId, organizationId: actor.organizationId } });
  if (!o) throw new EmployerError('Offer not found.', 404);
  const s = await ownedSubmission(tx, actor, o.submissionId);
  if (!canDecideOffer(actor.role, s.requisition, actor.user.id)) throw new EmployerError('You may not decide this offer.', 403);
  if (o.status !== 'extended') throw new EmployerError('This offer has already been decided.', 409);
  // The candidate revoked disclosure after the offer went out: the submission
  // is already `withdrawn` (terminal); the offer is closed as withdrawn and no
  // move is attempted.
  if (s.stage === 'withdrawn') {
    const closed = await tx.offer.update({ where: { id: o.id }, data: { status: 'withdrawn', respondedAt: new Date() } });
    await audit('employer.offer.decided', actor, 'Offer', o.id, 'Offer withdrawn (the candidate withdrew)', { submissionId: s.id, requisitionId: s.requisitionId, status: 'withdrawn' });
    return closed;
  }
  const offer = await tx.offer.update({ where: { id: o.id }, data: { status: input.status, respondedAt: new Date() } });
  if (input.status === 'accepted') {
    await moveSubmission(tx, actor, s.id, 'hired', 'offer accepted');
    if (input.fillRequisition) await setRequisitionStatus(tx, actor, s.requisitionId, 'filled');
  } else if (input.status === 'declined') {
    await moveSubmission(tx, actor, s.id, 'rejected', 'offer declined by the candidate');
  } else {
    await moveSubmission(tx, actor, s.id, 'rejected', 'offer withdrawn');
  }
  await audit('employer.offer.decided', actor, 'Offer', o.id, `Offer ${input.status}`, { submissionId: s.id, requisitionId: s.requisitionId, status: input.status });
  return offer;
}

// --- Reporting ---------------------------------------------------------------------------

/**
 * Organisation-level hiring numbers from the pipeline's events: funnel
 * counts per stage, source performance (submissions and hires by source),
 * recruiter productivity (moves by actor), and time-to-shortlist / interview /
 * hire as medians in days from the submission's creation to the first event
 * INTO the stage. No candidate identity; the organisation's own rows only.
 */
export async function reporting(tx: Client, actor: EmployerActor, range: { from: Date; to: Date }) {
  if (!canReadReporting(actor.role)) throw new EmployerError('Reporting is not available to an interviewer.', 403);
  const subs = await tx.submission.findMany({ where: { organizationId: actor.organizationId, createdAt: { gte: range.from, lte: range.to } }, select: { id: true, source: true, stage: true, createdAt: true, requisitionId: true } });
  const events = await tx.submissionEvent.findMany({ where: { organizationId: actor.organizationId, submissionId: { in: subs.map((s) => s.id) } }, orderBy: { at: 'asc' }, select: { submissionId: true, toStage: true, actorId: true, at: true } });
  const firstInto = new Map<string, Map<string, Date>>();
  const byActor = new Map<string, number>();
  for (const e of events) {
    if (!firstInto.has(e.submissionId)) firstInto.set(e.submissionId, new Map());
    const m = firstInto.get(e.submissionId)!;
    if (!m.has(e.toStage)) m.set(e.toStage, e.at);
    byActor.set(e.actorId, (byActor.get(e.actorId) ?? 0) + 1);
  }
  // Recruiter activity names organisation MEMBERS only: candidate-driven
  // events (an application, a grant, a revocation) carry the candidate's id
  // as actor and must not surface here.
  const members = new Set((await tx.membership.findMany({ where: { organizationId: actor.organizationId, acceptedAt: { not: null }, removedAt: null }, select: { userId: true } })).map((m) => m.userId));
  for (const id of [...byActor.keys()]) if (!members.has(id)) byActor.delete(id);
  const reached = (stage: string) => subs.filter((s) => firstInto.get(s.id)?.has(stage)).length;
  const median = (stage: string): number | null => {
    const days: number[] = [];
    for (const s of subs) {
      const at = firstInto.get(s.id)?.get(stage);
      if (at) days.push((at.getTime() - s.createdAt.getTime()) / 86_400_000);
    }
    days.sort((a, b) => a - b);
    if (days.length === 0) return null;
    const mid = Math.floor(days.length / 2);
    return Math.round((days.length % 2 ? days[mid]! : (days[mid - 1]! + days[mid]!) / 2) * 10) / 10;
  };
  const sources: Record<string, { submissions: number; hires: number }> = {};
  for (const s of subs) {
    sources[s.source] = sources[s.source] ?? { submissions: 0, hires: 0 };
    sources[s.source]!.submissions += 1;
    if (s.stage === 'hired') sources[s.source]!.hires += 1;
  }
  return {
    range,
    funnel: { submissions: subs.length, consented: reached('consented'), screening: reached('screening'), interviewing: reached('interviewing'), offered: reached('offered'), hired: reached('hired'), rejected: reached('rejected'), withdrawn: reached('withdrawn') },
    daysTo: { shortlist: median('screening'), interview: median('interviewing'), hire: median('hired') },
    sources,
    recruiterActivity: [...byActor.entries()].map(([actorId, moves]) => ({ actorId, moves })).sort((a, b) => b.moves - a.moves),
  };
}
