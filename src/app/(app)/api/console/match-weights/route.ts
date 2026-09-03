import { z } from 'zod';
import { ok } from '@/lib/api';
import { requireStaff } from '@/lib/crm/auth';
import { governanceRoute, requireStepUp } from '@/lib/crm/step-up';
import { BUILTIN_WEIGHTS, BUILTIN_WEIGHT_VERSION, createWeightVersion, getActiveWeights, listWeightVersions } from '@/lib/matching/weights';
import { requestMeta } from '@/lib/security-audit';

/** GET /api/console/match-weights — every weight version, the active one, and the built-in baseline. Admin only. */
export const GET = governanceRoute(async () => {
  await requireStaff('admin');
  const [versions, active] = await Promise.all([listWeightVersions(), getActiveWeights()]);
  return ok({ versions, active, builtin: { version: BUILTIN_WEIGHT_VERSION, weights: BUILTIN_WEIGHTS } });
});

const weight = z.number().min(0).max(1);
const createSchema = z.object({
  currentPassword: z.string().min(1, 'Re-enter your password to change the weights.'),
  reason: z.string().trim().max(500).optional(),
  weights: z.object({ skills: weight, keywords: weight, experience: weight, seniority: weight, location: weight }),
  notes: z.string().max(4000).optional(),
});

/** POST /api/console/match-weights — a new DRAFT version. Admin + step-up. */
export const POST = governanceRoute(async (request: Request) => {
  const staff = await requireStaff('admin');
  const body = createSchema.parse(await request.json());
  await requireStepUp(staff, body.currentPassword, requestMeta(request));
  const version = await createWeightVersion({ weights: body.weights, notes: body.notes }, staff, body.reason ?? null);
  return ok({ version }, { status: 201 });
});
