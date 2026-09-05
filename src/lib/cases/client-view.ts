/**
 * Stage 17 (ADR-0032) - what a case manager may see of a CONSENTED client's
 * job search, and the signals the copilot reads.
 *
 * The client's rows are the client's (RLS `user`): the case manager's tenant
 * context cannot see them, by design. So this is a DELEGATED read on the
 * system client, allowed only after four checks - the actor is a member of
 * the case's organisation with a role that may open the case, the case is
 * OPEN and linked to the person, and THE CASE'S OWN consent record is
 * current (never "any consent for the purpose": a person may have consented
 * to another provider, and withdrawing from one must close exactly that one
 * - Stage 17 review, M2) - and audited FIRST,
 * strictly (`case.client.read`, ids and kinds only). It reads application
 * counts and statuses, interviews, eligibility rule outcomes, compatibility
 * dimensions, whether a résumé exists, the target titles and locations the
 * client set, and this deployment's postings for the target. It NEVER reads
 * the sensitive schema, a case note, an assessment or a barrier, and
 * nothing here is written (a static test holds this file and copilot.ts to
 * that).
 */
import { db } from '@/lib/db';
import { marketSignal } from '@/lib/career/service';
import { recordSecurityEvent } from '@/lib/security-audit';
import { canOpenCase } from './roles';
import { CaseError, type CaseActor } from './service';
import type { ClientSignals } from './copilot';
import { assertNotImpersonating } from '@/lib/auth';

export interface ClientSummary {
  client: { name: string; country: string | null; city: string | null };
  applications: { id: string; status: string; title: string; company: string; createdAt: string }[];
  counts: ClientSignals['applications'];
  interviews: { scheduledAt: string; kind: string; title: string }[];
  resume: { exists: boolean; versions: number };
  profile: ClientSignals['profile'] & { targetTitles: string[] };
  eligibility: ClientSignals['eligibility'];
  market: ClientSignals['market'];
  lastActivityAt: string | null;
}

/** The consented, open case, or a refusal. Read before anything about the client is. */
async function delegated(actor: CaseActor, caseId: string, purpose: 'summary' | 'copilot') {
  const c = await db.case.findFirst({ where: { id: caseId, organizationId: actor.organizationId } });
  if (!c || !canOpenCase(actor.role, c, actor.user.id)) throw new CaseError('Case not found.', 404);
  if (c.status !== 'open' || !c.consentedAt || !c.clientUserId || !c.consentRecordId) throw new CaseError('The client has not consented, or the case is not open; nothing about them is read.', 403);
  const consent = await db.consentRecord.findFirst({ where: { id: c.consentRecordId, userId: c.clientUserId, purpose: 'employment_services_case', revokedAt: null }, select: { id: true } });
  if (!consent) throw new CaseError('The client withdrew consent; nothing about them is read.', 403);
  await recordSecurityEvent(
    { event: 'case.client.read', actor: { type: 'user', id: actor.user.id, email: actor.user.email, role: `case:${actor.role}` }, entityType: 'Case', entityId: c.id, summary: `Client job-search data read (${purpose})`, detail: { organizationId: actor.organizationId, clientUserId: c.clientUserId, purpose }, meta: actor.meta },
    db,
    { strict: true },
  );
  return { ...c, clientUserId: c.clientUserId };
}

function parseArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const RESPONDED = new Set(['interviewing', 'offer']);
const SUBMITTED = new Set(['submitted', 'interviewing', 'offer', 'rejected']);

