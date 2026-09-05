/**
 * Stage 18 (ADR-0033) - what an employer sees of a candidate.
 *
 * Two reads, both on the system client (a candidate's rows are the
 * candidate's under RLS), both gated:
 *
 *  - `sourceCandidates`: the anonymised search a recruiter runs for a
 *    requisition. Only candidates whose Stage 02 recruiter visibility is
 *    `anonymous` or `visible` are considered at all; each is scored by the
 *    Stage 08 pipeline against the requisition's posting; a card carries the
 *    score, the matched and missing terms, the region, and - for `visible`
 *    only - the name and headline. Never contact details, never the résumé,
 *    never the sensitive schema. Audited as one run with counts.
 *  - `readDisclosedCandidate`: the profile behind a GRANTED disclosure with a
 *    current consent - the résumé projection and the contact details the
 *    candidate consented to share - audited per read.
 *
 * A static test refuses any reference to the sensitive schema or a case table
 * in this file, and the gateway route stays deterministic (no prompt is
 * `default`, ADR-0006).
 */
import { db } from '@/lib/db';
import { loadResumeContent } from '@/lib/candidate/profile';
import { loadEvidenceForGeneration } from '@/lib/evidence/vault';
import { scoreCompatibility } from '@/lib/matching/pipeline';
import { getActiveWeights } from '@/lib/matching/weights';
import { recordSecurityEvent } from '@/lib/security-audit';
import { LIMITS, rateLimit } from '@/lib/rate-limit';
import { canReadSourcing } from './roles';
import { EmployerError, canSeeCandidate, grantedDisclosure, type EmployerActor } from './service';
import { assertNotImpersonating } from '@/lib/auth';

export interface SourcedCard {
  candidateUserId: string;
  visibility: 'anonymous' | 'visible';
  score: number;
  matched: string[];
  missing: string[];
  /** Region only: city and country for `visible`, country alone for `anonymous`. */
  region: string;
  name: string | null;
  headline: string | null;
  disclosure: 'none' | 'requested' | 'granted' | 'declined' | 'revoked';
  submissionStage: string | null;
}

const SOURCING_CAP = 100;

export async function sourceCandidates(actor: EmployerActor, requisitionId: string, options: { limit?: number } = {}): Promise<{ cards: SourcedCard[]; considered: number }> {
  await assertNotImpersonating('candidate sourcing');
  if (!canReadSourcing(actor.role)) throw new EmployerError('You may not search candidates.', 403);
  const r = await db.requisition.findFirst({ where: { id: requisitionId, organizationId: actor.organizationId }, include: { job: true } });
  if (!r) throw new EmployerError('Requisition not found.', 404);
  if (!r.job || r.status !== 'open') throw new EmployerError('Open the requisition first; sourcing scores candidates against its published posting.', 409);
  if (!rateLimit('employer:sourcing', r.id, LIMITS.employerSourcing).ok) throw new EmployerError('Sourcing for this requisition was run recently; try again in a few minutes.', 429);
  const limit = Math.min(Math.max(options.limit ?? 25, 1), SOURCING_CAP);
  // The sourcing set: candidates who said recruiters may see them, in some form.
  // (`CareerPreferences` has no relation to filter through, so the erased and
  // the not-yet-onboarded are removed by a second read of the user rows.)
  const visible = await db.careerPreferences.findMany({ where: { recruiterVisibility: { in: ['anonymous', 'visible'] } }, select: { userId: true, recruiterVisibility: true }, orderBy: { updatedAt: 'desc' }, take: SOURCING_CAP * 2 });
  const live = new Set((await db.user.findMany({ where: { id: { in: visible.map((p) => p.userId) }, anonymizedAt: null, onboardedAt: { not: null } }, select: { id: true } })).map((u) => u.id));
  const prefs = visible.filter((p) => live.has(p.userId)).slice(0, SOURCING_CAP);
  const weights = await getActiveWeights();
  const [disclosures, submissions, users] = await Promise.all([
    db.disclosure.findMany({ where: { organizationId: actor.organizationId, candidateUserId: { in: prefs.map((p) => p.userId) } }, select: { candidateUserId: true, status: true } }),
    db.submission.findMany({ where: { requisitionId: r.id, candidateUserId: { in: prefs.map((p) => p.userId) } }, select: { candidateUserId: true, stage: true } }),
    db.user.findMany({ where: { id: { in: prefs.map((p) => p.userId) } }, select: { id: true, fullName: true, headline: true, city: true, country: true } }),
  ]);
  const cards: SourcedCard[] = [];
  for (const p of prefs) {
    const [resume, evidence] = await Promise.all([loadResumeContent(db, p.userId), loadEvidenceForGeneration(db, p.userId)]);
    if (!resume) continue;
    // Deterministic mode: the engine alone, nothing recorded - this scoring is
    // on the EMPLOYER's behalf, so no AiRun is written under the candidate's
    // identity and their résumé never reaches a model for a purpose they did
    // not consent to (Stage 18 review).
    const result = await scoreCompatibility({ userId: p.userId, resume, evidence, job: r.job, weights, mode: 'deterministic' });
    const u = users.find((x) => x.id === p.userId);
    const visibility = p.recruiterVisibility === 'visible' ? 'visible' : 'anonymous';
    cards.push({
      candidateUserId: p.userId,
      visibility,
      score: result.analysis.matchScore,
      matched: result.analysis.matchedKeywords.slice(0, 8),
      missing: result.analysis.missingKeywords.slice(0, 5),
      region: visibility === 'visible' ? [u?.city, u?.country].filter(Boolean).join(', ') : (u?.country ?? ''),
      name: visibility === 'visible' ? (u?.fullName ?? null) : null,
      headline: visibility === 'visible' ? (u?.headline ?? null) : null,
      disclosure: (disclosures.find((d) => d.candidateUserId === p.userId)?.status as SourcedCard['disclosure'] | undefined) ?? 'none',
      submissionStage: submissions.find((s) => s.candidateUserId === p.userId)?.stage ?? null,
    });
  }
  cards.sort((a, b) => b.score - a.score || a.candidateUserId.localeCompare(b.candidateUserId));
  const top = cards.slice(0, limit);
  await recordSecurityEvent(
    { event: 'employer.sourcing.run', actor: { type: 'user', id: actor.user.id, email: actor.user.email, role: `employer:${actor.role}` }, entityType: 'Requisition', entityId: r.id, summary: 'Candidate sourcing run (anonymised cards)', detail: { organizationId: actor.organizationId, considered: prefs.length, returned: top.length, weightVersion: weights.version }, meta: actor.meta },
    db,
    { strict: true },
  );
  return { cards: top, considered: prefs.length };
}

