import type { Prisma } from '@prisma/client';
import { parseJson } from '../types';
import type { ResumeContent, ResumeEducation, ResumeExperience } from '../types';
import { renderResumeText } from '../resume-render';

/**
 * The Candidate Digital Twin — read and write the structured profile, and
 * project it to the `ResumeContent` shape every existing consumer (the résumé
 * editor, the AI providers, the scanner, the applicator) already understands.
 *
 * EXPAND PHASE (ADR-0002). The structured rows are the source of truth.
 * `Resume.content` is kept as a derived projection, rewritten from the rows on
 * every save, so nothing downstream has to change on day one; each consumer
 * moves to the structured read as its own stage touches it, and the JSON
 * column is dropped in a later migration when nothing reads it.
 *
 * TENANT PATH. Every function takes a Prisma client and is written to be
 * called with the transaction client from `requireTenant().run(...)`, so the
 * RLS policies on all eleven candidate tables apply. The `userId` filters stay
 * (ADR-0005 point 5). Nothing here reads the `sensitive` schema, and nothing
 * here could: no Prisma model exists for it (ADR-0007).
 */

type Client = Prisma.TransactionClient;

export const PROFILE_INCLUDE = {
  employment: { orderBy: { sortOrder: 'asc' as const } },
  education: { orderBy: { sortOrder: 'asc' as const } },
  skills: { orderBy: { sortOrder: 'asc' as const } },
  certifications: { orderBy: { sortOrder: 'asc' as const } },
  projects: { orderBy: { sortOrder: 'asc' as const } },
  achievements: { orderBy: { sortOrder: 'asc' as const } },
  languages: true,
  preferences: true,
  workAuth: true,
} satisfies Prisma.CandidateProfileInclude;

export type CandidateProfileRecord = Prisma.CandidateProfileGetPayload<{ include: typeof PROFILE_INCLUDE }>;

/**
 * What the résumé projection needs — and nothing more. Preferences and work
 * authorisation are deliberately absent: they are CONFIDENTIAL settings that
 * eligibility reads (Stage 07), not material for a prompt, and a record that
 * never carried them cannot be serialised into one by mistake.
 */
export const RESUME_INCLUDE = {
  employment: { orderBy: { sortOrder: 'asc' as const } },
  education: { orderBy: { sortOrder: 'asc' as const } },
  skills: { orderBy: { sortOrder: 'asc' as const } },
  certifications: { orderBy: { sortOrder: 'asc' as const } },
  projects: { orderBy: { sortOrder: 'asc' as const } },
} satisfies Prisma.CandidateProfileInclude;

export type ResumeProfileRecord = Prisma.CandidateProfileGetPayload<{ include: typeof RESUME_INCLUDE }>;

/**
 * A profile row can exist with nothing in it (saving preferences creates one).
 * That is not a résumé, and must not satisfy "add your résumé first" guards.
 */
export function hasResumeContent(profile: ResumeProfileRecord): boolean {
  return (
    profile.employment.length > 0 ||
    profile.skills.length > 0 ||
    profile.education.length > 0 ||
    profile.summary.trim().length > 0
  );
}

