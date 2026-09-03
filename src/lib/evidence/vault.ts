import { createHash } from 'node:crypto';
import type { CareerEvidence, Prisma } from '@prisma/client';
import { parseJson } from '../types';
import { PROFILE_INCLUDE, type CandidateProfileRecord } from '../candidate/profile';
import type { EvidenceBundle } from '../ai/gateway';

/**
 * The Career Evidence Vault (MASTER_BUILD_PLAN Stage 03, AI_GOVERNANCE.md).
 *
 * An evidence item is one atomic, candidate-asserted claim with its source
 * and its structured facts: "Senior Data Analyst at Northbridge, 2022-03 to
 * present", "Reduced report latency by 40%", "Honours BSc, University of
 * Toronto, 2018". Generation receives evidence IDS and these one-line claims,
 * never a free-text profile, and the grounding checker admits exactly the
 * tokens and numbers the approved claims contain.
 *
 * LIFECYCLE
 *   draft ──approve──▶ approved ──(a revision is approved)──▶ superseded
 *     │                   │
 *     └──────revoke───────┘──▶ revoked
 *
 * IMMUTABILITY. An approved row's claim, facts, kind and source never change:
 * the service refuses (EvidenceImmutableError) and, independently, a trigger
 * in migration 20260903090200_evidence_immutability raises on any UPDATE that
 * would alter them — so a bug or a raw query cannot do what the service
 * refuses. A correction is a NEW version (`supersedesId`, `version + 1`) that
 * starts as a draft and supersedes its predecessor only when approved.
 *
 * PROVENANCE. Rows derived from the structured profile carry the source type
 * and a STABLE natural key (`sourceId`) — company|title|start for a role, the
 * bullet's digest for a responsibility — rather than the child row's id,
 * which the profile editor regenerates on every save. Deriving again after an
 * edit therefore supersedes what changed, revokes what disappeared, and leaves
 * everything else alone, and a candidate who entered a fact in the editor has
 * asserted it, so derived rows are approved on creation. Manual and uploaded
 * evidence starts as a draft.
 *
 * Every function takes the tenant transaction client and keeps the `userId`
 * filter (ADR-0005 point 5).
 */

type Client = Prisma.TransactionClient;

export const EVIDENCE_KINDS = ['employment', 'responsibility', 'achievement', 'education', 'certification', 'skill', 'project', 'language'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const EVIDENCE_STATUSES = ['draft', 'approved', 'superseded', 'revoked'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export class EvidenceError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = 'EvidenceError';
    this.status = status;
  }
}
export class EvidenceImmutableError extends EvidenceError {
  constructor() {
    super('Approved evidence cannot be edited. Create a revision instead.', 409);
    this.name = 'EvidenceImmutableError';
  }
}

export type EvidenceFacts = Record<string, string | number | null>;

function digest(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase()).digest('hex').slice(0, 12);
}

const key = (...parts: (string | number | null | undefined)[]) =>
  parts.map((p) => String(p ?? '').trim().toLowerCase().replace(/\s+/g, ' ')).join('|');

interface Derived {
  kind: EvidenceKind;
  sourceType: string;
  sourceId: string;
  claim: string;
  facts: EvidenceFacts;
}

