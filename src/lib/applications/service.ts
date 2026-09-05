import type { Application, Prisma } from '@prisma/client';
import { db } from '../db';
import type { ApplicationStatus } from '../types';
import { canTransition, describeRefusal, isApplicationStatus, outcomeFor } from './status-machine';
import { redactError } from '@/lib/log';

/**
 * Stage 10 — the application folder service. Every write goes through a
 * tenant transaction (`run` / `withTenant`): the caller's `userId` filters
 * the row, and RLS backstops it. Every write is audited with ids and kinds
 * only — a note's body, a contact's name or email never reaches AuditLog.
 *
 * WHY THE AUDIT IS BUFFERED
 * `AuditLog` is a system-only table: the tenant role cannot insert into it
 * (Stage 01), so an audit row cannot be written inside the tenant
 * transaction that makes the change. The service therefore records each
 * entry on the actor and the caller flushes them on the system client
 * AFTER the transaction commits (`flushAudit`). A change that rolls back
 * leaves no audit entry; an audit write that fails after a commit is logged
 * loudly and does not undo the change — the audit is traceability, not a
 * precondition, the same stance as the gateway's AiRun row.
 */
export class ApplicationStateError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = 'ApplicationStateError';
  }
}

export type Tx = Prisma.TransactionClient;

export interface AuditEntry {
  action: string;
  applicationId: string;
  summary: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  reason: string | null;
}

export interface Actor {
  id: string;
  email?: string;
  /** Pending audit entries, flushed by `flushAudit` after the transaction commits. */
  audit: AuditEntry[];
}

export function folderActor(user: { id: string; email?: string | null }): Actor {
  return { id: user.id, email: user.email ?? undefined, audit: [] };
}

async function owned(tx: Tx, userId: string, applicationId: string): Promise<Application> {
  const application = await tx.application.findFirst({ where: { id: applicationId, userId } });
  if (!application) throw new ApplicationStateError('Application not found.', 404);
  return application;
}

async function audit(_tx: Tx, actor: Actor, action: string, applicationId: string, summary: string, before: Record<string, unknown>, after: Record<string, unknown>, reason: string | null = null): Promise<void> {
  actor.audit.push({ action, applicationId, summary, before, after, reason });
}

/** Write the actor's pending audit entries on the system client. Call after the transaction has committed. */
export async function flushAudit(actor: Actor): Promise<void> {
  const entries = actor.audit.splice(0, actor.audit.length);
  for (const e of entries) {
    try {
      await db.auditLog.create({
        data: {
          actorType: 'user',
          actorId: actor.id,
          actorEmail: actor.email ?? '',
          actorRole: 'user',
          action: e.action,
          entityType: 'Application',
          entityId: e.applicationId,
          summary: e.summary,
          before: JSON.stringify(e.before),
          after: JSON.stringify(e.after),
          changedFields: JSON.stringify(Object.keys(e.after)),
          reason: e.reason,
        },
      });
    } catch (error) {
      console.error(`[applications] failed to record ${e.action} for ${e.applicationId}:`, redactError(error).message);
    }
  }
}

async function touch(tx: Tx, applicationId: string, at = new Date()): Promise<void> {
  await tx.application.update({ where: { id: applicationId }, data: { lastActivityAt: at } });
}

// --- status ---------------------------------------------------------------------

export interface TransitionOptions {
  actor: 'applicant' | 'system';
  source: 'ui' | 'applicator' | 'confirm' | 'api' | 'ats_api';
  reason?: string | null;
  /** For a move to `rejected`. */
  rejectionReason?: string | null;
  at?: Date;
}

/**
 * Move an application to `to`, or refuse. The row update and the history row
 * commit together. A move to the same status is a no-op (idempotent retries).
 */
export async function transitionApplication(tx: Tx, actor: Actor, applicationId: string, to: ApplicationStatus, options: TransitionOptions): Promise<Application> {
  const application = await owned(tx, actor.id, applicationId);
  const from = application.status as ApplicationStatus;
  if (!isApplicationStatus(to)) throw new ApplicationStateError('That is not an application status.');
  if (from === to) return application;
  if (!canTransition(from, to)) throw new ApplicationStateError(describeRefusal(from, to));
  const at = options.at ?? new Date();
  const outcome = outcomeFor(to);
  const updated = await tx.application.update({
    where: { id: application.id },
    data: {
      status: to,
      lastActivityAt: at,
      appliedAt: to === 'submitted' && !application.appliedAt ? at : application.appliedAt,
      respondedAt: ['interviewing', 'offer', 'rejected'].includes(to) && !application.respondedAt ? at : application.respondedAt,
      rejectedAt: to === 'rejected' ? at : application.rejectedAt,
      rejectionReason: to === 'rejected' ? (options.rejectionReason ?? application.rejectionReason ?? 'not_selected') : application.rejectionReason,
      outcome: outcome ?? application.outcome,
      outcomeAt: outcome ? at : application.outcomeAt,
    },
  });
  await tx.applicationStatusHistory.create({
    data: { userId: actor.id, applicationId: application.id, fromStatus: from, toStatus: to, actor: options.actor, source: options.source, reason: options.reason ?? null, at },
  });
  await audit(tx, actor, 'application.status', application.id, `Application moved from ${from} to ${to}.`, { status: from }, { status: to }, options.reason ?? null);
  return updated;
}

