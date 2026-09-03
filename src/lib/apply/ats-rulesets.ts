import type { AtsRuleset, Prisma } from '@prisma/client';
import { db } from '../db';
import type { StaffContext } from '../crm/auth';
import { getCache } from '../cache';

/**
 * The governed ATS ruleset registry (ADR-0019 Tier 1; MASTER_BUILD_PLAN
 * Stage 05 exit: "AtsRulesets under governed administration"). Moved out of
 * the editorial CMS in Stage 05: a ruleset drives how the automation engine
 * fills a real employer's form, which is security-relevant configuration and
 * not a marketing editor's to change.
 *
 * LIFECYCLE — the same discipline as PromptVersion:
 *   draft ──approve (a second admin)──▶ approved ──activate──▶ active
 *   (one active per platform; activating an older approved version is the
 *   rollback, recorded as one) ──▶ retired (never the active one).
 *
 * NO STEALTH. The CMS collection offered a "heavy stealth" anti-bot level.
 * ADR-0008 prohibits fingerprint evasion outright, so `pacing` here is
 * `standard` or `human_delay` — pacing exists to respect a site, and
 * `human_delay` additionally means assisted-apply only. A ruleset cannot
 * express evasion.
 *
 * The read path is cache-first for the engine and the v1 API; activation
 * invalidates the platform's key, so a rollback takes effect immediately.
 */

export const ATS_PLATFORMS = ['greenhouse', 'lever', 'workday', 'workable', 'taleo', 'ashby', 'smartrecruiters', 'icims', 'linkedin'] as const;
export type AtsPlatform = (typeof ATS_PLATFORMS)[number];
export const NAVIGATION_FLOWS = ['single_page', 'multi_step', 'account_required'] as const;
export const PACING = ['standard', 'human_delay'] as const;

/** The selector keys the engine expects. Kept in sync with the automation code. */
export const REQUIRED_SELECTOR_KEYS = ['first_name', 'last_name', 'email', 'phone', 'resume_upload', 'cover_letter_input', 'submit_button', 'next_step_button'] as const;

export const ATS_CACHE_TTL_SECONDS = 300;
const cacheKey = (platform: string) => `ats:ruleset:active:${platform.toLowerCase()}`;

export class AtsRulesetError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = 'AtsRulesetError';
    this.status = status;
  }
}

export interface ActiveAtsRuleset {
  id: string;
  atsPlatformName: string;
  version: number;
  navigationFlowType: string;
  pacing: string;
  selectorMap: Record<string, string>;
  fallbackSelectors: Record<string, string[]>;
  notes?: string;
}

export function isAtsPlatform(value: string): value is AtsPlatform {
  return (ATS_PLATFORMS as readonly string[]).includes(value);
}

/** selectorMap must carry every required key as a non-empty string. */
export function validateSelectorMap(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'selectorMap must be a JSON object.';
  const map = value as Record<string, unknown>;
  for (const key of REQUIRED_SELECTOR_KEYS) {
    if (typeof map[key] !== 'string' || !(map[key] as string).trim()) return `selectorMap is missing "${key}".`;
  }
  return null;
}

/** fallbackSelectors, when present, maps selector keys to arrays of non-empty strings. */
export function validateFallbackSelectors(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'fallbackSelectors must be a JSON object.';
  for (const [key, list] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(list) || list.some((s) => typeof s !== 'string' || !s.trim())) return `fallbackSelectors["${key}"] must be an array of selector strings.`;
  }
  return null;
}

function toActive(r: AtsRuleset): ActiveAtsRuleset {
  const parse = <T,>(s: string, fallback: T): T => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: r.id,
    atsPlatformName: r.platform,
    version: r.version,
    navigationFlowType: r.navigationFlowType,
    pacing: r.pacing,
    selectorMap: parse<Record<string, string>>(r.selectorMap, {}),
    fallbackSelectors: parse<Record<string, string[]>>(r.fallbackSelectors, {}),
    notes: r.notes || undefined,
  };
}

