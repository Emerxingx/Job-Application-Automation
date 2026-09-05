/** Stage 18 - the requisition body shared by the create and update routes (a route file may export only handlers). */
import { z } from 'zod';

export const requisitionSchema = z.object({
  title: z.string().trim().min(2).max(160),
  department: z.string().trim().max(120).optional(),
  location: z.string().trim().min(2).max(160),
  country: z.enum(['CA', 'US']).optional(),
  workMode: z.enum(['onsite', 'hybrid', 'remote']).optional(),
  jobType: z.enum(['full_time', 'part_time', 'contract', 'internship']).optional(),
  description: z.string().trim().max(20_000).optional(),
  requiredSkills: z.array(z.string().trim().max(80)).max(50).optional(),
  preferredSkills: z.array(z.string().trim().max(80)).max(50).optional(),
  certificationRequirements: z.array(z.string().trim().max(120)).max(20).optional(),
  experienceYearsMin: z.number().int().min(0).max(60).nullable().optional(),
  salaryMin: z.number().int().min(0).nullable().optional(),
  salaryMax: z.number().int().min(0).nullable().optional(),
  salaryCurrency: z.enum(['CAD', 'USD']).optional(),
  hiringManagerId: z.string().min(1).nullable().optional(),
  recruiterId: z.string().min(1).nullable().optional(),
});
