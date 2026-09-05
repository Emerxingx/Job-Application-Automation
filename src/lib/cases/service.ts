/**
 * Stage 17 (ADR-0032) - case management for a service-provider organisation,
 * at Level 0 (ADR-0020: no WorkBC integration of any kind).
 *
 * The shape of every function: the ACTOR is a member of a service-provider
 * organisation with a case role (roles.ts); reads and writes of case rows
 * run on the tenant path inside the organisation's context (RLS: the
 * organisation's members and nobody else - the client sees only their own
 * case's invitation and consent state); assignment gating is applied here,
 * on top. A case note and an assessment are RESTRICTED: every read and
 * every write is audited FIRST, strictly, on the system client (the tenant
 * role cannot write `AuditLog`), with ids and kinds only - never a body,
 * a barrier or a name. The client's consent is recorded by the client, on
 * the system client, as a `ConsentRecord`; nothing about the client is read
 * before it exists and after it is withdrawn (client-view.ts).
 */
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { grantConsent } from '@/lib/consent';
import { datasetFacts, isServable } from '@/lib/career/service';
import { recordSecurityEvent, type RequestMeta, type SecurityEvent } from '@/lib/security-audit';
import { findActiveMembership } from '@/lib/tenancy/organizations';
import { canManageCaseload, canOpenCase, canWriteCase, caseRoleOf, isServiceRole, type CaseRole, type ServiceRole } from './roles';

type Client = Prisma.TransactionClient | typeof db;

export class CaseError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'CaseError';
    this.status = status;
  }
}

export interface CaseActor {
  user: { id: string; email: string };
  organizationId: string;
  role: CaseRole;
  meta?: RequestMeta;
}

export const CASE_STATUSES = ['invited', 'declined', 'open', 'closed'] as const;
export const TASK_KINDS = ['task', 'intervention', 'referral'] as const;
export const TASK_STATUSES = ['planned', 'in_progress', 'done', 'dropped'] as const;
export const OUTCOME_KINDS = ['employed', 'self_employed', 'training', 'not_employed', 'other'] as const;
export const FOLLOW_UP_STATUSES = ['pending', 'retained', 'not_retained', 'unknown'] as const;
export const ASSESSMENT_KINDS = ['intake', 'review'] as const;
/** Retention follow-ups after an employment outcome, in weeks (a common programme shape; not a WorkBC schema - ADR-0020 rule 5). */
export const FOLLOW_UP_WEEKS = [4, 12, 24] as const;

/**
 * Resolve who is acting: an ACCEPTED member of a service-provider
 * organisation, with the case role their membership confers. Fails closed:
 * no membership, another organisation type, a pending invitation - 404
 * (whether the organisation exists is not the caller's to learn).
 */
export async function requireCaseActor(user: { id: string; email: string }, organizationId: string, meta?: RequestMeta): Promise<CaseActor> {
  const membership = await findActiveMembership(db, organizationId, user.id);
  if (!membership) throw new CaseError('Organization not found.', 404);
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { type: true } });
  if (!org || org.type !== 'service_provider') throw new CaseError('Organization not found.', 404);
  return { user, organizationId, role: caseRoleOf(membership), meta };
}

/** The service-provider organisations a person belongs to, with their case role in each. */
export async function serviceProviderMemberships(userId: string) {
  const rows = await db.membership.findMany({ where: { userId, acceptedAt: { not: null }, removedAt: null, organization: { type: 'service_provider' } }, include: { organization: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } });
  return rows.map((m) => ({ organizationId: m.organization.id, name: m.organization.name, role: caseRoleOf(m) }));
}

async function audit(event: SecurityEvent, actor: CaseActor, entityType: string, entityId: string, summary: string, detail: Record<string, string | number | boolean | null> = {}): Promise<void> {
  await recordSecurityEvent(
    { event, actor: { type: 'user', id: actor.user.id, email: actor.user.email, role: `case:${actor.role}` }, entityType, entityId, summary, detail: { organizationId: actor.organizationId, ...detail }, meta: actor.meta },
    db,
    { strict: true },
  );
}

