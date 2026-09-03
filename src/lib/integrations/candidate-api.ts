/**
 * Stage 14 (ADR-0013, ADR-0028) - the candidate surface of /api/v1: the
 * loaders and serialisers behind the OpenAPI contract in
 * docs/api/openapi.candidate.v1.json. Every function takes the key's userId
 * and establishes ownership through it (JobMatch through its agent), and
 * every shape here is mirrored by a component schema in the contract - the
 * contract test validates each response against it.
 *
 * What is NOT here, deliberately: document bytes (signed links stay on the
 * web app), billing, anything staff-only, and any write that submits an
 * application on its own - the two writes are the applicant's own
 * confirmation and their instructed submission (Stage 12), scope apply:write.
 */
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { parseJson } from '@/lib/types';
import { notIneligibleFor, toVerdict } from '@/lib/eligibility/service';
import { folderCompleteness } from '@/lib/applications/folder';
import { serialiseApplication, serialiseJobMatch, type PublicApplication, type PublicJob } from './public-api';
import type { Pagination } from './http';

// --- profile ------------------------------------------------------------------

export interface PublicMe {
  object: 'me';
  id: string;
  fullName: string;
  email: string;
  country: string;
  city: string | null;
  headline: string | null;
  applicationMode: string;
  createdAt: string;
}

export async function loadMe(userId: string): Promise<PublicMe | null> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { id: true, fullName: true, email: true, country: true, city: true, headline: true, applicationMode: true, createdAt: true } });
  if (!u) return null;
  return { object: 'me', id: u.id, fullName: u.fullName, email: u.email, country: u.country, city: u.city, headline: u.headline, applicationMode: u.applicationMode, createdAt: u.createdAt.toISOString() };
}

// --- recommendations and job detail --------------------------------------------

const JOB_SELECT = {
  id: true, title: true, company: true, companyLogo: true, location: true, country: true, workMode: true, jobType: true, salaryMin: true, salaryMax: true, salaryCurrency: true, source: true, applyUrl: true, applyMethod: true, skills: true, requirements: true, nocCode: true, postedAt: true, activeState: true, closedAt: true,
} as const;

/** The best open, eligible, not-yet-acted-on matches - what a mobile home screen shows first. */
export async function listRecommendations(userId: string, pagination: Pagination): Promise<{ data: PublicJob[]; total: number }> {
  const where = { agent: { userId }, status: 'new', job: { activeState: { not: 'closed' }, ...notIneligibleFor(userId) } };
  const [total, rows] = await db.$transaction([
    db.jobMatch.count({ where }),
    db.jobMatch.findMany({ where, orderBy: [{ matchScore: 'desc' }, { createdAt: 'desc' }], skip: pagination.offset, take: pagination.limit, include: { agent: { select: { name: true } }, job: { select: JOB_SELECT } } }),
  ]);
  return { data: rows.map(serialiseJobMatch), total };
}

export interface PublicEligibilityRule {
  rule: string;
  status: string;
  reason: string;
}

export interface PublicJobDetail extends PublicJob {
  description: string;
  activeState: string;
  closedAt: string | null;
  eligibility: { outcome: string; evaluatedAt: string; rules: PublicEligibilityRule[] } | null;
}

/** One posting the caller's agents matched, with its text and the caller's eligibility verdict. Ownership through the match. */
export async function loadJobDetail(userId: string, jobId: string): Promise<PublicJobDetail | null> {
  const match = await db.jobMatch.findFirst({
    where: { jobId, agent: { userId } },
    orderBy: [{ matchScore: 'desc' }, { createdAt: 'desc' }],
    include: { agent: { select: { name: true } }, job: { select: { ...JOB_SELECT, description: true } } },
  });
  if (!match) return null;
  const verdict = await db.eligibilityResult.findFirst({ where: { userId, jobId }, orderBy: { evaluatedAt: 'desc' } });
  const base = serialiseJobMatch(match);
  return {
    ...base,
    description: match.job.description,
    activeState: match.job.activeState,
    closedAt: match.job.closedAt?.toISOString() ?? null,
    eligibility: verdict
      ? { outcome: verdict.outcome, evaluatedAt: verdict.evaluatedAt.toISOString(), rules: toVerdict(verdict).rules.map((r) => ({ rule: r.rule, status: r.status, reason: r.reason })) }
      : null,
  };
}

// --- match analysis --------------------------------------------------------------

export interface PublicMatchDimension {
  dimension: string;
  score: number;
  weight: number;
  contribution: number;
  matched: string[];
  missing: string[];
  evidenceIds: string[];
  note: string;
}

export interface PublicMatchAnalysis {
  object: 'match_analysis';
  id: string;
  jobId: string;
  agentId: string;
  score: number;
  status: string;
  weightVersion: string;
  pipelineVersion: string;
  rationale: string;
  matchedKeywords: string[];
  missingKeywords: string[];
  dimensions: PublicMatchDimension[];
  matchedAt: string;
}

