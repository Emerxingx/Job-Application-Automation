import { z } from 'zod';
import { requireTenant } from '@/lib/tenancy/request';
import { ok, route } from '@/lib/api';
import { saveResumeSections, writeResumeProjection } from '@/lib/candidate/profile';

const experienceSchema = z.object({
  company: z.string().min(1, 'Company name is required.'),
  title: z.string().min(1, 'Job title is required.'),
  location: z.string().optional().default(''),
  startDate: z.string().min(1, 'Start date is required.'),
  endDate: z.string().min(1, 'End date is required (or "Present").'),
  bullets: z.array(z.string()).default([]),
});

const educationSchema = z.object({
  institution: z.string().min(1),
  credential: z.string().min(1),
  year: z.string().min(1),
  location: z.string().optional().default(''),
});

const resumeSchema = z.object({
  fullName: z.string().min(2, 'Your name is required.'),
  headline: z.string().default(''),
  email: z.string().email('A valid email is required.'),
  phone: z.string().optional().default(''),
  location: z.string().optional().default(''),
  linkedinUrl: z.string().optional().default(''),
  portfolioUrl: z.string().optional().default(''),
  summary: z.string().default(''),
  skills: z.array(z.string()).default([]),
  experience: z.array(experienceSchema).default([]),
  education: z.array(educationSchema).default([]),
  certifications: z.array(z.string()).default([]),
  projects: z.array(z.object({ name: z.string(), description: z.string() })).default([]),
});

export const PUT = route(async (request: Request) => {
  const { user, run } = await requireTenant();
  const content = resumeSchema.parse(await request.json());

  // Tenant path: every query below runs under the user's RLS context, and the
  // userId filters stay (ADR-0005 — the backstop does not excuse the filter).
  //
  // Stage 02: the structured profile is the source of truth; Resume.content is
  // rewritten as its projection in the same transaction (expand phase).
  const resume = await run(async (tx) => {
    await saveResumeSections(tx, user.id, content);
    const saved = await writeResumeProjection(tx, user.id, content);

    // Saving a resume for the first time completes onboarding.
    if (!user.onboardedAt) {
      await tx.user.update({ where: { id: user.id }, data: { onboardedAt: new Date() } });
    }
    return saved;
  });

  return ok({ resumeId: resume.id });
});