async function ownedCase(tx: Client, actor: CaseActor, caseId: string) {
  const c = await tx.case.findFirst({ where: { id: caseId, organizationId: actor.organizationId } });
  if (!c || !canOpenCase(actor.role, c, actor.user.id)) throw new CaseError('Case not found.', 404);
  return c;
}

function mustWrite(actor: CaseActor, c: { caseManagerId: string | null }): void {
  if (!canWriteCase(actor.role, c, actor.user.id)) throw new CaseError('Only the assigned case manager or an administrator may change this case.', 403);
}

function mustManage(actor: CaseActor): void {
  if (!canManageCaseload(actor.role)) throw new CaseError('Only a supervisor or an administrator may manage the caseload.', 403);
}

// --- Roster -----------------------------------------------------------------

/** Set a member's service role (admin only). The organisation ladder itself is the membership service's. */
export async function setServiceRole(actor: CaseActor, memberUserId: string, serviceRole: ServiceRole | null): Promise<void> {
  if (actor.role !== 'admin') throw new CaseError('Only an administrator sets service roles.', 403);
  if (serviceRole !== null && !isServiceRole(serviceRole)) throw new CaseError('Unknown service role.', 422);
  const m = await findActiveMembership(db, actor.organizationId, memberUserId);
  if (!m) throw new CaseError('No such member.', 404);
  await db.membership.update({ where: { id: m.id }, data: { serviceRole } });
  await audit('case.assigned', actor, 'Membership', m.id, 'Service role set', { memberUserId, serviceRole: serviceRole ?? '' });
}

/** Members who may be assigned a case (case managers, supervisors, admins), for the assignment control. */
export async function assignableMembers(tx: Client, actor: CaseActor) {
  const rows = await tx.membership.findMany({ where: { organizationId: actor.organizationId, acceptedAt: { not: null }, removedAt: null }, select: { userId: true, role: true, serviceRole: true } });
  return rows.filter((m) => caseRoleOf(m) !== 'viewer');
}

// --- Lifecycle --------------------------------------------------------------

/**
 * Invite a client: a case in status `invited`, holding nothing about the
 * person until they accept (client-view.ts refuses until then). The lookup
 * by email is audited; a case manager who did not obtain the address from
 * the client in person is answerable for it (ADR-0032 §3).
 */
export async function inviteClient(actor: CaseActor, input: { email: string; caseManagerId?: string | null; employmentGoal?: string }) {
  mustManage(actor);
  const email = input.email.trim().toLowerCase();
  const client = await db.user.findUnique({ where: { email }, select: { id: true, anonymizedAt: true } });
  if (!client || client.anonymizedAt) throw new CaseError('No account with that email. The client signs up first, then accepts the invitation under Settings.', 404);
  const existing = await db.case.findUnique({ where: { organizationId_clientUserId: { organizationId: actor.organizationId, clientUserId: client.id } } });
  if (existing && existing.status !== 'declined' && existing.status !== 'closed') throw new CaseError('This organisation already has a case for that client.', 409);
  if (input.caseManagerId) await assertAssignable(db, actor.organizationId, input.caseManagerId);
  const c = existing
    ? await db.case.update({ where: { id: existing.id }, data: { status: 'invited', caseManagerId: input.caseManagerId ?? null, employmentGoal: input.employmentGoal ?? '', consentedAt: null, consentRecordId: null, openedAt: null, closedAt: null, closedReason: '', createdById: actor.user.id } })
    : await db.case.create({ data: { organizationId: actor.organizationId, clientUserId: client.id, caseManagerId: input.caseManagerId ?? null, status: 'invited', employmentGoal: input.employmentGoal ?? '', createdById: actor.user.id } });
  await audit('case.invited', actor, 'Case', c.id, 'Client invited to a case', { clientUserId: client.id, caseManagerId: c.caseManagerId });
  return c;
}

