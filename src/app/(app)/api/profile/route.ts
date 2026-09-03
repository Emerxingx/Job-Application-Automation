import { z } from 'zod';
import { requireTenant } from '@/lib/tenancy/request';
import { ok, route } from '@/lib/api';
import { parseApplicationMode } from '@/lib/apply/modes';

const schema = z.object({
  fullName: z.string().min(2, 'Your name is required.').max(120),
  phone: z.string().max(40).optional().default(''),
  city: z.string().max(120).optional().default(''),
  country: z.enum(['CA', 'US']),
  headline: z.string().max(160).optional().default(''),
  linkedinUrl: z.string().max(300).optional().default(''),
  portfolioUrl: z.string().max(300).optional().default(''),
  workAuth: z.string().max(80).optional().default(''),
  // Stage 12: parsed by parseApplicationMode — the unreachable mode is refused with its reason.
  applicationMode: z.string().max(40).optional(),
});

export const PUT = route(async (request: Request) => {
  const { user, run } = await requireTenant();
  const body = schema.parse(await request.json());
  const applicationMode = body.applicationMode === undefined ? undefined : parseApplicationMode(body.applicationMode);

  // Email is the login identity and is intentionally not editable here.
  await run((tx) =>
    tx.user.update({
      where: { id: user.id },
      data: {
        fullName: body.fullName.trim(),
        phone: body.phone || null,
        city: body.city || null,
        country: body.country,
        headline: body.headline || null,
        linkedinUrl: body.linkedinUrl || null,
        portfolioUrl: body.portfolioUrl || null,
        workAuth: body.workAuth || null,
        ...(applicationMode ? { applicationMode } : {}),
      },
    }),
  );

  return ok({ ok: true });
});
