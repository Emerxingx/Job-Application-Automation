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
  /** Stage 14 review: sign-in attempts per ACCOUNT (keyed by the digest of the email), whatever address they claim to come from. */
  authAccount: { limit: 30, windowSeconds: 60 * 15 },
  /** Stage 16: the credential what-if, an audited read of the person's eligibility facts per call. */
  careerWhatIf: { limit: 20, windowSeconds: 60 * 10 },
  /** Stage 17 review: case invitations per supervisor and per organisation - an invitation is a row a person sees under Settings; volume is bounded so a roster cannot be sprayed. */
  caseInvite: { limit: 30, windowSeconds: 60 * 60 },
  caseInviteOrganization: { limit: 200, windowSeconds: 60 * 60 * 24 },
  /** Stage 18 review: candidate sourcing scores up to a hundred résumés per call; bounded per requisition. */
  employerSourcing: { limit: 6, windowSeconds: 60 * 10 },
  /** Stage 19 review: representation requests per recruiter and per agency - a request is a row a person sees under Settings, so volume is bounded as case invitations are. */
  representationRequest: { limit: 30, windowSeconds: 60 * 60 },
  representationRequestOrganization: { limit: 200, windowSeconds: 60 * 60 * 24 },
  /** Stage 20: SCIM calls per token - an identity provider syncs in bursts, a leaked token does not get to enumerate quickly. */
  scim: { limit: 120, windowSeconds: 60 },
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
 * How many proxies in front of the app append to X-Forwarded-For. Default 1:
 * one load balancer, the usual managed-hosting shape. 0 means "believe no
 * forwarded header at all".
 */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TRUSTED_PROXY_HOPS ?? '1');
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

/**
 * Best-effort client address, for limiting requests that have no user yet.
 *
 * Stage 14 review: X-Forwarded-For is client-writable, so its LEFTMOST entry
 * is whatever the caller wrote and keying a limiter on it hands out a fresh
 * bucket per request. Each trusted proxy APPENDS the address it saw, so the
 * believable entry is the one `hops` from the right; anything to its left is
 * untrusted and ignored. With zero hops the header is ignored entirely and
 * every anonymous caller shares one bucket - honest about what the app can
 * know without a proxy (a Next route handler has no socket address). An
 * address limit is therefore never the only bound on a credential endpoint:
 * the sign-in routes also budget attempts PER ACCOUNT (`LIMITS.authAccount`).
 */
export function clientAddress(request: Request, hops: number = trustedProxyHops()): string {
  if (hops > 0) {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
      const parts = forwarded.split(',').map((p) => p.trim()).filter(Boolean);
      const candidate = parts[parts.length - hops];
      if (candidate) return candidate;
    }
    const real = request.headers.get('x-real-ip');
    if (real) return real.trim();
  }
  return 'unknown';
}

/** Test seam — clears all counters. */
export function resetRateLimits(): void {
  buckets.clear();
}