async function assertAssignable(client: Client, organizationId: string, userId: string): Promise<void> {
  const m = await findActiveMembership(client, organizationId, userId);
  if (!m || caseRoleOf(m) === 'viewer') throw new CaseError('That member cannot be assigned a case.', 422);
}

/**
 * The client's side: the invitations and cases that concern them - their own
 * rows on their tenant path. The provider's NAME comes from the system
 * client: the client is not a member of the organisation, so its row is
 * invisible to them under RLS, and an invitation that named nobody would be
 * useless. The name is all that is read.
 */
export async function listClientCases(tx: Client, clientUserId: string) {
  const rows = await tx.case.findMany({ where: { clientUserId }, orderBy: { createdAt: 'desc' } });
  const orgIds = [...new Set(rows.map((r) => r.organizationId))];
  const names = orgIds.length ? await db.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }) : [];
  return rows.map((r) => ({ ...r, organization: { name: names.find((o) => o.id === r.organizationId)?.name ?? 'An employment service provider' } }));
}

/**
 * The client answers. Accepting records a `ConsentRecord`
 * (`employment_services_case`, source `settings`) and opens the case;
 * declining closes the door without a word about the person. System
 * client: the tenant policy lets the client SEE their case, not write it.
 */
export async function respondToInvitation(client: { id: string; email: string }, caseId: string, accept: boolean, meta?: RequestMeta) {
  const c = await db.case.findFirst({ where: { id: caseId, clientUserId: client.id } });
  if (!c) throw new CaseError('Case not found.', 404);
  if (c.status !== 'invited') throw new CaseError('This invitation has already been answered.', 409);
  if (!accept) {
    const declined = await db.case.update({ where: { id: c.id }, data: { status: 'declined' } });
    await recordSecurityEvent({ event: 'case.declined', user: client, entityType: 'Case', entityId: c.id, summary: 'Client declined a case invitation', detail: { organizationId: c.organizationId }, meta }, db, { strict: true });
    return declined;
  }
  const consent = await grantConsent(db, client, 'employment_services_case', { source: 'settings', meta });
  const opened = await db.case.update({ where: { id: c.id }, data: { status: 'open', consentedAt: new Date(), consentRecordId: consent.id, openedAt: new Date() } });
  await recordSecurityEvent({ event: 'case.consented', user: client, entityType: 'Case', entityId: c.id, summary: 'Client consented to case management', detail: { organizationId: c.organizationId, consentRecordId: consent.id }, meta }, db, { strict: true });
  return opened;
}

/** The client withdraws: the case closes and the consent record is revoked; nothing more is read about them from then on. */
export async function withdrawFromCase(client: { id: string; email: string }, caseId: string, meta?: RequestMeta) {
  const c = await db.case.findFirst({ where: { id: caseId, clientUserId: client.id } });
  if (!c) throw new CaseError('Case not found.', 404);
  if (c.status !== 'open') throw new CaseError('This case is not open.', 409);
  await db.$transaction(async (tx) => {
    await tx.case.update({ where: { id: c.id }, data: { status: 'closed', closedAt: new Date(), closedReason: 'client_withdrew' } });
    if (c.consentRecordId) await tx.consentRecord.updateMany({ where: { id: c.consentRecordId, revokedAt: null }, data: { revokedAt: new Date() } });
  });
  await recordSecurityEvent({ event: 'case.closed', user: client, entityType: 'Case', entityId: c.id, summary: 'Client withdrew from case management', detail: { organizationId: c.organizationId, reason: 'client_withdrew' }, meta }, db, { strict: true });
}

export async function assignCaseManager(tx: Client, actor: CaseActor, caseId: string, caseManagerId: string | null) {
  mustManage(actor);
  const c = await ownedCase(tx, actor, caseId);
  if (caseManagerId) await assertAssignable(tx, actor.organizationId, caseManagerId);
  const updated = await tx.case.update({ where: { id: c.id }, data: { caseManagerId } });
  await audit('case.assigned', actor, 'Case', c.id, 'Case manager assigned', { caseManagerId: caseManagerId ?? '' });
  return updated;
}

