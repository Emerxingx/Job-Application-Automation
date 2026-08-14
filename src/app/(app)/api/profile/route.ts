import { z } from 'zod';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { ok, route } from '@/lib/api';

const schema = z.object({
  fullName: z.string().min(2, 'Your name is required.').max(120),
  phone: z.string().max(40).optional().default(''),
  city: z.string().max(120).optional().default(''),
  country: z.enum(['CA', 'US']),
  headline: z.string().max(160).optional().default(''),
  linkedinUrl: z.string().max(300).optional().default(''),
  portfolioUrl: z.string().max(300).optional().default(''),
  workAuth: z.string().max(80).optional().default(''),
});

export const PUT = route(async (request: Request) => {
  const user = await requireUser();
  const body = schema.parse(await request.json());

  // Email is the login identity and is intentionally not editable here.
  await db.user.update({
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
    },
  });

  return ok({ ok: true });
});