/** Normalise a skill label for de-duplication and matching. */
export function normalizeSkill(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** A stable, opaque profile id derived from the user id — the same one the migration backfill uses. */
export function profileIdFor(userId: string): string {
  return `cp_${userId}`;
}

export async function loadProfile(tx: Client, userId: string): Promise<CandidateProfileRecord | null> {
  return tx.candidateProfile.findFirst({ where: { userId }, include: PROFILE_INCLUDE });
}

/** Contact fields live on User; the profile carries everything career-shaped. */
export interface ContactFields {
  fullName: string;
  email: string;
  phone?: string | null;
  city?: string | null;
  linkedinUrl?: string | null;
  portfolioUrl?: string | null;
  headline?: string | null;
}

/**
 * Project the structured profile to the résumé shape. Pure, so the AI and
 * document paths can be tested against a fixed profile.
 */
export function toResumeContent(profile: ResumeProfileRecord, contact: ContactFields): ResumeContent {
  const experience: ResumeExperience[] = profile.employment.map((e) => ({
    company: e.company,
    title: e.title,
    location: e.location ?? '',
    startDate: e.startDate,
    endDate: e.isCurrent || !e.endDate ? 'Present' : e.endDate,
    bullets: parseJson<string[]>(e.bullets, []),
  }));
  const education: ResumeEducation[] = profile.education.map((ed) => ({
    institution: ed.institution,
    credential: [ed.credential, ed.fieldOfStudy].filter(Boolean).join(', '),
    year: ed.endYear ? String(ed.endYear) : '',
    location: ed.location ?? '',
  }));
  return {
    fullName: contact.fullName,
    headline: profile.headline || contact.headline || '',
    email: contact.email,
    phone: contact.phone ?? '',
    location: contact.city ?? '',
    linkedinUrl: contact.linkedinUrl ?? '',
    portfolioUrl: contact.portfolioUrl ?? '',
    summary: profile.summary,
    skills: profile.skills.map((s) => s.name),
    experience,
    education,
    certifications: profile.certifications.map((c) => (c.issuer ? `${c.name} (${c.issuer})` : c.name)),
    projects: profile.projects.map((p) => ({ name: p.name, description: p.description })),
  };
}

/**
 * Replace the profile's résumé-shaped sections from editor input. Contact
 * fields are NOT written here — they belong to User and are updated by the
 * profile route. Sections the editor does not carry (achievements, languages,
 * preferences, work authorisation) are left untouched.
 *
 * Replacement, not merge: the editor submits the whole list, so the list is
 * the truth. Ids are regenerated, so `Achievement.employmentId` (SET NULL) is
 * cleared on every save — nothing writes achievements yet; Stage 03 gives
 * them their evidence role and brings a stable-id strategy with it.
 */
export async function saveResumeSections(tx: Client, userId: string, content: ResumeContent) {
  const id = profileIdFor(userId);
  // Serialise concurrent saves for one user: two PUTs racing through the
  // delete-then-create below would otherwise both insert. FOR UPDATE on the
  // profile row (created on first save, so a first-ever race is bounded by the
  // upsert's unique key) makes the second wait for the first to commit.
  await tx.$queryRaw`SELECT "id" FROM "public"."CandidateProfile" WHERE "userId" = ${userId} FOR UPDATE`;
  const profile = await tx.candidateProfile.upsert({
    where: { userId },
    create: { id, userId, headline: content.headline ?? '', summary: content.summary ?? '', source: 'editor' },
    update: { headline: content.headline ?? '', summary: content.summary ?? '', source: 'editor' },
    select: { id: true },
  });
  const profileId = profile.id;

  await tx.employmentHistory.deleteMany({ where: { profileId, userId } });
  if (content.experience.length > 0) {
    await tx.employmentHistory.createMany({
      data: content.experience.map((e, i) => {
        const current = !e.endDate || /^(present|current)$/i.test(e.endDate.trim());
        return {
          profileId,
          userId,
          company: e.company,
          title: e.title,
          location: e.location || null,
          startDate: e.startDate,
          endDate: current ? null : e.endDate,
          isCurrent: current,
          bullets: JSON.stringify(e.bullets ?? []),
          sortOrder: i,
        };
      }),
    });
  }

  await tx.education.deleteMany({ where: { profileId, userId } });
  if (content.education.length > 0) {
    await tx.education.createMany({
      data: content.education.map((ed, i) => ({
        profileId,
        userId,
        institution: ed.institution,
        credential: ed.credential,
        endYear: /^\d{4}$/.test(ed.year?.trim() ?? '') ? Number(ed.year) : null,
        location: ed.location || null,
        sortOrder: i,
      })),
    });
  }

  await tx.candidateSkill.deleteMany({ where: { profileId, userId } });
  const seen = new Set<string>();
  const skills = content.skills
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => {
      const n = normalizeSkill(s);
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });
  if (skills.length > 0) {
    await tx.candidateSkill.createMany({
      data: skills.map((name, i) => ({ profileId, userId, name, normalizedName: normalizeSkill(name), source: 'self', sortOrder: i })),
    });
  }

  await tx.certification.deleteMany({ where: { profileId, userId } });
  const certs = content.certifications.map((c) => c.trim()).filter(Boolean);
  if (certs.length > 0) {
    await tx.certification.createMany({ data: certs.map((name, i) => ({ profileId, userId, name, sortOrder: i })) });
  }

  await tx.project.deleteMany({ where: { profileId, userId } });
  const projects = (content.projects ?? []).filter((p) => p.name.trim());
  if (projects.length > 0) {
    await tx.project.createMany({
      data: projects.map((p, i) => ({ profileId, userId, name: p.name.trim(), description: p.description ?? '', sortOrder: i })),
    });
  }

  return profileId;
}

/**
 * Persist the derived `Resume.content` projection for the legacy readers.
 * Called after `saveResumeSections` in the same transaction.
 */
export async function writeResumeProjection(tx: Client, userId: string, content: ResumeContent) {
  const existing = await tx.resume.findFirst({ where: { userId, isMaster: true }, select: { id: true } });
  const data = { content: JSON.stringify(content), rawText: renderResumeText(content) };
  return existing
    ? tx.resume.update({ where: { id: existing.id }, data, select: { id: true } })
    : tx.resume.create({ data: { userId, label: 'Master Resume', isMaster: true, ...data }, select: { id: true } });
}

/**
 * The résumé every AI, scanning and document path should read from now on:
 * the structured profile projected, falling back to the legacy JSON only for
 * a user whose profile has not been created yet (a race with the backfill, or
 * an account created before Stage 02 that never saved a résumé).
 */
export async function loadResumeContent(tx: Client, userId: string): Promise<ResumeContent | null> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { fullName: true, email: true, phone: true, city: true, linkedinUrl: true, portfolioUrl: true, headline: true },
  });
  if (!user) return null;
  const profile = await tx.candidateProfile.findFirst({ where: { userId }, include: RESUME_INCLUDE });
  if (profile && hasResumeContent(profile)) return toResumeContent(profile, user);
  // No profile, or an empty one (preferences saved before a résumé): the
  // legacy JSON, if any, is still the candidate's résumé; otherwise there is
  // none, and callers refuse rather than run on an empty document.
  const legacy = await tx.resume.findFirst({ where: { userId, isMaster: true }, orderBy: { updatedAt: 'desc' } });
  return parseJson<ResumeContent | null>(legacy?.content, null);
}