export async function updateCaseGoal(tx: Client, actor: CaseActor, caseId: string, input: { employmentGoal?: string; targetOccupationId?: string | null }) {
  const c = await ownedCase(tx, actor, caseId);
  mustWrite(actor, c);
  if (c.status !== 'open') throw new CaseError('This case is not open.', 409);
  if (input.targetOccupationId) {
    const occ = await tx.occupation.findUnique({ where: { id: input.targetOccupationId }, select: { id: true } });
    if (!occ) throw new CaseError('No such occupation.', 404);
  }
  return tx.case.update({ where: { id: c.id }, data: { ...(input.employmentGoal !== undefined ? { employmentGoal: input.employmentGoal } : {}), ...(input.targetOccupationId !== undefined ? { targetOccupationId: input.targetOccupationId } : {}) } });
}

export async function closeCase(tx: Client, actor: CaseActor, caseId: string, reason: string) {
  const c = await ownedCase(tx, actor, caseId);
  if (!canManageCaseload(actor.role)) mustWrite(actor, c);
  if (c.status === 'closed') throw new CaseError('This case is already closed.', 409);
  const closed = await tx.case.update({ where: { id: c.id }, data: { status: 'closed', closedAt: new Date(), closedReason: reason } });
  await audit('case.closed', actor, 'Case', c.id, 'Case closed', { reason });
  return closed;
}

// --- Reading the caseload ---------------------------------------------------

/**
 * The caseload as the role sees it: supervisors and admins the whole
 * organisation, a case manager their own assignments, a viewer counts only.
 * Client identities (name, email) come from the system client for the rows
 * the tenant path returned - the clients consented to this organisation -
 * and never for a declined case.
 */
export async function listCaseload(tx: Client, actor: CaseActor, filter: { status?: string } = {}) {
  const where: Prisma.CaseWhereInput = { organizationId: actor.organizationId, ...(filter.status ? { status: filter.status } : {}) };
  if (actor.role === 'case_manager') where.caseManagerId = actor.user.id;
  const counts = await tx.case.groupBy({ by: ['status'], where: { organizationId: actor.organizationId }, _count: { _all: true } });
  const aggregate = Object.fromEntries(counts.map((r) => [r.status, r._count._all])) as Record<string, number>;
  if (actor.role === 'viewer') return { cases: [], aggregate };
  const rows = await tx.case.findMany({ where, orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }], include: { _count: { select: { tasks: true, recommendations: true } } } });
  const identities = await clientIdentities(rows);
  return {
    aggregate,
    cases: rows.map((c) => ({ id: c.id, status: c.status, caseManagerId: c.caseManagerId, employmentGoal: c.employmentGoal, targetOccupationId: c.targetOccupationId, openedAt: c.openedAt, closedAt: c.closedAt, updatedAt: c.updatedAt, tasks: c._count.tasks, recommendations: c._count.recommendations, client: identities.get(c.clientUserId) ?? { name: null, email: null } })),
  };
}

async function clientIdentities(rows: { clientUserId: string; status: string }[]): Promise<Map<string, { name: string | null; email: string | null }>> {
  const ids = rows.filter((r) => r.status !== 'declined').map((r) => r.clientUserId);
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, email: true } });
  const out = new Map<string, { name: string | null; email: string | null }>();
  for (const r of rows) {
    const u = users.find((x) => x.id === r.clientUserId);
    if (!u) continue;
    // Before consent only the address the case manager typed is shown back; the name waits for the person.
    out.set(r.clientUserId, r.status === 'invited' ? { name: null, email: u.email } : { name: u.fullName, email: u.email });
  }
  return out;
}