/** The active ruleset for a platform, cache-first. Null when none is active. */
export async function getActiveAtsRuleset(platform: string): Promise<ActiveAtsRuleset | null> {
  const key = cacheKey(platform);
  const cache = getCache();
  try {
    const cached = await cache.get(key);
    if (cached !== null) return cached === '__none__' ? null : (JSON.parse(cached) as ActiveAtsRuleset);
  } catch (error) {
    console.error('[ats] cache read failed; reading through:', error);
  }
  const row = await db.atsRuleset.findFirst({ where: { platform: platform.toLowerCase(), status: 'active' } });
  const ruleset = row ? toActive(row) : null;
  try {
    await cache.set(key, ruleset ? JSON.stringify(ruleset) : '__none__', ATS_CACHE_TTL_SECONDS);
  } catch (error) {
    console.error('[ats] cache write failed; continuing:', error);
  }
  return ruleset;
}

export async function invalidateAtsRuleset(platform: string): Promise<void> {
  try {
    await getCache().del(cacheKey(platform));
  } catch (error) {
    console.error('[ats] cache invalidation failed:', error);
  }
}

// --- administration ------------------------------------------------------------

export interface NewAtsRulesetInput {
  platform: string;
  navigationFlowType: string;
  pacing: string;
  selectorMap: Record<string, string>;
  fallbackSelectors?: Record<string, string[]> | null;
  notes?: string;
}

export function validateRulesetInput(input: NewAtsRulesetInput): string | null {
  if (!isAtsPlatform(input.platform)) return `Unknown platform "${input.platform}".`;
  if (!(NAVIGATION_FLOWS as readonly string[]).includes(input.navigationFlowType)) return 'Unknown navigation flow.';
  if (!(PACING as readonly string[]).includes(input.pacing)) return 'pacing must be standard or human_delay; there is no evasion setting (ADR-0008).';
  return validateSelectorMap(input.selectorMap) ?? validateFallbackSelectors(input.fallbackSelectors ?? null);
}