export interface DisclosedProfile {
  candidateUserId: string;
  fullName: string;
  email: string;
  phone: string | null;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  summary: string;
  skills: string[];
  experience: { title: string; company: string; period: string; highlights: string[] }[];
  education: { school: string; degree: string; period: string }[];
  certifications: string[];
  approvedClaims: number;
}

/** The profile behind a granted disclosure. Refused without one; audited per read. */
export async function readDisclosedCandidate(actor: EmployerActor, candidateUserId: string): Promise<DisclosedProfile> {
  await assertNotImpersonating('a disclosed candidate');
  // Role first (an interviewer only for a candidate whose interview names them; never a viewer), then the candidate's consent.
  if (!(await canSeeCandidate(db, actor, candidateUserId))) throw new EmployerError('You may not read candidate profiles.', 403);
  const d = await grantedDisclosure(db, actor.organizationId, candidateUserId);
  if (!d) throw new EmployerError('The candidate has not granted disclosure to your organisation.', 403);
  await recordSecurityEvent(
    { event: 'employer.candidate.read', actor: { type: 'user', id: actor.user.id, email: actor.user.email, role: `employer:${actor.role}` }, entityType: 'Disclosure', entityId: d.id, summary: 'Disclosed candidate profile read', detail: { organizationId: actor.organizationId, candidateUserId }, meta: actor.meta },
    db,
    { strict: true },
  );
  const [resume, user, evidence] = await Promise.all([loadResumeContent(db, candidateUserId), db.user.findUniqueOrThrow({ where: { id: candidateUserId }, select: { fullName: true, email: true, phone: true, headline: true, city: true, country: true, linkedinUrl: true } }), loadEvidenceForGeneration(db, candidateUserId)]);
  return {
    candidateUserId,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    headline: user.headline,
    location: [user.city, user.country].filter(Boolean).join(', ') || null,
    linkedinUrl: user.linkedinUrl,
    summary: resume?.summary ?? '',
    skills: resume?.skills ?? [],
    experience: (resume?.experience ?? []).map((e) => ({ title: e.title, company: e.company, period: [e.startDate, e.endDate || 'Present'].filter(Boolean).join(' - '), highlights: e.bullets ?? [] })),
    education: (resume?.education ?? []).map((e) => ({ school: e.institution, degree: e.credential, period: e.year })),
    certifications: resume?.certifications ?? [],
    approvedClaims: evidence.entries?.length ?? 0,
  };
}