/** Turn the structured profile into atomic claims. Pure. */
export function deriveClaims(profile: CandidateProfileRecord): Derived[] {
  const out: Derived[] = [];
  for (const e of profile.employment) {
    const end = e.isCurrent || !e.endDate ? 'present' : e.endDate;
    const roleKey = key(e.company, e.title, e.startDate);
    out.push({
      kind: 'employment',
      sourceType: 'profile_employment',
      sourceId: `role:${roleKey}`,
      claim: `${e.title} at ${e.company}${e.location ? ` (${e.location})` : ''}, ${e.startDate} to ${end}`,
      facts: { company: e.company, title: e.title, location: e.location ?? null, startDate: e.startDate, endDate: end, employmentType: e.employmentType ?? null },
    });
    for (const bullet of parseJson<string[]>(e.bullets, [])) {
      if (!bullet.trim()) continue;
      out.push({
        kind: 'responsibility',
        sourceType: 'profile_employment',
        sourceId: `bullet:${roleKey}#${digest(bullet)}`,
        claim: bullet.trim(),
        facts: { company: e.company, title: e.title, text: bullet.trim() },
      });
    }
  }
  for (const a of profile.achievements) {
    out.push({
      kind: 'achievement',
      sourceType: 'profile_achievement',
      sourceId: `achievement:${key(a.title, a.metric, a.occurredAt)}`,
      claim: `${a.title}${a.metric ? ` — ${a.metric}` : ''}${a.occurredAt ? ` (${a.occurredAt})` : ''}`,
      facts: { title: a.title, description: a.description, metric: a.metric ?? null, occurredAt: a.occurredAt ?? null },
    });
  }
  for (const ed of profile.education) {
    out.push({
      kind: 'education',
      sourceType: 'profile_education',
      sourceId: `education:${key(ed.institution, ed.credential, ed.endYear)}`,
      claim: `${ed.credential}${ed.fieldOfStudy ? ` in ${ed.fieldOfStudy}` : ''}, ${ed.institution}${ed.endYear ? `, ${ed.endYear}` : ''}`,
      facts: { institution: ed.institution, credential: ed.credential, fieldOfStudy: ed.fieldOfStudy ?? null, level: ed.level ?? null, startYear: ed.startYear ?? null, endYear: ed.endYear ?? null, location: ed.location ?? null },
    });
  }
  for (const c of profile.certifications) {
    out.push({
      kind: 'certification',
      sourceType: 'profile_certification',
      sourceId: `certification:${key(c.name, c.issuer)}`,
      claim: `${c.name}${c.issuer ? ` (${c.issuer})` : ''}${c.issuedAt ? `, issued ${c.issuedAt}` : ''}`,
      facts: { name: c.name, issuer: c.issuer ?? null, issuedAt: c.issuedAt ?? null, expiresAt: c.expiresAt ?? null, credentialId: c.credentialId ?? null },
    });
  }
  for (const p of profile.projects) {
    const tech = parseJson<string[]>(p.technologies, []);
    out.push({
      kind: 'project',
      sourceType: 'profile_project',
      sourceId: `project:${key(p.name)}`,
      claim: `Project: ${p.name}${p.description ? ` — ${p.description}` : ''}${tech.length ? ` (${tech.join(', ')})` : ''}`,
      facts: { name: p.name, description: p.description, technologies: tech.join(', '), startDate: p.startDate ?? null, endDate: p.endDate ?? null },
    });
  }
  for (const s of profile.skills) {
    out.push({
      kind: 'skill',
      sourceType: 'profile_skill',
      sourceId: `skill:${s.normalizedName}`,
      claim: `Skill: ${s.name}${s.proficiency ? ` (${s.proficiency})` : ''}${s.yearsUsed ? `, ${s.yearsUsed} years` : ''}`,
      facts: { name: s.name, proficiency: s.proficiency ?? null, yearsUsed: s.yearsUsed ?? null, lastUsedYear: s.lastUsedYear ?? null },
    });
  }
  for (const l of profile.languages) {
    out.push({
      kind: 'language',
      sourceType: 'profile_language',
      sourceId: `language:${key(l.language)}`,
      claim: `Language: ${l.language}${l.proficiency ? ` (${l.proficiency})` : ''}`,
      facts: { language: l.language, proficiency: l.proficiency ?? null },
    });
  }
  return out;
}

export interface SyncReport {
  created: number;
  superseded: number;
  revoked: number;
  unchanged: number;
}

/**
 * Bring the vault in line with the structured profile. Idempotent: a second
 * run with an unchanged profile changes nothing.
 */
export async function syncEvidenceFromProfile(tx: Client, userId: string): Promise<SyncReport> {
  const profile = await tx.candidateProfile.findFirst({ where: { userId }, include: PROFILE_INCLUDE });
  // No profile row means nothing has been entered yet — not that everything
  // was removed. Deriving from nothing must not revoke what a previous
  // profile produced; an emptied profile (row present, no children) does.
  if (!profile) return { created: 0, superseded: 0, revoked: 0, unchanged: 0 };
  const derived = deriveClaims(profile);
  const live = await tx.careerEvidence.findMany({
    where: { userId, status: { in: ['draft', 'approved'] }, sourceType: { startsWith: 'profile_' } },
  });
  const byKey = new Map(live.map((row) => [`${row.sourceType}|${row.sourceId}`, row]));
  const now = new Date();
  const report: SyncReport = { created: 0, superseded: 0, revoked: 0, unchanged: 0 };
  const seen = new Set<string>();

  for (const d of derived) {
    const k = `${d.sourceType}|${d.sourceId}`;
    seen.add(k);
    const existing = byKey.get(k);
    const facts = JSON.stringify(d.facts);
    if (existing && existing.claim === d.claim && existing.facts === facts) {
      report.unchanged += 1;
      continue;
    }
    // Changed or new: a new approved version. The candidate re-asserted it
    // by saving the profile, so no separate approval step applies.
    await tx.careerEvidence.create({
      data: {
        userId,
        profileId: profile.id,
        kind: d.kind,
        sourceType: d.sourceType,
        sourceId: d.sourceId,
        claim: d.claim,
        facts,
        status: 'approved',
        version: (existing?.version ?? 0) + 1,
        supersedesId: existing?.id ?? null,
        approvedAt: now,
      },
    });
    if (existing) {
      await tx.careerEvidence.update({ where: { id: existing.id, userId }, data: { status: 'superseded' } });
      report.superseded += 1;
    } else {
      report.created += 1;
    }
  }
  for (const [k, row] of byKey) {
    if (seen.has(k)) continue;
    await tx.careerEvidence.update({ where: { id: row.id, userId }, data: { status: 'revoked', revokedAt: now } });
    report.revoked += 1;
  }
  return report;
}