async function lockPlatform(tx: Prisma.TransactionClient, platform: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'ats:' + platform}::text))`;
}

function snapshot(r: AtsRuleset) {
  return { platform: r.platform, version: r.version, status: r.status, pacing: r.pacing, navigationFlowType: r.navigationFlowType, selectorKeys: Object.keys(JSON.parse(r.selectorMap || '{}')).sort() };
}

async function audit(tx: Prisma.TransactionClient, action: string, actor: StaffContext, before: AtsRuleset | null, after: AtsRuleset, summary: string, reason: string | null) {
  await tx.auditLog.create({
    data: {
      actorType: 'staff',
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      action,
      entityType: 'AtsRuleset',
      entityId: after.id,
      summary,
      before: JSON.stringify(before ? snapshot(before) : {}),
      after: JSON.stringify(snapshot(after)),
      changedFields: JSON.stringify(before ? (Object.keys(snapshot(after)) as (keyof ReturnType<typeof snapshot>)[]).filter((k) => JSON.stringify(snapshot(before)[k]) !== JSON.stringify(snapshot(after)[k])) : Object.keys(snapshot(after))),
      reason,
    },
  });
}

export async function listAtsRulesets(client: Prisma.TransactionClient | typeof db = db): Promise<AtsRuleset[]> {
  return client.atsRuleset.findMany({ orderBy: [{ platform: 'asc' }, { version: 'desc' }] });
}

export async function createAtsRuleset(input: NewAtsRulesetInput, actor: StaffContext, reason: string | null = null): Promise<AtsRuleset> {
  const problem = validateRulesetInput(input);
  if (problem) throw new AtsRulesetError(problem, 422);
  return db.$transaction(async (tx) => {
    await lockPlatform(tx, input.platform);
    const latest = await tx.atsRuleset.findFirst({ where: { platform: input.platform }, orderBy: { version: 'desc' }, select: { version: true } });
    const created = await tx.atsRuleset.create({
      data: {
        platform: input.platform,
        version: (latest?.version ?? 0) + 1,
        navigationFlowType: input.navigationFlowType,
        pacing: input.pacing,
        selectorMap: JSON.stringify(input.selectorMap),
        fallbackSelectors: JSON.stringify(input.fallbackSelectors ?? {}),
        notes: input.notes ?? '',
        createdById: actor.id,
        createdByEmail: actor.email,
      },
    });
    await audit(tx, 'ats_ruleset.create', actor, null, created, `Created ${created.platform} ruleset v${created.version} (draft).`, reason);
    return created;
  });
}

async function load(tx: Prisma.TransactionClient, id: string): Promise<AtsRuleset> {
  const r = await tx.atsRuleset.findUnique({ where: { id } });
  if (!r) throw new AtsRulesetError('That ruleset does not exist.', 404);
  return r;
}

/** draft → approved, by a second admin. */
export async function approveAtsRuleset(id: string, actor: StaffContext, reason: string | null = null): Promise<AtsRuleset> {
  return db.$transaction(async (tx) => {
    const before = await load(tx, id);
    await lockPlatform(tx, before.platform);
    if (before.status !== 'draft') throw new AtsRulesetError(`Only a draft can be approved; this version is ${before.status}.`);
    if (before.createdById && before.createdById === actor.id) throw new AtsRulesetError('A ruleset cannot be approved by the person who created it; a second admin must approve.', 403);
    const after = await tx.atsRuleset.update({ where: { id }, data: { status: 'approved', approvedById: actor.id, approvedByEmail: actor.email, approvedAt: new Date() } });
    await audit(tx, 'ats_ruleset.approve', actor, before, after, `Approved ${after.platform} ruleset v${after.version}.`, reason);
    return after;
  });
}

/** approved → active, demoting the current active version to approved. Older target = rollback. */
export async function activateAtsRuleset(id: string, actor: StaffContext, reason: string | null = null): Promise<AtsRuleset> {
  const result = await db.$transaction(async (tx) => {
    const before = await load(tx, id);
    await lockPlatform(tx, before.platform);
    if (before.status === 'active') throw new AtsRulesetError('This version is already active.');
    if (before.status !== 'approved') throw new AtsRulesetError(`Only an approved version can be activated; this version is ${before.status}.`);
    const current = await tx.atsRuleset.findFirst({ where: { platform: before.platform, status: 'active' } });
    if (current) await tx.atsRuleset.update({ where: { id: current.id }, data: { status: 'approved' } });
    const after = await tx.atsRuleset.update({ where: { id }, data: { status: 'active' } });
    const rollback = current !== null && current.version > after.version;
    await audit(tx, rollback ? 'ats_ruleset.rollback' : 'ats_ruleset.activate', actor, before, after, rollback ? `Rolled ${after.platform} back from v${current!.version} to v${after.version}.` : `Activated ${after.platform} ruleset v${after.version}${current ? ` (was v${current.version})` : ''}.`, reason);
    return after;
  });
  await invalidateAtsRuleset(result.platform);
  return result;
}

/** Any non-active version → retired. */
export async function retireAtsRuleset(id: string, actor: StaffContext, reason: string | null = null): Promise<AtsRuleset> {
  return db.$transaction(async (tx) => {
    const before = await load(tx, id);
    await lockPlatform(tx, before.platform);
    if (before.status === 'active') throw new AtsRulesetError('The active ruleset cannot be retired; activate another version first.');
    if (before.status === 'retired') throw new AtsRulesetError('This version is already retired.');
    const after = await tx.atsRuleset.update({ where: { id }, data: { status: 'retired' } });
    await audit(tx, 'ats_ruleset.retire', actor, before, after, `Retired ${after.platform} ruleset v${after.version}.`, reason);
    return after;
  });
}