/** One case without its RESTRICTED rows (notes and assessments are read separately, audited). */
export async function loadCase(tx: Client, actor: CaseActor, caseId: string) {
  const c = await ownedCase(tx, actor, caseId);
  const [tasks, outcomes, followUps, recommendations, identity] = await Promise.all([
    tx.caseTask.findMany({ where: { caseId: c.id }, orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { createdAt: 'asc' }] }),
    tx.caseOutcome.findMany({ where: { caseId: c.id }, orderBy: { recordedAt: 'desc' } }),
    tx.caseFollowUp.findMany({ where: { caseId: c.id }, orderBy: { dueAt: 'asc' } }),
    tx.caseRecommendation.findMany({ where: { caseId: c.id }, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }] }),
    clientIdentities([c]),
  ]);
  return { case: c, client: identity.get(c.clientUserId) ?? { name: null, email: null }, tasks, outcomes, followUps, recommendations, canWrite: canWriteCase(actor.role, c, actor.user.id), canManage: canManageCaseload(actor.role) };
}

// --- RESTRICTED: notes and assessments --------------------------------------

export async function listNotes(tx: Client, actor: CaseActor, caseId: string) {
  const c = await ownedCase(tx, actor, caseId);
  await audit('case.note.read', actor, 'Case', c.id, 'Case notes read');
  return tx.caseNote.findMany({ where: { caseId: c.id }, orderBy: { createdAt: 'desc' } });
}

export async function addNote(tx: Client, actor: CaseActor, caseId: string, body: string) {
  const c = await ownedCase(tx, actor, caseId);
  mustWrite(actor, c);
  if (c.status !== 'open') throw new CaseError('This case is not open.', 409);
  const text = body.trim();
  if (!text) throw new CaseError('Write the note.', 422);
  await audit('case.note.written', actor, 'Case', c.id, 'Case note written', { length: text.length });
  return tx.caseNote.create({ data: { caseId: c.id, organizationId: actor.organizationId, authorId: actor.user.id, authorEmail: actor.user.email, body: text } });
}

export async function listAssessments(tx: Client, actor: CaseActor, caseId: string) {
  const c = await ownedCase(tx, actor, caseId);
  await audit('case.assessment.read', actor, 'Case', c.id, 'Case assessments read');
  return tx.caseAssessment.findMany({ where: { caseId: c.id }, orderBy: { createdAt: 'desc' } });
}

export async function addAssessment(tx: Client, actor: CaseActor, caseId: string, input: { kind: (typeof ASSESSMENT_KINDS)[number]; summary: string; barriers: string[]; employmentGoal?: string }) {
  const c = await ownedCase(tx, actor, caseId);
  mustWrite(actor, c);
  if (c.status !== 'open') throw new CaseError('This case is not open.', 409);
  await audit('case.assessment.written', actor, 'Case', c.id, 'Case assessment written', { kind: input.kind, barriers: input.barriers.length });
  const row = await tx.caseAssessment.create({ data: { caseId: c.id, organizationId: actor.organizationId, authorId: actor.user.id, kind: input.kind, summary: input.summary.trim(), barriers: JSON.stringify(input.barriers.map((b) => b.trim()).filter(Boolean)), employmentGoal: input.employmentGoal?.trim() ?? '' } });
  if (input.employmentGoal?.trim()) await tx.case.update({ where: { id: c.id }, data: { employmentGoal: input.employmentGoal.trim() } });
  return row;
}

// --- Action plan --------------------------------------------------------------

export async function addTask(tx: Client, actor: CaseActor, caseId: string, input: { kind: (typeof TASK_KINDS)[number]; title: string; description?: string; dueAt?: Date | null; offeringId?: string | null; recommendationId?: string | null }) {
  const c = await ownedCase(tx, actor, caseId);
  mustWrite(actor, c);
  if (c.status !== 'open') throw new CaseError('This case is not open.', 409);
  let offeringId: string | null = null;
  if (input.kind === 'referral') {
    if (!input.offeringId) throw new CaseError('A training referral names a licensed offering.', 422);
    const [offering, facts] = await Promise.all([tx.learningOffering.findUnique({ where: { id: input.offeringId }, select: { id: true, datasetId: true, active: true } }), datasetFacts()]);
    if (!offering || !offering.active || !isServable(offering.datasetId, facts)) throw new CaseError('That offering is not available under a recorded licence.', 422);
    offeringId = offering.id;
  }
  return tx.caseTask.create({ data: { caseId: c.id, organizationId: actor.organizationId, kind: input.kind, title: input.title.trim(), description: input.description?.trim() ?? '', dueAt: input.dueAt ?? null, offeringId, recommendationId: input.recommendationId ?? null, createdById: actor.user.id } });
}

