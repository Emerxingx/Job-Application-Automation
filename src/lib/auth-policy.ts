/**
 * Session-secret policy, with NO dependencies.
 *
 * This lives apart from src/lib/auth.ts on purpose. `auth.ts` imports
 * `next/headers`, `bcryptjs` and the Prisma client — none of which can run in
 * the edge runtime, where `src/middleware.ts` executes. Importing `auth.ts`
 * from middleware would drag PrismaClient into the edge bundle.
 *
 * So the two values middleware genuinely needs live here, importable from both
 * runtimes, and `auth.ts` re-exports them so existing callers are unchanged.
 * There is exactly one definition of each; this is not a duplicate.
 */

/**
 * The development fallback. It also ships in `.env.example`, which is exactly
 * why production has to reject it BY VALUE: it is long enough to pass a length
 * check, so a deployment that copied the example file would otherwise sign
 * every session with a key published in the repository.
 */
export const DEV_AUTH_SECRET = 'dev-only-secret-change-me-in-production-0123456789';

/** Whether a candidate secret is safe to sign sessions with in production. */
export function isUsableSecret(value: string | undefined): value is string {
  return typeof value === 'string' && value.length >= 32 && value !== DEV_AUTH_SECRET;
}
