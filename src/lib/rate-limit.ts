/**
 * Per-user rate limiting for expensive endpoints.
 *
 * Scanning and applying both fan out to a paid AI provider, so an unbounded
 * caller can burn real money in seconds — the subscription quota caps monthly
 * applications, but nothing stops a client from hammering scan, or from
 * retrying apply in a loop. This closes that gap.
 *
 * The store is in-process, which is correct for a single instance and honest
 * about its limit: on multiple instances each holds its own counters, so the
 * effective ceiling is per instance. Point `RATE_LIMIT_STORE=redis` at a shared
 * store before scaling horizontally — the interface below is what that
 * implementation has to satisfy.
 */

export interface RateLimitResult {
  ok: boolean;
  /** Requests still available in the current window. */
  remaining: number;
  /** When the window resets. */
  resetAt: Date;
  /** Seconds to wait, for a Retry-After header. */
  retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Drop expired buckets so the map cannot grow without bound. */
function sweep(now: number): void {
  if (buckets.size < 1000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export interface RateLimitRule {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

/** Named limits for the endpoints that cost money to serve. */
export const LIMITS = {
  /** Scanning fans out across every agent and scores each posting. */
  scan: { limit: 10, windowSeconds: 60 * 10 },
  /** Applying tailors a resume per job — the most expensive call we make. */
  apply: { limit: 20, windowSeconds: 60 * 10 },
  /** Interview prep generates a full pack. */
  interviewPrep: { limit: 15, windowSeconds: 60 * 10 },
  /** Auth endpoints, to blunt credential stuffing. */
  auth: { limit: 10, windowSeconds: 60 * 5 },
  /** Stage 13: a candidate rebuilding their own analytics marts — bounded to their rows, but a scan of them. */
  analyticsRefresh: { limit: 3, windowSeconds: 60 * 10 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Consume one unit against a key. Returns whether the caller may proceed.
 *
 * `key` should identify the actor — a user id where the request is
 * authenticated, an IP where it is not.
 */
export function rateLimit(bucketName: string, key: string, rule: RateLimitRule): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const id = `${bucketName}:${key}`;
  const existing = buckets.get(id);

  if (!existing || existing.resetAt <= now) {
    const resetAt = now + rule.windowSeconds * 1000;
    buckets.set(id, { count: 1, resetAt });
    return {
      ok: true,
      remaining: rule.limit - 1,
      resetAt: new Date(resetAt),
      retryAfterSeconds: 0,
    };
  }

  if (existing.count >= rule.limit) {
    return {
      ok: false,
      remaining: 0,
      resetAt: new Date(existing.resetAt),
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return {
    ok: true,
    remaining: rule.limit - existing.count,
    resetAt: new Date(existing.resetAt),
    retryAfterSeconds: 0,
  };
}

/**
 * Best-effort client address, for limiting requests that have no user yet.
 * Only trusted when the deployment sits behind a proxy that sets these.
 */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}

/** Test seam — clears all counters. */
export function resetRateLimits(): void {
  buckets.clear();
}