export async function updateTask(tx: Client, actor: CaseActor, taskId: string, input: { status?: (typeof TASK_STATUSES)[number]; title?: string; description?: string; dueAt?: Date | null }) {
  const t = await tx.caseTask.findFirst({ where: { id: taskId, organizationId: actor.organizationId } });
  if (!t) throw new CaseError('Task not found.', 404);
  const c = await ownedCase(tx, actor, t.caseId);
  mustWrite(actor, c);
  return tx.caseTask.update({
    where: { id: t.id },
    data: {
      ...(input.status ? { status: input.status, completedAt: input.status === 'done' ? (t.completedAt ?? new Date()) : null } : {}),
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description.trim() } : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
    },
  });
}

// --- Outcomes and retention follow-up --------------------------------------

export async function recordOutcome(tx: Client, actor: CaseActor, caseId: string, input: { kind: (typeof OUTCOME_KINDS)[number]; employerName?: string; startDate?: Date | null; hoursPerWeek?: number | null; note?: string }) {
  const c = await ownedCase(tx, actor, caseId);
  mustWrite(actor, c);
  if (c.status !== 'open') throw new CaseError('This case is not open.', 409);
  const outcome = await tx.caseOutcome.create({ data: { caseId: c.id, organizationId: actor.organizationId, kind: input.kind, employerName: input.employerName?.trim() ?? '', startDate: input.startDate ?? null, hoursPerWeek: input.hoursPerWeek ?? null, note: input.note?.trim() ?? '', recordedById: actor.user.id } });
  // Retention follow-ups only where there is something to retain.
  if (input.kind === 'employed' || input.kind === 'self_employed' || input.kind === 'training') {
    const from = input.startDate ?? outcome.recordedAt;
    for (const weeks of FOLLOW_UP_WEEKS) {
      await tx.caseFollowUp.create({ data: { caseId: c.id, organizationId: actor.organizationId, outcomeId: outcome.id, dueAt: new Date(from.getTime() + weeks * 7 * 86_400_000) } });
    }
  }
  return outcome;
}

export async function updateFollowUp(tx: Client, actor: CaseActor, followUpId: string, input: { status: (typeof FOLLOW_UP_STATUSES)[number]; note?: string }) {
  const f = await tx.caseFollowUp.findFirst({ where: { id: followUpId, organizationId: actor.organizationId } });
  if (!f) throw new CaseError('Follow-up not found.', 404);
  const c = await ownedCase(tx, actor, f.caseId);
  mustWrite(actor, c);
  return tx.caseFollowUp.update({ where: { id: f.id }, data: { status: input.status, completedAt: input.status === 'pending' ? null : new Date(), ...(input.note !== undefined ? { note: input.note.trim() } : {}) } });
}

// --- Recommendations: the case manager decides -------------------------------

/**
 * Accept or dismiss a copilot recommendation. Accepting changes NOTHING on
 * the client's record by itself; with `createTask` the case manager's own
 * action-plan item is created, citing the recommendation - the only way a
 * recommendation becomes anything.
 */