export async function collectClientSignals(clientUserId: string, targetOccupationId: string | null, now = new Date()): Promise<ClientSignals> {
  const since30 = new Date(now.getTime() - 30 * 86_400_000);
  const [applications, history, interviews, resume, prefs, skillsCount, eligibility, dimensions, activity] = await Promise.all([
    db.application.findMany({ where: { userId: clientUserId }, select: { id: true, status: true, createdAt: true } }),
    db.applicationStatusHistory.findMany({ where: { userId: clientUserId }, select: { applicationId: true, toStatus: true, at: true } }),
    db.applicationInterview.count({ where: { userId: clientUserId } }),
    db.resume.findFirst({ where: { userId: clientUserId }, select: { id: true } }),
    db.careerPreferences.findUnique({ where: { userId: clientUserId }, select: { targetTitles: true, locations: true, relocation: true } }),
    db.candidateSkill.count({ where: { userId: clientUserId } }),
    db.eligibilityResult.findMany({ where: { userId: clientUserId }, select: { rules: true } }),
    db.matchDimension.findMany({ where: { userId: clientUserId }, select: { jobMatchId: true, dimension: true, score: true, missing: true } }),
    db.activityEvent.findFirst({ where: { userId: clientUserId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ]);
  const reached = (set: Set<string>) => new Set(history.filter((h) => set.has(h.toStatus)).map((h) => h.applicationId));
  const submittedIds = reached(SUBMITTED);
  const respondedIds = reached(RESPONDED);
  const submitted30d = new Set(history.filter((h) => h.toStatus === 'submitted' && h.at >= since30).map((h) => h.applicationId)).size;
  const failsByRule: Record<string, number> = {};
  const certs = new Map<string, number>();
  for (const r of eligibility) {
    let rules: { rule: string; status: string; reason: string }[] = [];
    try {
      rules = JSON.parse(r.rules) as typeof rules;
    } catch {
      rules = [];
    }
    for (const rule of rules) {
      if (rule.status !== 'fail') continue;
      failsByRule[rule.rule] = (failsByRule[rule.rule] ?? 0) + 1;
      if (rule.rule === 'licensure') {
        const m = /requires? (?:the |a |an )?([^.;]+?)(?: (?:licence|designation|certification))?[.;]/i.exec(rule.reason);
        if (m?.[1]) certs.set(m[1].trim(), (certs.get(m[1].trim()) ?? 0) + 1);
      }
    }
  }
  const byMatch = new Map<string, Map<string, { score: number; missing: string[] }>>();
  for (const d of dimensions) {
    if (!byMatch.has(d.jobMatchId)) byMatch.set(d.jobMatchId, new Map());
    byMatch.get(d.jobMatchId)!.set(d.dimension, { score: d.score, missing: parseArray(d.missing) });
  }
  const low = (dimension: string) => [...byMatch.values()].filter((m) => (m.get(dimension)?.score ?? 100) < 40).length;
  const missingSkills = new Map<string, number>();
  for (const m of byMatch.values()) for (const s of m.get('skills')?.missing ?? []) missingSkills.set(s, (missingSkills.get(s) ?? 0) + 1);
  const market = targetOccupationId ? await marketSignal(db, targetOccupationId, now) : null;
  return {
    daysSinceActivity: activity ? Math.floor((now.getTime() - activity.createdAt.getTime()) / 86_400_000) : null,
    applications: {
      total: applications.length,
      submitted: submittedIds.size,
      responded: respondedIds.size,
      interviews,
      offers: applications.filter((a) => a.status === 'offer').length,
      submitted30d,
    },
    eligibility: { evaluated: eligibility.length, failsByRule, certificationsNamed: [...certs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k) },
    matching: { scored: byMatch.size, seniorityLow: low('seniority'), skillsLow: low('skills'), keywordsLow: low('keywords'), missingSkills: [...missingSkills.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k) },
    profile: { hasResume: resume !== null, skillsCount, hasTargetTitles: parseArray(prefs?.targetTitles ?? '[]').length > 0, locationsCount: parseArray(prefs?.locations ?? '[]').length, relocation: prefs?.relocation ?? 'no' },
    market: { targetOccupationSet: targetOccupationId !== null, postingsOpen: market ? market.postingsOpen : null },
  };
}

/** The client summary a case manager sees on the case page. */
export async function readClientSummary(actor: CaseActor, caseId: string, now = new Date()): Promise<ClientSummary> {
  await assertNotImpersonating('a client\'s job-search data');
  const c = await delegated(actor, caseId, 'summary');
  const [user, applications, interviews, versions, prefs, signals] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: c.clientUserId }, select: { fullName: true, country: true, city: true } }),
    db.application.findMany({ where: { userId: c.clientUserId }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, status: true, createdAt: true, job: { select: { title: true, company: true } } } }),
    db.applicationInterview.findMany({ where: { userId: c.clientUserId, scheduledAt: { gte: now } }, orderBy: { scheduledAt: 'asc' }, take: 5, select: { scheduledAt: true, kind: true, application: { select: { job: { select: { title: true } } } } } }),
    db.documentVersion.count({ where: { userId: c.clientUserId } }),
    db.careerPreferences.findUnique({ where: { userId: c.clientUserId }, select: { targetTitles: true } }),
    collectClientSignals(c.clientUserId, c.targetOccupationId, now),
  ]);
  const last = await db.activityEvent.findFirst({ where: { userId: c.clientUserId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  return {
    client: { name: user.fullName, country: user.country, city: user.city },
    applications: applications.map((a) => ({ id: a.id, status: a.status, title: a.job.title, company: a.job.company, createdAt: a.createdAt.toISOString() })),
    counts: signals.applications,
    interviews: interviews.map((i) => ({ scheduledAt: i.scheduledAt.toISOString(), kind: i.kind, title: i.application.job.title })),
    resume: { exists: signals.profile.hasResume, versions },
    profile: { ...signals.profile, targetTitles: parseArray(prefs?.targetTitles ?? '[]') },
    eligibility: signals.eligibility,
    market: signals.market,
    lastActivityAt: last?.createdAt.toISOString() ?? null,
  };
}

/** The signals for the copilot, after the same four checks and its own audit row. */
export async function clientSignalsFor(actor: CaseActor, caseId: string, now = new Date()): Promise<{ caseId: string; signals: ClientSignals }> {
  await assertNotImpersonating('a client\'s job-search data');
  const c = await delegated(actor, caseId, 'copilot');
  return { caseId: c.id, signals: await collectClientSignals(c.clientUserId, c.targetOccupationId, now) };
}
