import { z } from 'zod';
import { requireTenant } from '@/lib/tenancy/request';
import { renderResumeText } from '@/lib/resume-render';
import { ok, route } from '@/lib/api';

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

  const data = {
    content: JSON.stringify(content),
    rawText: renderResumeText(content),
  };

  // Tenant path: every query below runs under the user's RLS context, and the
  // userId filters stay (ADR-0005 — the backstop does not excuse the filter).
  const resume = await run(async (tx) => {
    const existing = await tx.resume.findFirst({ where: { userId: user.id, isMaster: true } });
    const saved = existing
      ? await tx.resume.update({ where: { id: existing.id }, data })
      : await tx.resume.create({
          data: { userId: user.id, label: 'Master Resume', isMaster: true, ...data },
        });

    // Saving a resume for the first time completes onboarding.
    if (!user.onboardedAt) {
      await tx.user.update({ where: { id: user.id }, data: { onboardedAt: new Date() } });
    }
    return saved;
  });

  return ok({ resumeId: resume.id });
});
