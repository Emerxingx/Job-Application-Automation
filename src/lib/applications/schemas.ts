import { z } from 'zod';
import { APPLICANT_STATUSES } from './status-machine';

/** Stage 10 — request bodies for the folder routes. Dates arrive as ISO strings. */
const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));
const optionalText = (max: number) => z.string().trim().max(max).optional();
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();

export const statusBodySchema = z.object({
  status: z.enum(APPLICANT_STATUSES as [string, ...string[]]).optional(),
  reason: optionalText(500),
  rejectionReason: z.enum(['no_response', 'not_selected', 'position_filled', 'withdrawn_by_employer', 'other']).optional(),
  notes: z.string().max(5000).optional(),
});

export const contactSchema = z.object({
  role: z.enum(['hiring_manager', 'recruiter', 'referral', 'other']),
  name: z.string().trim().min(1, 'A name is required.').max(200),
  email: z.string().trim().email().max(320).nullable().optional(),
  phone: nullableText(50),
  organisation: nullableText(200),
  notes: optionalText(2000),
});
export const contactPatchSchema = contactSchema.partial();

export const interviewSchema = z.object({
  kind: z.enum(['phone', 'video', 'onsite', 'panel', 'technical', 'other']),
  scheduledAt: isoDate,
  durationMinutes: z.number().int().min(5).max(600).nullable().optional(),
  location: nullableText(500),
  interviewers: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  notes: optionalText(5000),
  outcome: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional(),
  result: z.enum(['pending', 'advanced', 'not_advanced']).optional(),
});
export const interviewPatchSchema = interviewSchema.partial();

export const assessmentSchema = z.object({
  kind: z.enum(['take_home', 'online_test', 'case_study', 'presentation', 'other']),
  dueAt: isoDate.nullable().optional(),
  submittedAt: isoDate.nullable().optional(),
  result: z.enum(['pending', 'passed', 'failed']).optional(),
  notes: optionalText(5000),
});
export const assessmentPatchSchema = assessmentSchema.partial();

export const followUpSchema = z.object({
  dueAt: isoDate,
  channel: z.enum(['email', 'phone', 'linkedin', 'portal', 'other']),
  note: optionalText(2000),
  documentVersionId: z.string().trim().min(1).nullable().optional(),
});
export const followUpPatchSchema = z.object({ done: z.literal(true) });

export const noteSchema = z.object({ body: z.string().trim().min(1, 'Write something first.').max(10000) });

export const offerSchema = z.object({
  receivedAt: isoDate.nullable().optional(),
  deadline: isoDate.nullable().optional(),
  salaryMin: z.number().int().min(0).nullable().optional(),
  salaryMax: z.number().int().min(0).nullable().optional(),
  currency: z.string().trim().length(3).toUpperCase().nullable().optional(),
  decision: z.enum(['pending', 'accepted', 'declined']).nullable().optional(),
});

export const outcomeSchema = z.object({
  outcome: z.enum(['pending', 'ghosted', 'expired']),
  reason: optionalText(500),
});
