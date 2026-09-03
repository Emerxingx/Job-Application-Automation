import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { profileIdFor } from './profile';

/**
 * Career preferences and work authorisation — the parts of the Digital Twin
 * that are settings rather than history. Validated with closed vocabularies;
 * stored as JSON string arrays where the column is a list (the schema's
 * convention). Consent-shaped settings (`recruiterVisibility`, `autonomy`)
 * default to the most private / least autonomous value and `autonomy` cannot
 * be set above `assist_only` here at all: `assisted_apply` arrives in Stage 12
 * and `auto_apply` is gated by ADR-0016.
 */

type Client = Prisma.TransactionClient;

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'internship'] as const;
export const WORK_MODES = ['onsite', 'hybrid', 'remote'] as const;
export const RELOCATION = ['no', 'open', 'yes'] as const;
export const RECRUITER_VISIBILITY = ['hidden', 'anonymous', 'visible'] as const;
export const AUTONOMY = ['assist_only'] as const; // widened by later stages, never here

const shortList = (max: number) => z.array(z.string().trim().min(1).max(80)).max(max).default([]);

export const preferencesSchema = z.object({
  targetTitles: shortList(10),
  adjacentTitles: shortList(10),
  employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).max(4).default([]),
  workModes: z.array(z.enum(WORK_MODES)).max(3).default([]),
  locations: shortList(10),
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(5).default([]),
  salaryMinCents: z.number().int().min(0).max(100_000_000).nullable().default(null),
  salaryCurrency: z.enum(['CAD', 'USD']).default('CAD'),
  travelPercentMax: z.number().int().min(0).max(100).nullable().default(null),
  relocation: z.enum(RELOCATION).default('no'),
  recruiterVisibility: z.enum(RECRUITER_VISIBILITY).default('hidden'),
  autonomy: z.enum(AUTONOMY).default('assist_only'),
  noticePeriodDays: z.number().int().min(0).max(365).nullable().default(null),
  availableFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
});
export type PreferencesInput = z.infer<typeof preferencesSchema>;

export const WORK_AUTH_STATUS = ['citizen', 'permanent_resident', 'work_permit', 'study_permit', 'requires_sponsorship', 'other', 'unspecified'] as const;

export const workAuthorizationSchema = z.object({
  country: z.enum(['CA', 'US']).default('CA'),
  status: z.enum(WORK_AUTH_STATUS).default('unspecified'),
  permitType: z.string().trim().max(80).nullable().default(null),
  permitExpiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  sponsorshipNeeded: z.boolean().default(false),
  notes: z.string().trim().max(500).default(''),
});
export type WorkAuthorizationInput = z.infer<typeof workAuthorizationSchema>;

async function ensureProfileId(tx: Client, userId: string): Promise<string> {
  const existing = await tx.candidateProfile.findFirst({ where: { userId }, select: { id: true } });
  if (existing) return existing.id;
  const created = await tx.candidateProfile.create({ data: { id: profileIdFor(userId), userId }, select: { id: true } });
  return created.id;
}

export async function loadPreferences(tx: Client, userId: string) {
  return tx.careerPreferences.findFirst({ where: { userId } });
}

export async function savePreferences(tx: Client, userId: string, input: PreferencesInput) {
  const profileId = await ensureProfileId(tx, userId);
  const data = {
    targetTitles: JSON.stringify(input.targetTitles),
    adjacentTitles: JSON.stringify(input.adjacentTitles),
    employmentTypes: JSON.stringify(input.employmentTypes),
    workModes: JSON.stringify(input.workModes),
    locations: JSON.stringify(input.locations),
    countries: JSON.stringify(input.countries),
    salaryMinCents: input.salaryMinCents,
    salaryCurrency: input.salaryCurrency,
    travelPercentMax: input.travelPercentMax,
    relocation: input.relocation,
    recruiterVisibility: input.recruiterVisibility,
    autonomy: input.autonomy,
    noticePeriodDays: input.noticePeriodDays,
    availableFrom: input.availableFrom,
  };
  return tx.careerPreferences.upsert({ where: { userId }, create: { profileId, userId, ...data }, update: data });
}

export async function loadWorkAuthorization(tx: Client, userId: string) {
  return tx.workAuthorization.findFirst({ where: { userId } });
}

export async function saveWorkAuthorization(tx: Client, userId: string, input: WorkAuthorizationInput) {
  const profileId = await ensureProfileId(tx, userId);
  const data = {
    country: input.country,
    status: input.status,
    permitType: input.permitType,
    permitExpiresAt: input.permitExpiresAt,
    sponsorshipNeeded: input.sponsorshipNeeded,
    notes: input.notes,
  };
  return tx.workAuthorization.upsert({ where: { userId }, create: { profileId, userId, ...data }, update: data });
}
