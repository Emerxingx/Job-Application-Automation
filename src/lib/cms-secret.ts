/**
 * Signing-key guard for the CMS admin (Payload).
 *
 * Deliberately independent from `src/lib/auth.ts`'s equivalent guard for
 * AUTH_SECRET, even though the logic is near-identical: PAYLOAD_SECRET signs
 * CMS editor sessions, AUTH_SECRET signs job-seeker sessions, and the two
 * must never be interchangeable — sharing a key, or sharing a validator that
 * accepts either placeholder, would let a leaked value compromise both
 * systems at once. Same discipline, kept separate on purpose.
 */

/**
 * The development fallback. It also ships in `.env.example`, which is exactly
 * why production has to reject it by value: it is long enough to pass a
 * length check, so a deployment that copied the example file would otherwise
 * sign every CMS session with a key published in the repository.
 */
export const DEV_PAYLOAD_SECRET = 'dev-only-payload-secret-change-me-0123456789ab';

/** Whether a candidate secret is safe to sign CMS sessions with in production. */
export function isUsablePayloadSecret(value: string | undefined): value is string {
  return typeof value === 'string' && value.length >= 32 && value !== DEV_PAYLOAD_SECRET;
}

/**
 * Whether this process is `next build` rather than a running server.
 *
 * The Payload config is evaluated at module load, which Next.js does while
 * collecting page data during a build. A build signs nothing and serves no
 * one, and CI legitimately builds without production runtime secrets — so
 * refusing to build would punish correct practice. The check that matters is
 * the one below, at server start.
 */
function isProductionBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build';
}

/** Resolve PAYLOAD_SECRET, refusing a weak or publicly-known key in production. */
export function resolvePayloadSecret(): string {
  const value = process.env.PAYLOAD_SECRET;
  if (!isUsablePayloadSecret(value)) {
    if (process.env.NODE_ENV === 'production' && !isProductionBuildPhase()) {
      throw new Error(
        'PAYLOAD_SECRET must be set to a generated value of at least 32 characters in production. ' +
          'The placeholder from .env.example is not accepted — run: openssl rand -base64 32',
      );
    }
    return DEV_PAYLOAD_SECRET;
  }
  return value;
}