/** Why a posting scored what it did: the Stage 08 dimensions with their cited evidence ids. */
export async function loadMatchAnalysis(userId: string, matchId: string): Promise<PublicMatchAnalysis | null> {
  const m = await db.jobMatch.findFirst({ where: { id: matchId, agent: { userId } }, include: { dimensions: { orderBy: { dimension: 'asc' } } } });
  if (!m) return null;
  return {
    object: 'match_analysis',
    id: m.id,
    jobId: m.jobId,
    agentId: m.agentId,
    score: m.matchScore,
    status: m.status,
    weightVersion: m.weightVersion,
    pipelineVersion: m.pipelineVersion,
    rationale: m.rationale,
    matchedKeywords: parseJson<string[]>(m.matchedKeywords, []),
    missingKeywords: parseJson<string[]>(m.missingKeywords, []),
    dimensions: m.dimensions.map((d) => ({ dimension: d.dimension, score: d.score, weight: d.weight, contribution: d.contribution, matched: parseJson<string[]>(d.matched, []), missing: parseJson<string[]>(d.missing, []), evidenceIds: parseJson<string[]>(d.evidenceIds, []), note: d.note })),
    matchedAt: m.createdAt.toISOString(),
  };
}

// --- the folder ------------------------------------------------------------------

export interface PublicInterview {
  object: 'interview';
  id: string;
  applicationId: string;
  kind: string;
  scheduledAt: string;
  result: string;
  createdAt: string;
  job: { id: string; title: string; company: string } | null;
}

export interface PublicApplicationDetail extends PublicApplication {
  outcome: string;
  outcomeAt: string | null;
  rejectionReason: string | null;
  applicationMode: string;
  fieldMappingVersion: string;
  atsSubmittable: boolean;
  preparedFields: { key: string; label: string; value: string; multiline: boolean }[];
  preparedQuestions: { id: string; question: string; decision: string; policy: string; value: string }[];
  history: { fromStatus: string; toStatus: string; actor: string; source: string; reason: string | null; at: string }[];
  contacts: { id: string; role: string; name: string; organisation: string | null }[];
  interviews: PublicInterview[];
  assessments: { id: string; kind: string; dueAt: string | null; submittedAt: string | null; result: string }[];
  followUps: { id: string; dueAt: string; doneAt: string | null; channel: string }[];
  notesCount: number;
  documents: { id: string; kind: string; format: string; version: number; status: string; contentHash: string; sizeBytes: number; createdAt: string }[];
  communications: { threads: number; calendarEvents: number };
  completeness: { complete: boolean; answered: number; answers: { question: string; label: string; ok: boolean; detail: string }[] };
}

const FOLDER_INCLUDE = {
  job: { select: { id: true, title: true, company: true, location: true, country: true, workMode: true, jobType: true, salaryMin: true, salaryMax: true, salaryCurrency: true, source: true, applyUrl: true, postedAt: true } },
  statusHistory: { orderBy: { at: 'asc' as const } },
  contacts: { orderBy: { createdAt: 'asc' as const } },
  interviews: { orderBy: { scheduledAt: 'asc' as const } },
  assessments: { orderBy: { createdAt: 'asc' as const } },
  followUps: { orderBy: { dueAt: 'asc' as const } },
  documents: { orderBy: [{ kind: 'asc' as const }, { format: 'asc' as const }, { version: 'desc' as const }] },
  _count: { select: { crmNotes: true, emailThreads: true, calendarEvents: true } },
} satisfies Prisma.ApplicationInclude;

