import { z } from 'zod';
import { ok } from '@/lib/api';
import { requireStaff } from '@/lib/crm/auth';
import { governanceRoute, requireStepUp } from '@/lib/crm/step-up';
import { requestMeta } from '@/lib/security-audit';
import { listFeatureFlags, setFeatureFlag } from '@/lib/admin/feature-flags';
import { adminFail } from '@/lib/admin/route';

/** GET /api/console/flags - the flags the code declares, with their stored state. Support and above. */
export const GET = governanceRoute(async () => {
  await requireStaff('support');
  return ok({ flags: await listFeatureFlags() });
});

const schema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  key: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  rolloutPercent: z.number().int().min(0).max(100),
  allowlist: z.array(z.string().trim().min(1).max(64)).max(500),
  reason: z.string().trim().min(3).max(500),
});

/** PUT /api/console/flags - set a DECLARED flag (ADR-0019: the code declares what is flaggable; no flag names a security control). Admin, step-up, audited. */
export const PUT = governanceRoute(async (request: Request) => {
  const staff = await requireStaff('admin');
  const body = schema.parse(await request.json());
  await requireStepUp(staff, body.currentPassword, requestMeta(request));
  try {
    const row = await setFeatureFlag(staff, body.key, { enabled: body.enabled, rolloutPercent: body.rolloutPercent, allowlist: body.allowlist }, body.reason, requestMeta(request));
    return ok({ flag: { key: row.key, enabled: row.enabled, rolloutPercent: row.rolloutPercent, allowlist: JSON.parse(row.allowlist) } });
  } catch (error) {
    return adminFail(error) ?? Promise.reject(error);
  }
});
