/**
 * Per-user rate limiting for expensive endpoints.
 *
 * Scanning and applying both fan out to a paid AI provider, so an unbounded
 * caller can burn real money in seconds — the subscription quota caps monthly
 * applications, but nothing stops a client from hammering scan, or from
 * retrying apply in a loop. This closes that gap.
 *
 * THE STORE (Stage 24, ADR-0038)
 * ------------------------------
 * Two stores behind one interface. The in-process map is the default: correct
 * for a single instance and honest about its limit — with N instances each
 * holds its own counters, so the effective ceiling is N × the rule (R-16).
 * `RATE_LIMIT_STORE=postgres` selects the shared store: one row per
 * bucket × actor in `RateLimitBucket` (system-only under RLS), consumed by ONE
 * atomic upsert, so every instance charges the same counter and the ceiling
 * is the platform's. It costs one round trip on the endpoints that are
 * limited (sign-in, scan, apply, exports, the health check, the v1 API) and
 * nothing anywhere else. If the shared store cannot be reached the call
 * degrades to the in-process map for that request and logs once — the limit
 * still applies, per instance, rather than failing open or refusing every
 * request because a counter table blinked.
 *
 * `rateLimit` is therefore async. Every caller awaits it; a call site that
 * forgets the `await` gets a Promise whose `.ok` is undefined, which the
 * TypeScript types refuse.
 */

import { redactError } from './log';

export interface RateLimitResult {
  ok: boolean;
  /** Requests still available in the current window. */
  remaining: number;
  /** When the window resets. */
  resetAt: Date;
  /** Seconds to wait, for a Retry-After header. */
  retryAfterSeconds: number;
}

export interface RateLimitRule {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

/** What a store returns after charging one unit: the count INCLUDING this request, and the window's end. */
interface Charge {
  count: number;
  resetAt: number;
}

export interface RateLimitStore {
  readonly backend: 'memory' | 'postgres';
  consume(id: string, rule: RateLimitRule, now: number): Promise<Charge>;
}

// --- in-process store --------------------------------------------------------

interface Bucket {
  count: number;
  resetAt: number;
}

class MemoryStore implements RateLimitStore {
  readonly backend = 'memory' as const;
  private buckets = new Map<string, Bucket>();

  /** Drop expired buckets so the map cannot grow without bound. */
  private sweep(now: number): void {
    if (this.buckets.size < 1000) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  async consume(id: string, rule: RateLimitRule, now: number): Promise<Charge> {
    this.sweep(now);
    const existing = this.buckets.get(id);
    if (!existing || existing.resetAt <= now) {
      const resetAt = now + rule.windowSeconds * 1000;
      this.buckets.set(id, { count: 1, resetAt });
      return { count: 1, resetAt };
    }
    // A refused request is still counted (the shared store does the same), so
    // `remaining` reads the same from either store; `ok` is what matters.
    existing.count += 1;
    return { count: existing.count, resetAt: existing.resetAt };
  }

  clear(): void {
    this.buckets.clear();
  }
}

// --- shared store ------------------------------------------------------------

/**
 * One statement, atomic under concurrency: insert the bucket, or, if it
 * exists, either start a new window (the old one expired) or add one. The
 * RETURNING clause is what the caller compares with the limit, so two
 * instances racing on the same id can never both believe they were the last
 * permitted request. Prisma is loaded lazily so the memory path — every test
 * and every single-instance deployment — never touches the client here.
 */
class PostgresStore implements RateLimitStore {
  readonly backend = 'postgres' as const;

  async consume(id: string, rule: RateLimitRule, now: number): Promise<Charge> {
    const { db } = await import('./db');
    const nowDate = new Date(now);
    const fresh = new Date(now + rule.windowSeconds * 1000);
    const rows = await db.$queryRaw<{ count: number; resetAt: Date }[]>`
      INSERT INTO "RateLimitBucket" ("id", "count", "resetAt") VALUES (${id}, 1, ${fresh})
      ON CONFLICT ("id") DO UPDATE SET
        "count" = CASE WHEN "RateLimitBucket"."resetAt" <= ${nowDate} THEN 1 ELSE "RateLimitBucket"."count" + 1 END,
        "resetAt" = CASE WHEN "RateLimitBucket"."resetAt" <= ${nowDate} THEN ${fresh} ELSE "RateLimitBucket"."resetAt" END
      RETURNING "count", "resetAt"`;
    const row = rows[0];
    if (!row) throw new Error('rate-limit store returned no row');
    return { count: Number(row.count), resetAt: new Date(row.resetAt).getTime() };
  }
}

/** Remove buckets whose window ended more than a day ago; the worker runs this hourly (Stage 24). Returns the number removed. */
export async function sweepRateLimitBuckets(now = new Date()): Promise<number> {
  const { db } = await import('./db');
  const result = await db.rateLimitBucket.deleteMany({ where: { resetAt: { lt: new Date(now.getTime() - 86_400_000) } } });
  return result.count;
}

// --- resolution ----------------------------------------------------------------

const memory = new MemoryStore();
let shared: RateLimitStore | null = null;
let degradedLogged = false;

/** Which store `RATE_LIMIT_STORE` selects: `postgres` for the shared table, anything else (or unset) for the in-process map. */
export function rateLimitStoreName(env: NodeJS.ProcessEnv = process.env): 'memory' | 'postgres' {
  return env.RATE_LIMIT_STORE?.trim().toLowerCase() === 'postgres' ? 'postgres' : 'memory';
}

function store(): RateLimitStore {
  if (rateLimitStoreName() === 'postgres') {
    shared ??= new PostgresStore();
    return shared;
  }
  return memory;
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

function resultOf(charge: Charge, rule: RateLimitRule, now: number): RateLimitResult {
  const ok = charge.count <= rule.limit;
  return {
    ok,
    remaining: Math.max(0, rule.limit - charge.count),
    resetAt: new Date(charge.resetAt),
    retryAfterSeconds: ok ? 0 : Math.max(1, Math.ceil((charge.resetAt - now) / 1000)),
  };
}

/**
 * Consume one unit against a key. Returns whether the caller may proceed.
 *
 * `key` should identify the actor — a user id where the request is
 * authenticated, an IP where it is not.
 */
export async function rateLimit(bucketName: string, key: string, rule: RateLimitRule): Promise<RateLimitResult> {
  const now = Date.now();
  const id = `${bucketName}:${key}`;
  const chosen = store();
  try {
    return resultOf(await chosen.consume(id, rule, now), rule, now);
  } catch (error) {
    if (chosen.backend === 'memory') throw error;
    // The shared store is unreachable: limit per instance for this request
    // rather than fail open (no limit) or closed (refuse everyone). Logged
    // once per process; the health check reports the configured store, and
    // the request log shows this line when it degrades.
    if (!degradedLogged) {
      degradedLogged = true;
      console.error('[rate-limit] shared store unavailable; limiting per instance until it returns:', redactError(error).message);
    }
    return resultOf(await memory.consume(id, rule, now), rule, now);
  }
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

/** Test seam — clears the in-process counters and forgets the shared store. */
export function resetRateLimits(): void {
  memory.clear();
  shared = null;
  degradedLogged = false;
}