/** The whole folder, as the tracker shows it - ids, kinds, dates and hashes; never a note body, an address or a document's bytes. */
export async function loadApplicationDetail(userId: string, applicationId: string): Promise<PublicApplicationDetail | null> {
  const a = await db.application.findFirst({ where: { id: applicationId, userId }, include: FOLDER_INCLUDE });
  if (!a) return null;
  const base = serialiseApplication(a);
  const completeness = folderCompleteness({
    status: a.status as Parameters<typeof folderCompleteness>[0]['status'],
    appliedAt: a.appliedAt,
    applyChannel: a.applyChannel,
    confirmation: a.confirmation,
    company: a.job.company,
    sealedDocuments: a.documents.filter((d) => d.status === 'submitted').length,
    hasTextCopies: Boolean(a.tailoredResume.trim() || a.coverLetter.trim()),
    contacts: a.contacts.length,
    historyEntries: a.statusHistory.length,
    interviews: a.interviews.length,
    assessments: a.assessments.length,
    followUps: a.followUps.length,
    outcome: a.outcome,
    respondedAt: a.respondedAt,
  });
  return {
    ...base,
    outcome: a.outcome,
    outcomeAt: a.outcomeAt?.toISOString() ?? null,
    rejectionReason: a.rejectionReason,
    applicationMode: a.applicationMode,
    fieldMappingVersion: a.fieldMappingVersion,
    atsSubmittable: a.atsSubmittable,
    preparedFields: parseJson<{ key: string; label: string; value: string; multiline?: boolean }[]>(a.assistedFields, []).map((f) => ({ key: f.key, label: f.label, value: f.value, multiline: Boolean(f.multiline) })),
    preparedQuestions: parseJson<{ id: string; question: string; decision: string; policy: string; value: string }[]>(a.preparedQuestions, []).map((q) => ({ id: q.id, question: q.question, decision: q.decision, policy: q.policy, value: q.decision === 'never' ? '' : q.value })),
    history: a.statusHistory.map((h) => ({ fromStatus: h.fromStatus, toStatus: h.toStatus, actor: h.actor, source: h.source, reason: h.reason, at: h.at.toISOString() })),
    contacts: a.contacts.map((c) => ({ id: c.id, role: c.role, name: c.name, organisation: c.organisation })),
    interviews: a.interviews.map((i) => serialiseInterview(i, { id: a.job.id, title: a.job.title, company: a.job.company })),
    assessments: a.assessments.map((s) => ({ id: s.id, kind: s.kind, dueAt: s.dueAt?.toISOString() ?? null, submittedAt: s.submittedAt?.toISOString() ?? null, result: s.result })),
    followUps: a.followUps.map((f) => ({ id: f.id, dueAt: f.dueAt.toISOString(), doneAt: f.doneAt?.toISOString() ?? null, channel: f.channel })),
    notesCount: a._count.crmNotes,
    documents: a.documents.map((d) => ({ id: d.id, kind: d.kind, format: d.format, version: d.version, status: d.status, contentHash: d.contentHash, sizeBytes: d.sizeBytes, createdAt: d.createdAt.toISOString() })),
    communications: { threads: a._count.emailThreads, calendarEvents: a._count.calendarEvents },
    completeness: { complete: completeness.complete, answered: completeness.answered, answers: completeness.answers.map((x) => ({ question: x.question, label: x.label, ok: x.ok, detail: x.detail })) },
  };
}

function serialiseInterview(i: { id: string; applicationId: string; kind: string; scheduledAt: Date; result: string; createdAt: Date }, job: PublicInterview['job']): PublicInterview {
  return { object: 'interview', id: i.id, applicationId: i.applicationId, kind: i.kind, scheduledAt: i.scheduledAt.toISOString(), result: i.result, createdAt: i.createdAt.toISOString(), job };
}

/** Every interview across the caller's folders, soonest first. */
export async function listInterviews(userId: string, pagination: Pagination, options: { from?: Date } = {}): Promise<{ data: PublicInterview[]; total: number }> {
  const where = { userId, ...(options.from ? { scheduledAt: { gte: options.from } } : {}) };
  const [total, rows] = await db.$transaction([
    db.applicationInterview.count({ where }),
    db.applicationInterview.findMany({ where, orderBy: { scheduledAt: 'asc' }, skip: pagination.offset, take: pagination.limit, include: { application: { select: { job: { select: { id: true, title: true, company: true } } } } } }),
  ]);
  return { data: rows.map((r) => serialiseInterview(r, r.application.job)), total };
}

// --- notifications ------------------------------------------------------------------

export interface PublicNotification {
  object: 'notification';
  id: string;
  /** activity | integration */
  kind: string;
  type: string;
  message: string;
  applicationId: string | null;
  createdAt: string;
}

/**
 * What happened, newest first: the activity feed and the Stage 11
 * integration events (EMAIL_RECEIVED, INTERVIEW_DETECTED, OFFER_RECEIVED).
 * A payload carries ids only (ADR-0013: no personal data in a notification).
 */
export async function listNotifications(userId: string, pagination: Pagination): Promise<{ data: PublicNotification[]; total: number }> {
  const [activityTotal, integrationTotal] = await db.$transaction([db.activityEvent.count({ where: { userId } }), db.integrationEvent.count({ where: { userId } })]);
  const take = pagination.offset + pagination.limit;
  const [activity, integration] = await db.$transaction([
    db.activityEvent.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take }),
    db.integrationEvent.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take }),
  ]);
  const merged: PublicNotification[] = [
    ...activity.map((e) => ({ object: 'notification' as const, id: e.id, kind: 'activity', type: e.type, message: e.message, applicationId: null, createdAt: e.createdAt.toISOString() })),
    ...integration.map((e) => ({ object: 'notification' as const, id: e.id, kind: 'integration', type: e.type, message: INTEGRATION_MESSAGES[e.type] ?? e.type, applicationId: e.applicationId, createdAt: e.createdAt.toISOString() })),
  ]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    .slice(pagination.offset, pagination.offset + pagination.limit);
  return { data: merged, total: activityTotal + integrationTotal };
}

const INTEGRATION_MESSAGES: Record<string, string> = {
  EMAIL_RECEIVED: 'An employer email was filed to a folder.',
  INTERVIEW_DETECTED: 'An interview was detected in a folder.',
  OFFER_RECEIVED: 'An offer was detected in a folder.',
};