/** The first history row: how the record came into being. */
export async function recordInitialStatus(tx: Tx, userId: string, applicationId: string, status: string, source: TransitionOptions['source'], at = new Date()): Promise<void> {
  await tx.applicationStatusHistory.create({ data: { userId, applicationId, fromStatus: '', toStatus: status, actor: 'system', source, at } });
}

// --- offer and outcome ------------------------------------------------------------

export interface OfferInput {
  receivedAt?: Date | null;
  deadline?: Date | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency?: string | null;
  decision?: 'pending' | 'accepted' | 'declined' | null;
}

/** Record or update the offer; an accepted offer settles the outcome as hired, a declined one as declined. */
export async function recordOffer(tx: Tx, actor: Actor, applicationId: string, offer: OfferInput): Promise<Application> {
  const application = await owned(tx, actor.id, applicationId);
  if (application.status !== 'offer') throw new ApplicationStateError('Record the offer once the application is at offer.');
  const at = new Date();
  const decision = offer.decision ?? application.offerDecision ?? 'pending';
  const decided = decision !== 'pending';
  const updated = await tx.application.update({
    where: { id: application.id },
    data: {
      offerReceivedAt: offer.receivedAt === undefined ? (application.offerReceivedAt ?? at) : offer.receivedAt,
      offerDeadline: offer.deadline === undefined ? application.offerDeadline : offer.deadline,
      offerSalaryMin: offer.salaryMin === undefined ? application.offerSalaryMin : offer.salaryMin,
      offerSalaryMax: offer.salaryMax === undefined ? application.offerSalaryMax : offer.salaryMax,
      offerCurrency: offer.currency === undefined ? application.offerCurrency : offer.currency,
      offerDecision: decision,
      offerDecidedAt: decided ? (application.offerDecidedAt ?? at) : null,
      outcome: decision === 'accepted' ? 'hired' : decision === 'declined' ? 'declined' : application.outcome,
      outcomeAt: decided ? (application.outcomeAt ?? at) : application.outcomeAt,
      lastActivityAt: at,
    },
  });
  await audit(tx, actor, 'application.offer', application.id, `Offer ${decided ? decision : 'recorded'}.`, { offerDecision: application.offerDecision }, { offerDecision: decision, hasSalary: offer.salaryMin != null || offer.salaryMax != null });
  return updated;
}

/** No response, or the posting expired: a structured outcome without a status change. */
export async function recordOutcome(tx: Tx, actor: Actor, applicationId: string, outcome: 'ghosted' | 'expired' | 'pending', reason: string | null = null): Promise<Application> {
  const application = await owned(tx, actor.id, applicationId);
  if (['rejected', 'withdrawn'].includes(application.status)) throw new ApplicationStateError('The outcome of a closed application is fixed by its status.');
  const at = new Date();
  const updated = await tx.application.update({ where: { id: application.id }, data: { outcome, outcomeAt: outcome === 'pending' ? null : at, lastActivityAt: at } });
  await audit(tx, actor, 'application.outcome', application.id, `Outcome set to ${outcome}.`, { outcome: application.outcome }, { outcome }, reason);
  return updated;
}

// --- children ---------------------------------------------------------------------

export interface ContactInput {
  role: 'hiring_manager' | 'recruiter' | 'referral' | 'other';
  name: string;
  email?: string | null;
  phone?: string | null;
  organisation?: string | null;
  notes?: string;
}

export async function addContact(tx: Tx, actor: Actor, applicationId: string, input: ContactInput) {
  await owned(tx, actor.id, applicationId);
  const row = await tx.applicationContact.create({ data: { userId: actor.id, applicationId, role: input.role, name: input.name, email: input.email ?? null, phone: input.phone ?? null, organisation: input.organisation ?? null, notes: input.notes ?? '' } });
  await touch(tx, applicationId);
  await audit(tx, actor, 'application.contact.added', applicationId, `Contact added (${input.role}).`, {}, { contactId: row.id, role: input.role });
  return row;
}

