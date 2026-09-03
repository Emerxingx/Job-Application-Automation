import type { MatchWeightVersion, Prisma } from '@prisma/client';
import { db } from '../db';
import type { StaffContext } from '../crm/auth';
import { getCache } from '../cache';

/**
 * Stage 08 — compatibility weights as governed, versioned data.
 *
 * The weights the deterministic stage combines its dimensions with were
 * constants in code. They are now a register administered in the console
 * with the PromptVersion discipline: draft → approved by a SECOND admin →
 * active (one at a time; activating an older version is the rollback,
 * recorded as one) → retired. Every `JobMatch` records the version it was
 * scored with, so a weight change never rewrites a stored score's meaning.
 *
 * Fail-closed default: until a version is active the BUILT-IN weights apply
 * (the tested baseline the engine shipped with) and are recorded as
 * `builtin:1`. Nothing is seeded as active by a migration.
 */

export const DIMENSIONS = ['skills', 'keywords', 'experience', 'seniority', 'location'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export type Weights = Record<Dimension, number>;

/** The engine's original constants. Changing these is a code change with a version bump, never a silent edit. */
export const BUILTIN_WEIGHTS: Weights = { skills: 0.34, keywords: 0.22, experience: 0.22, seniority: 0.14, location: 0.08 };
export const BUILTIN_WEIGHT_VERSION = 'builtin:1';

export interface ActiveWeights {
  /** `builtin:1` or `v<n>` for an activated register row. */
  version: string;
  weights: Weights;
}

export class MatchWeightError extends Error {
  constructor(
    message: string,
    readonly status: number = 409,
  ) {
    super(message);
    this.name = 'MatchWeightError';
  }
}

const CACHE_KEY = 'match:weights:active';
const CACHE_TTL_SECONDS = 300;

/** Weights must name every dimension, each in [0, 1], summing to 1 (±0.001). */
export function validateWeights(input: unknown): string | null {
  if (!input || typeof input !== 'object') return 'weights must be an object';
  const w = input as Record<string, unknown>;
  const keys = Object.keys(w).sort();
  if (keys.join(',') !== [...DIMENSIONS].sort().join(',')) return `weights must name exactly: ${DIMENSIONS.join(', ')}`;
  let sum = 0;
  for (const d of DIMENSIONS) {
    const v = w[d];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return `${d} must be a number between 0 and 1`;
    sum += v;
  }
  if (Math.abs(sum - 1) > 0.001) return `weights must sum to 1 (they sum to ${sum.toFixed(3)})`;
  return null;
}

export function parseWeights(json: string): Weights {
  const parsed = JSON.parse(json) as Weights;
  const problem = validateWeights(parsed);
  if (problem) throw new MatchWeightError(`stored weights are invalid: ${problem}`, 500);
  return parsed;
}

/** The weights to score with now: the active register version, else the built-in baseline. Cache-first. */
export async function getActiveWeights(client: Prisma.TransactionClient | typeof db = db): Promise<ActiveWeights> {
  const cache = getCache();
  try {
    const cached = await cache.get(CACHE_KEY);
    if (cached !== null) return JSON.parse(cached) as ActiveWeights;
  } catch (error) {
    console.error('[matching] cache read failed; reading through:', error);
  }
  const active = await client.matchWeightVersion.findFirst({ where: { status: 'active' } });
  const result: ActiveWeights = active ? { version: `v${active.version}`, weights: parseWeights(active.weights) } : { version: BUILTIN_WEIGHT_VERSION, weights: BUILTIN_WEIGHTS };
  try {
    await cache.set(CACHE_KEY, JSON.stringify(result), CACHE_TTL_SECONDS);
  } catch (error) {
    console.error('[matching] cache write failed; continuing:', error);
  }
  return result;
}

export async function invalidateActiveWeights(): Promise<void> {
  try {
    await getCache().del(CACHE_KEY);
  } catch (error) {
    console.error('[matching] cache invalidation failed:', error);
  }
}

// ---------------------------------------------------------------------------
// Governance

async function lock(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'match:weights'}::text))`;
}

function snapshot(r: MatchWeightVersion) {
  return { version: r.version, status: r.status, weights: r.weights, notes: r.notes, createdByEmail: r.createdByEmail, approvedByEmail: r.approvedByEmail };
}

async function audit(tx: Prisma.TransactionClient, action: string, actor: StaffContext, before: MatchWeightVersion | null, after: MatchWeightVersion, summary: string, reason: string | null) {
  await tx.auditLog.create({
    data: {
      actorType: 'staff',
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      action,
      entityType: 'MatchWeightVersion',
      entityId: after.id,
      summary,
      before: JSON.stringify(before ? snapshot(before) : {}),
      after: JSON.stringify(snapshot(after)),
      changedFields: JSON.stringify(before ? (Object.keys(snapshot(after)) as (keyof ReturnType<typeof snapshot>)[]).filter((k) => JSON.stringify(snapshot(before)[k]) !== JSON.stringify(snapshot(after)[k])) : Object.keys(snapshot(after))),
      reason,
    },
  });
}

async function load(tx: Prisma.TransactionClient, id: string): Promise<MatchWeightVersion> {
  const r = await tx.matchWeightVersion.findUnique({ where: { id } });
  if (!r) throw new MatchWeightError('That weight version does not exist.', 404);
  return r;
}

/** Lock, then read: every state check runs against the row as it is under the lock. */
async function loadLocked(tx: Prisma.TransactionClient, id: string): Promise<MatchWeightVersion> {
  await lock(tx);
  return load(tx, id);
}

export async function listWeightVersions(client: Prisma.TransactionClient | typeof db = db): Promise<MatchWeightVersion[]> {
  return client.matchWeightVersion.findMany({ orderBy: { version: 'desc' } });
}

export async function createWeightVersion(input: { weights: Weights; notes?: string }, actor: StaffContext, reason: string | null = null): Promise<MatchWeightVersion> {
  const problem = validateWeights(input.weights);
  if (problem) throw new MatchWeightError(problem, 422);
  return db.$transaction(async (tx) => {
    await lock(tx);
    const latest = await tx.matchWeightVersion.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
    const created = await tx.matchWeightVersion.create({
      data: { version: (latest?.version ?? 0) + 1, weights: JSON.stringify(input.weights), notes: input.notes ?? '', createdById: actor.id, createdByEmail: actor.email },
    });
    await audit(tx, 'match_weights.create', actor, null, created, `Created compatibility weights v${created.version} (draft).`, reason);
    return created;
  });
}

/** draft → approved, by a second admin. */
export async function approveWeightVersion(id: string, actor: StaffContext, reason: string | null = null): Promise<MatchWeightVersion> {
  return db.$transaction(async (tx) => {
    const before = await loadLocked(tx, id);
    if (before.status !== 'draft') throw new MatchWeightError(`Only a draft can be approved; this version is ${before.status}.`);
    if (before.createdById && before.createdById === actor.id) throw new MatchWeightError('Weights cannot be approved by the person who created them; a second admin must approve.', 403);
    const after = await tx.matchWeightVersion.update({ where: { id }, data: { status: 'approved', approvedById: actor.id, approvedByEmail: actor.email, approvedAt: new Date() } });
    await audit(tx, 'match_weights.approve', actor, before, after, `Approved compatibility weights v${after.version}.`, reason);
    return after;
  });
}

/** approved → active, demoting the current active version to approved. An older target is the rollback. */
export async function activateWeightVersion(id: string, actor: StaffContext, reason: string | null = null): Promise<MatchWeightVersion> {
  const result = await db.$transaction(async (tx) => {
    const before = await loadLocked(tx, id);
    if (before.status === 'active') throw new MatchWeightError('This version is already active.');
    if (before.status !== 'approved') throw new MatchWeightError(`Only an approved version can be activated; this version is ${before.status}.`);
    const current = await tx.matchWeightVersion.findFirst({ where: { status: 'active' } });
    if (current) await tx.matchWeightVersion.update({ where: { id: current.id }, data: { status: 'approved' } });
    const after = await tx.matchWeightVersion.update({ where: { id }, data: { status: 'active', activatedAt: new Date() } });
    const rollback = current !== null && current.version > after.version;
    await audit(tx, rollback ? 'match_weights.rollback' : 'match_weights.activate', actor, before, after, rollback ? `Rolled compatibility weights back from v${current!.version} to v${after.version}.` : `Activated compatibility weights v${after.version}${current ? ` (was v${current.version})` : ' (was the built-in baseline)'}.`, reason);
    return after;
  });
  await invalidateActiveWeights();
  return result;
}

/** Any non-active version → retired. */
export async function retireWeightVersion(id: string, actor: StaffContext, reason: string | null = null): Promise<MatchWeightVersion> {
  return db.$transaction(async (tx) => {
    const before = await loadLocked(tx, id);
    if (before.status === 'active') throw new MatchWeightError('The active weights cannot be retired; activate another version first (or the built-in baseline applies when none is active).');
    if (before.status === 'retired') throw new MatchWeightError('This version is already retired.');
    const after = await tx.matchWeightVersion.update({ where: { id }, data: { status: 'retired' } });
    await audit(tx, 'match_weights.retire', actor, before, after, `Retired compatibility weights v${after.version}.`, reason);
    return after;
  });
}