export async function listEvidence(tx: Client, userId: string, status?: EvidenceStatus): Promise<CareerEvidence[]> {
  return tx.careerEvidence.findMany({
    where: { userId, ...(status ? { status } : {}) },
    orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }],
  });
}

async function own(tx: Client, userId: string, id: string): Promise<CareerEvidence> {
  const row = await tx.careerEvidence.findFirst({ where: { id, userId } });
  if (!row) throw new EvidenceError('Evidence not found.', 404);
  return row;
}

export interface ManualEvidenceInput {
  kind: EvidenceKind;
  claim: string;
  facts?: EvidenceFacts;
}

/** A claim the candidate types in directly. Starts as a draft. */
export async function addManualEvidence(tx: Client, userId: string, input: ManualEvidenceInput): Promise<CareerEvidence> {
  if (!EVIDENCE_KINDS.includes(input.kind)) throw new EvidenceError('Unknown evidence kind.', 422);
  const claim = input.claim.trim();
  if (claim.length < 3 || claim.length > 500) throw new EvidenceError('A claim is one sentence of 3 to 500 characters.', 422);
  return tx.careerEvidence.create({
    data: { userId, kind: input.kind, sourceType: 'manual', sourceId: null, claim, facts: JSON.stringify(input.facts ?? {}), status: 'draft' },
  });
}

/** draft → approved; the predecessor it revises (if any) → superseded. */
export async function approveEvidence(tx: Client, userId: string, id: string): Promise<CareerEvidence> {
  const row = await own(tx, userId, id);
  if (row.status !== 'draft') throw new EvidenceError(`Only a draft can be approved; this item is ${row.status}.`);
  const now = new Date();
  if (row.supersedesId) {
    const prior = await tx.careerEvidence.findFirst({ where: { id: row.supersedesId, userId } });
    if (prior && (prior.status === 'approved' || prior.status === 'draft')) {
      await tx.careerEvidence.update({ where: { id: prior.id, userId }, data: { status: 'superseded' } });
    }
  }
  return tx.careerEvidence.update({ where: { id, userId }, data: { status: 'approved', approvedAt: now } });
}

/**
 * Correct a claim. An approved item is never edited in place: the correction
 * is a new draft version pointing at it, and approving the draft supersedes
 * the original. A draft may be revised in place.
 */
export async function reviseEvidence(tx: Client, userId: string, id: string, input: { claim: string; facts?: EvidenceFacts }): Promise<CareerEvidence> {
  const row = await own(tx, userId, id);
  const claim = input.claim.trim();
  if (claim.length < 3 || claim.length > 500) throw new EvidenceError('A claim is one sentence of 3 to 500 characters.', 422);
  if (row.status === 'draft') {
    return tx.careerEvidence.update({ where: { id, userId }, data: { claim, facts: JSON.stringify(input.facts ?? parseJson(row.facts, {})) } });
  }
  if (row.status !== 'approved') throw new EvidenceError(`A ${row.status} item cannot be revised.`);
  return tx.careerEvidence.create({
    data: {
      userId,
      profileId: row.profileId,
      kind: row.kind,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      claim,
      facts: JSON.stringify(input.facts ?? parseJson(row.facts, {})),
      status: 'draft',
      version: row.version + 1,
      supersedesId: row.id,
    },
  });
}

/** draft or approved → revoked. Revoked evidence never grounds a generation again. */
export async function revokeEvidence(tx: Client, userId: string, id: string): Promise<CareerEvidence> {
  const row = await own(tx, userId, id);
  if (row.status === 'revoked') return row;
  if (row.status === 'superseded') throw new EvidenceError('A superseded item is already out of use.');
  return tx.careerEvidence.update({ where: { id, userId }, data: { status: 'revoked', revokedAt: new Date() } });
}

/** What generation receives: ids for the run record, one-line claims for the corpus. */
export async function loadEvidenceForGeneration(tx: Client, userId: string): Promise<EvidenceBundle> {
  const rows = await tx.careerEvidence.findMany({ where: { userId, status: 'approved' }, select: { id: true, claim: true, facts: true }, orderBy: { createdAt: 'asc' } });
  return {
    ids: rows.map((r) => r.id),
    claims: rows.map((r) => {
      const facts = parseJson<EvidenceFacts>(r.facts, {});
      const extra = Object.values(facts).filter((v): v is string | number => v !== null && v !== '' && v !== undefined).map(String);
      return extra.length ? `${r.claim} [${extra.join('; ')}]` : r.claim;
    }),
  };
}
