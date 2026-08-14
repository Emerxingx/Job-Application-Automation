/**
 * API key management for the signed-in user.
 *
 *   GET  /api/integrations/keys   list this user's keys (never the secrets)
 *   POST /api/integrations/keys   mint a key; the secret is returned ONCE
 *
 * Session-cookie authenticated and first-party, so these use `ok()`/`fail()`
 * from src/lib/api.ts rather than the structured envelope `/api/v1` returns.
 * An API key must not be able to mint another API key: that would turn a single
 * leaked read-only key into permanent, self-renewing access, and revoking the
 * original would not help. Minting requires a human session.
 */

import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { fail, ok, route } from '@/lib/api';
import {
  API_SCOPES,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  createApiKey,
  listApiKeys,
} from '@/lib/integrations/api-keys';

export const GET = route(async () => {
  const user = await requireUser();
  return ok({ keys: await listApiKeys(user.id) });
});

const createSchema = z.object({
  name: z.string().trim().min(2, 'Give the key a name you will recognise later.').max(80),
  scopes: z
    .array(z.enum(API_SCOPES))
    .min(1, 'A key needs at least one scope.')
    .max(API_SCOPES.length)
    .optional(),
  environment: z.enum(['live', 'test']).optional(),
  // Capped well below anything that would threaten the database, and floored at
  // 1 so a key cannot be created that can never be used.
  rateLimitPerMinute: z.number().int().min(1).max(600).optional(),
  expiresAt: z.coerce.date().optional(),
});

export const POST = route(async (request: Request) => {
  const user = await requireUser();
  const body = createSchema.parse(await request.json());

  if (body.expiresAt && body.expiresAt.getTime() <= Date.now()) {
    return fail('An expiry date must be in the future.', 422);
  }

  try {
    const { key, secret } = await createApiKey(user.id, {
      name: body.name,
      scopes: body.scopes,
      environment: body.environment ?? 'live',
      rateLimitPerMinute: body.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
      expiresAt: body.expiresAt ?? null,
    });

    // `secret` appears in this response and nowhere else, ever. It is not
    // stored, not logged, and cannot be recovered — the row holds a SHA-256 of
    // it. The warning is part of the payload so a client that renders the
    // response generically still shows it.
    return ok(
      {
        key,
        secret,
        warning:
          'Copy this key now. It is stored only as a hash and cannot be shown again — if you lose it, create a new one.',
      },
      { status: 201 },
    );
  } catch (error) {
    // createApiKey throws only for the per-user ceiling, which is the user's to
    // resolve, so it is a 409 rather than the 500 route() would produce.
    return fail(error instanceof Error ? error.message : 'Could not create the key.', 409);
  }
});