export async function updateContact(tx: Tx, actor: Actor, applicationId: string, contactId: string, input: Partial<ContactInput>) {
  const existing = await tx.applicationContact.findFirst({ where: { id: contactId, applicationId, userId: actor.id } });
  if (!existing) throw new ApplicationStateError('Contact not found.', 404);
  const row = await tx.applicationContact.update({ where: { id: contactId }, data: { ...(input.role ? { role: input.role } : {}), ...(input.name ? { name: input.name } : {}), ...(input.email !== undefined ? { email: input.email } : {}), ...(input.phone !== undefined ? { phone: input.phone } : {}), ...(input.organisation !== undefined ? { organisation: input.organisation } : {}), ...(input.notes !== undefined ? { notes: input.notes } : {}) } });
  await touch(tx, applicationId);
  await audit(tx, actor, 'application.contact.updated', applicationId, 'Contact updated.', { contactId, role: existing.role }, { contactId, role: row.role });
  return row;
}

export async function removeContact(tx: Tx, actor: Actor, applicationId: string, contactId: string): Promise<void> {
  const existing = await tx.applicationContact.findFirst({ where: { id: contactId, applicationId, userId: actor.id } });
  if (!existing) throw new ApplicationStateError('Contact not found.', 404);
  await tx.applicationContact.delete({ where: { id: contactId } });
  await touch(tx, applicationId);
  await audit(tx, actor, 'application.contact.removed', applicationId, 'Contact removed.', { contactId, role: existing.role }, {});
}

export interface InterviewInput {
  kind: 'phone' | 'video' | 'onsite' | 'panel' | 'technical' | 'other';
  scheduledAt: Date;
  durationMinutes?: number | null;
  location?: string | null;
  interviewers?: string[];
  notes?: string;
  outcome?: 'scheduled' | 'completed' | 'cancelled' | 'no_show';
  result?: 'pending' | 'advanced' | 'not_advanced';
}

export async function addInterview(tx: Tx, actor: Actor, applicationId: string, input: InterviewInput) {
  const application = await owned(tx, actor.id, applicationId);
  if (!['submitted', 'interviewing', 'offer'].includes(application.status)) throw new ApplicationStateError('An interview belongs to an application the employer has.');
  const row = await tx.applicationInterview.create({
    data: { userId: actor.id, applicationId, kind: input.kind, scheduledAt: input.scheduledAt, durationMinutes: input.durationMinutes ?? null, location: input.location ?? null, interviewers: JSON.stringify(input.interviewers ?? []), notes: input.notes ?? '', outcome: input.outcome ?? 'scheduled', result: input.result ?? 'pending' },
  });
  // The first interview moves a submitted application to interviewing, with its own history row.
  if (application.status === 'submitted') await transitionApplication(tx, actor, applicationId, 'interviewing', { actor: 'applicant', source: 'ui', reason: 'interview scheduled' });
  else await touch(tx, applicationId);
  await audit(tx, actor, 'application.interview.added', applicationId, `Interview added (${input.kind}).`, {}, { interviewId: row.id, kind: input.kind, scheduledAt: input.scheduledAt.toISOString() });
  return row;
}

export async function updateInterview(tx: Tx, actor: Actor, applicationId: string, interviewId: string, input: Partial<InterviewInput>) {
  const existing = await tx.applicationInterview.findFirst({ where: { id: interviewId, applicationId, userId: actor.id } });
  if (!existing) throw new ApplicationStateError('Interview not found.', 404);
  const row = await tx.applicationInterview.update({
    where: { id: interviewId },
    data: {
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
      ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.interviewers ? { interviewers: JSON.stringify(input.interviewers) } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(input.result ? { result: input.result } : {}),
    },
  });
  await touch(tx, applicationId);
  await audit(tx, actor, 'application.interview.updated', applicationId, 'Interview updated.', { interviewId, outcome: existing.outcome, result: existing.result }, { interviewId, outcome: row.outcome, result: row.result });
  return row;
}

export interface AssessmentInput {
  kind: 'take_home' | 'online_test' | 'case_study' | 'presentation' | 'other';
  dueAt?: Date | null;
  submittedAt?: Date | null;
  result?: 'pending' | 'passed' | 'failed';
  notes?: string;
}

export async function addAssessment(tx: Tx, actor: Actor, applicationId: string, input: AssessmentInput) {
  const application = await owned(tx, actor.id, applicationId);
  if (!['submitted', 'interviewing', 'offer'].includes(application.status)) throw new ApplicationStateError('An assessment belongs to an application the employer has.');
  const row = await tx.applicationAssessment.create({ data: { userId: actor.id, applicationId, kind: input.kind, dueAt: input.dueAt ?? null, submittedAt: input.submittedAt ?? null, result: input.result ?? 'pending', notes: input.notes ?? '' } });
  await touch(tx, applicationId);
  await audit(tx, actor, 'application.assessment.added', applicationId, `Assessment added (${input.kind}).`, {}, { assessmentId: row.id, kind: input.kind });
  return row;
}

