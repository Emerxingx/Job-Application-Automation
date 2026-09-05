/**
 * Read-only offline cache (MOBILE_ARCHITECTURE.md §Offline).
 *
 * What is cached: the last successful body of an allow-listed GET, with the
 * time it was stored. What is never cached: anything that mints or expires
 * (sign-in, device lists, document links), and every write - the app has no
 * offline queue on purpose, because a queued "submit" would fire later
 * without the applicant present, which is exactly what ADR-0016 forbids.
 *
 * A cached body is shown only when the network fails, and always labelled
 * with its age; it is cleared when the session ends so a device that changes
 * hands starts empty.
 */
import { PATHS } from './client';

export interface CacheEntry<T = unknown> {
  storedAt: string;
  body: T;
}

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}

/** Paths whose GET bodies may be kept on the device (templates; a filled path matches its template). */
export const CACHEABLE_PATHS: readonly string[] = [
  PATHS.me,
  PATHS.recommendations,
  PATHS.jobs,
  PATHS.job,
  PATHS.match,
  PATHS.savedJobs,
  PATHS.applications,
  PATHS.application,
  PATHS.interviews,
  PATHS.notifications,
  PATHS.analyticsSummary,
  PATHS.consents,
  PATHS.evidence,
];

/** Cached bodies older than this are not shown even offline. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function templateToRegex(template: string): RegExp {
  return new RegExp('^' + template.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '{' || c === '}' ? c : `\\${c}`)).replace(/\{\w+\}/g, '[^/]+') + '$');
}

const MATCHERS = CACHEABLE_PATHS.map(templateToRegex);

/** Whether a (method, path) may be cached. Only GET, only the allow-list. */
export function isCacheable(method: string, path: string): boolean {
  if (method !== 'GET') return false;
  const bare = path.split('?')[0] ?? path;
  return MATCHERS.some((m) => m.test(bare));
}

export function cacheKey(path: string, query?: Record<string, unknown>): string {
  const q = query
    ? Object.entries(query)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${String(v)}`)
        .join('&')
    : '';
  return q ? `${path}?${q}` : path;
}

export class MemoryStore implements CacheStore {
  private readonly map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.map.set(key, value);
  }
  async remove(key: string) {
    this.map.delete(key);
  }
  async clear() {
    this.map.clear();
  }
}

export class OfflineCache {
  constructor(private readonly store: CacheStore, private readonly now: () => number = Date.now) {}

  async read<T>(key: string): Promise<CacheEntry<T> | null> {
    const raw = await this.store.get(key);
    if (!raw) return null;
    try {
      const entry = JSON.parse(raw) as CacheEntry<T>;
      if (typeof entry.storedAt !== 'string') return null;
      if (this.now() - Date.parse(entry.storedAt) > MAX_AGE_MS) {
        await this.store.remove(key);
        return null;
      }
      return entry;
    } catch {
      await this.store.remove(key);
      return null;
    }
  }

  /** Stores only what the policy allows; a disallowed write is a silent no-op so callers need no branch. */
  async write<T>(method: string, path: string, key: string, body: T): Promise<boolean> {
    if (!isCacheable(method, path)) return false;
    await this.store.set(key, JSON.stringify({ storedAt: new Date(this.now()).toISOString(), body } satisfies CacheEntry<T>));
    return true;
  }

  clear(): Promise<void> {
    return this.store.clear();
  }
}
