import { getPayload } from 'payload';
import config from '@payload-config';
import { getCache } from '@/lib/cache';

/**
 * Fast-read access to the active ATS ruleset for the automation engine.
 *
 * The read path:
 *   1. Cache hit → parse and return (sub-millisecond in memory, single-digit
 *      ms from Redis).
 *   2. Cache miss → one indexed query for the active ruleset, cache it, return.
 *
 * The engine calls this before driving every application form, so the cache
 * is what keeps that off the database. Invalidation is explicit: the CMS
 * afterChange hook on ats-rulesets calls invalidateAtsRuleset, so an operator
 * activating a new version is reflected immediately rather than after a TTL.
 * The TTL is a safety net for the multi-instance memory-cache case, not the
 * primary freshness mechanism.
 */

export interface AtsRuleset {
  id: string;
  atsPlatformName: string;
  version: number;
  navigationFlowType: 'single_page' | 'multi_step' | 'account_required';
  antiBotMitigationLevel: 'standard' | 'heavy_stealth' | 'human_delay';
  selectorMap: Record<string, string>;
  fallbackSelectors: Record<string, string[]>;
  notes?: string;
}

/** How long a cached ruleset is trusted before a re-read. Short: rulesets are hot and small. */
export const ATS_CACHE_TTL_SECONDS = 300;

const cacheKey = (platform: string) => `ats:ruleset:active:${platform.toLowerCase()}`;

/**
 * Return the active ruleset for a platform, or null if none is active.
 * Designed for the hot path — cache first, database only on a miss.
 */
export async function getActiveAtsRuleset(platform: string): Promise<AtsRuleset | null> {
  const key = cacheKey(platform);
  const cache = getCache();

  // 1. Cache.
  try {
    const cached = await cache.get(key);
    if (cached !== null) {
      // Sentinel for "we looked and there is no active ruleset" — avoids
      // hammering the DB for a platform that has none configured yet.
      return cached === '__none__' ? null : (JSON.parse(cached) as AtsRuleset);
    }
  } catch (error) {
    // A cache read failure must not fail the lookup; fall through to the DB.
    console.error('[ats] cache read failed; reading through:', error);
  }

  // 2. Database. One indexed query on (atsPlatformName, isActive).
  const ruleset = await readActiveFromDb(platform);

  // 3. Populate the cache (including the negative result).
  try {
    await cache.set(key, ruleset ? JSON.stringify(ruleset) : '__none__', ATS_CACHE_TTL_SECONDS);
  } catch (error) {
    console.error('[ats] cache write failed; continuing:', error);
  }

  return ruleset;
}

async function readActiveFromDb(platform: string): Promise<AtsRuleset | null> {
  const payload = await getPayload({ config });
  const result = await payload.find({
    collection: 'ats-rulesets',
    where: {
      and: [
        { atsPlatformName: { equals: platform.toLowerCase() } },
        { isActive: { equals: true } },
      ],
    },
    limit: 1,
    depth: 0,
    pagination: false,
  });

  const doc = result.docs[0] as unknown as Record<string, unknown> | undefined;
  if (!doc) return null;

  return {
    id: String(doc.id),
    atsPlatformName: String(doc.atsPlatformName),
    version: Number(doc.version),
    navigationFlowType: doc.navigationFlowType as AtsRuleset['navigationFlowType'],
    antiBotMitigationLevel: doc.antiBotMitigationLevel as AtsRuleset['antiBotMitigationLevel'],
    selectorMap: (doc.selectorMap as Record<string, string>) ?? {},
    fallbackSelectors: (doc.fallbackSelectors as Record<string, string[]>) ?? {},
    notes: typeof doc.notes === 'string' ? doc.notes : undefined,
  };
}

/** Drop a platform's cached ruleset. Called from the CMS afterChange hook. */
export async function invalidateAtsRuleset(platform: string): Promise<void> {
  try {
    await getCache().del(cacheKey(platform));
  } catch (error) {
    console.error('[ats] cache invalidation failed:', error);
  }
}