export async function updateAssessment(tx: Tx, actor: Actor, applicationId: string, assessmentId: string, input: Partial<AssessmentInput>) {
  const existing = await tx.applicationAssessment.findFirst({ where: { id: assessmentId, applicationId, userId: actor.id } });
  if (!existing) throw new ApplicationStateError('Assessment not found.', 404);
  const row = await tx.applicationAssessment.update({
    where: { id: assessmentId },
    data: { ...(input.kind ? { kind: input.kind } : {}), ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}), ...(input.submittedAt !== undefined ? { submittedAt: input.submittedAt } : {}), ...(input.result ? { result: input.result } : {}), ...(input.notes !== undefined ? { notes: input.notes } : {}) },
  });
  await touch(tx, applicationId);
  await audit(tx, actor, 'application.assessment.updated', applicationId, 'Assessment updated.', { assessmentId, result: existing.result }, { assessmentId, result: row.result });
  return row;
}

export interface FollowUpInput {
  dueAt: Date;
  channel: 'email' | 'phone' | 'linkedin' | 'portal' | 'other';
  note?: string;
  documentVersionId?: string | null;
}

export async function addFollowUp(tx: Tx, actor: Actor, applicationId: string, input: FollowUpInput) {
  await owned(tx, actor.id, applicationId);
  if (input.documentVersionId) {
    const doc = await tx.documentVersion.findFirst({ where: { id: input.documentVersionId, userId: actor.id, applicationId }, select: { id: true } });
    if (!doc) throw new ApplicationStateError('That drafted message does not belong to this application.', 404);
  }
  const row = await tx.applicationFollowUp.create({ data: { userId: actor.id, applicationId, dueAt: input.dueAt, channel: input.channel, note: input.note ?? '', documentVersionId: input.documentVersionId ?? null } });
  await touch(tx, applicationId);
  await audit(tx, actor, 'application.follow_up.added', applicationId, `Follow-up planned (${input.channel}).`, {}, { followUpId: row.id, channel: input.channel, dueAt: input.dueAt.toISOString() });
  return row;
}

export async function completeFollowUp(tx: Tx, actor: Actor, applicationId: string, followUpId: string, doneAt = new Date()) {
  const existing = await tx.applicationFollowUp.findFirst({ where: { id: followUpId, applicationId, userId: actor.id } });
  if (!existing) throw new ApplicationStateError('Follow-up not found.', 404);
  const row = await tx.applicationFollowUp.update({ where: { id: followUpId }, data: { doneAt } });
  await touch(tx, applicationId, doneAt);
  await audit(tx, actor, 'application.follow_up.done', applicationId, 'Follow-up done.', { followUpId, doneAt: existing.doneAt?.toISOString() ?? null }, { followUpId, doneAt: doneAt.toISOString() });
  return row;
}

export async function addNote(tx: Tx, actor: Actor, applicationId: string, body: string) {
  await owned(tx, actor.id, applicationId);
  const row = await tx.applicationNote.create({ data: { userId: actor.id, applicationId, body } });
  await touch(tx, applicationId);
  await audit(tx, actor, 'application.note.added', applicationId, 'Note added.', {}, { noteId: row.id, length: body.length });
  return row;
}

/** The folder page: the application with everything the answer needs, on the tenant path. */
export function folderInclude() {
  return {
    job: true,
    interviewPrep: true,
    documents: { orderBy: [{ kind: 'asc' as const }, { format: 'asc' as const }, { version: 'desc' as const }] },
    statusHistory: { orderBy: { at: 'asc' as const } },
    contacts: { orderBy: { createdAt: 'asc' as const } },
    interviews: { orderBy: { scheduledAt: 'asc' as const } },
    assessments: { orderBy: { createdAt: 'asc' as const } },
    followUps: { orderBy: { dueAt: 'asc' as const } },
    crmNotes: { orderBy: { createdAt: 'desc' as const } },
    // Stage 11: what was filed here (automatically or by the applicant); suggestions are queried separately.
    emailThreads: { where: { associationStatus: { in: ['auto', 'confirmed'] } }, orderBy: { lastMessageAt: 'desc' as const } },
    calendarEvents: { where: { associationStatus: { in: ['auto', 'confirmed'] } }, orderBy: { startsAt: 'asc' as const } },
  };
}