export async function decideRecommendation(tx: Client, actor: CaseActor, recommendationId: string, input: { status: 'accepted' | 'dismissed'; note?: string; createTask?: { kind: (typeof TASK_KINDS)[number]; title: string; dueAt?: Date | null } }) {
  const r = await tx.caseRecommendation.findFirst({ where: { id: recommendationId, organizationId: actor.organizationId } });
  if (!r) throw new CaseError('Recommendation not found.', 404);
  const c = await ownedCase(tx, actor, r.caseId);
  mustWrite(actor, c);
  if (r.status !== 'open') throw new CaseError('This recommendation has already been decided.', 409);
  const decided = await tx.caseRecommendation.update({ where: { id: r.id }, data: { status: input.status, decidedById: actor.user.id, decidedAt: new Date(), decisionNote: input.note?.trim() ?? '' } });
  let task = null;
  if (input.status === 'accepted' && input.createTask) task = await addTask(tx, actor, c.id, { ...input.createTask, recommendationId: r.id });
  await audit('case.recommendation.decided', actor, 'CaseRecommendation', r.id, `Recommendation ${input.status}`, { caseId: c.id, pattern: r.pattern, taskCreated: task ? 1 : 0 });
  return { recommendation: decided, task };
}

// --- Retention policy ---------------------------------------------------------

export async function setRetentionPolicy(actor: CaseActor, input: { caseNoteDays: number; closedCaseDays: number; note?: string }) {
  if (actor.role !== 'admin') throw new CaseError('Only an administrator sets the retention policy.', 403);
  for (const [k, v] of Object.entries({ caseNoteDays: input.caseNoteDays, closedCaseDays: input.closedCaseDays })) {
    if (!Number.isInteger(v) || v < 30 || v > 3650) throw new CaseError(`${k} must be a whole number of days between 30 and 3650.`, 422);
  }
  const row = await db.retentionPolicy.upsert({
    where: { organizationId: actor.organizationId },
    create: { organizationId: actor.organizationId, caseNoteDays: input.caseNoteDays, closedCaseDays: input.closedCaseDays, note: input.note?.trim() ?? '', setById: actor.user.id, setByEmail: actor.user.email },
    update: { caseNoteDays: input.caseNoteDays, closedCaseDays: input.closedCaseDays, note: input.note?.trim() ?? '', setById: actor.user.id, setByEmail: actor.user.email },
  });
  await audit('case.retention.set', actor, 'RetentionPolicy', row.id, 'Retention policy set', { caseNoteDays: input.caseNoteDays, closedCaseDays: input.closedCaseDays });
  return row;
}

/**
 * Apply every organisation's retention policy: notes and assessments older
 * than `caseNoteDays`, closed cases (with everything under them) closed
 * longer ago than `closedCaseDays`. An organisation WITHOUT a policy is
 * untouched - a public-body contract may require records kept, and
 * nothing is destroyed on a platform default. Audited per organisation
 * with counts. No scheduler runs this; `npm run cases:retention` does.
 */
export async function purgeExpiredCaseRecords(now = new Date()): Promise<{ organizations: number; notes: number; assessments: number; cases: number }> {
  const policies = await db.retentionPolicy.findMany();
  let notes = 0;
  let assessments = 0;
  let cases = 0;
  for (const p of policies) {
    const noteCutoff = new Date(now.getTime() - p.caseNoteDays * 86_400_000);
    const caseCutoff = new Date(now.getTime() - p.closedCaseDays * 86_400_000);
    const r = await db.$transaction(async (tx) => {
      const n = await tx.caseNote.deleteMany({ where: { organizationId: p.organizationId, createdAt: { lt: noteCutoff } } });
      const a = await tx.caseAssessment.deleteMany({ where: { organizationId: p.organizationId, createdAt: { lt: noteCutoff } } });
      const c = await tx.case.deleteMany({ where: { organizationId: p.organizationId, status: 'closed', closedAt: { lt: caseCutoff } } });
      return { n: n.count, a: a.count, c: c.count };
    });
    notes += r.n;
    assessments += r.a;
    cases += r.c;
    if (r.n || r.a || r.c) {
      await recordSecurityEvent({ event: 'case.retention.purged', actor: { type: 'system' }, entityType: 'Organization', entityId: p.organizationId, summary: 'Case records purged under the retention policy', detail: { notes: r.n, assessments: r.a, cases: r.c, caseNoteDays: p.caseNoteDays, closedCaseDays: p.closedCaseDays } }, db, { strict: true });
    }
  }
  return { organizations: policies.length, notes, assessments, cases };
}
