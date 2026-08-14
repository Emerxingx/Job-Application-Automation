/**
 * A tiny cache abstraction with two backends.
 *
 * The automation engine polls the CMS for ATS rulesets on a hot path — it
 * must not hit the database on every application. This gives it a sub-10ms
 * read: Redis in production (shared across instances, survives restarts), a
 * process-local TTL map in development (zero config, so the app runs with no
 * Redis running).
 *
 * The backend is chosen by REDIS_URL, the same "works with zero config,
 * upgrades when a credential appears" pattern used for the job/AI/payment
 * providers. Nothing in the app depends on Redis being present.
 */

export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** For metrics/tests: which backend is live. */
  readonly backend: 'redis' | 'memory';
}

// --- in-memory backend -----------------------------------------------------

interface Entry {
  value: string;
  expiresAt: number;
}

/**
 * Process-local cache. Correct for a single instance and honest about its
 * limit: with N instances each holds its own copy, so an invalidation on one
 * does not reach the others until their own entries expire. The TTL bounds
 * that staleness; see CACHE_TTL_SECONDS at the call sites.
 */
class MemoryCache implements Cache {
  readonly backend = 'memory' as const;
  private store = new Map<string, Entry>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    // Bound memory: opportunistically sweep expired entries when the map grows.
    if (this.store.size > 500) {
      const now = Date.now();
      for (const [k, e] of this.store) if (e.expiresAt <= now) this.store.delete(k);
    }
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

// --- redis backend ---------------------------------------------------------

class RedisCache implements Cache {
  readonly backend = 'redis' as const;
  // Typed loosely so ioredis stays a lazy require — the SDK never loads when
  // REDIS_URL is unset.
  private client: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: string, ttl: number): Promise<unknown>;
    del(key: string): Promise<unknown>;
  };

  constructor(url: string) {
    const Redis = require('ioredis') as new (url: string, opts?: unknown) => RedisCache['client'];
    this.client = new Redis(url, {
      // Fail fast rather than hanging a request when Redis is unreachable; the
      // caller falls back to a direct read.
      maxRetriesPerRequest: 1,
      connectTimeout: 500,
      enableOfflineQueue: false,
    });
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    // EX = expire in seconds. One round trip, atomic set-with-expiry.
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}

// --- resolution ------------------------------------------------------------

let cache: Cache | null = null;

/** Resolve the process-wide cache. Memoized so one connection is reused. */
export function getCache(): Cache {
  if (cache) return cache;
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      cache = new RedisCache(url);
      return cache;
    } catch (error) {
      // A Redis misconfiguration must never take the engine down — degrade to
      // the in-memory cache and a direct DB read on miss.
      console.error('[cache] REDIS_URL set but Redis init failed; using in-memory cache:', error);
    }
  }
  cache = new MemoryCache();
  return cache;
}

/** Test seam — clears the memoized instance. */
export function resetCache(): void {
  cache = null;
}
