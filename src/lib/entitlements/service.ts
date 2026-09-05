/**
 * Stage 15 (ADR-0010, ADR-0030) - the entitlement service: the ONE place that
 * answers "may this account do X right now", and the only writer of
 * `Entitlement` rows.
 *
 *   payment state  → did money move?           (Subscription, Invoice, Payment)
 *   entitlement    → what may the account do?  (this module)
 *
 * A plan transition GRANTS or REVOKES plan-sourced rows; a trial, a comp, a
 * pilot, a licence or a bonus is a row of its own source; a refund touches
 * nothing here (a refund is money, not access - `revokeEntitlement` is a
 * separate, audited, staff act). Every grant and revocation is an audit
 * event carrying the capability, the source and the reason - never an amount.
 *
 * Rows are written on the SYSTEM client, deliberately: a tenant transaction
 * may read its own rows (RLS: userOrOrg) but the decision to grant belongs
 * to a plan transition, a webhook or staff, none of which act as the tenant.
 * Reads for a feature check go through `entitlementsFor` and friends.
 */
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { recordSecurityEvent, type RequestMeta } from '@/lib/security-audit';
import {
  CAPABILITIES,
  allows,
  grantsForPlan,
  isCapability,
  quantityOf,
  resolveEntitlements,
  type Capability,
  type EntitlementSet,
  type EntitlementSource,
  type Grant,
  type PlanShape,
  type RevokeReason,
} from './capabilities';

type Client = Prisma.TransactionClient | typeof db;

export type Subject = { userId: string; organizationId?: undefined } | { organizationId: string; userId?: undefined };

export interface GrantInput {
  subject: Subject;
  capability: Capability;
  quantity?: number;
  source: EntitlementSource;
  /** e.g. `${subscriptionId}:${planCode}`, an invoice id, a licence reference. */
  sourceRef?: string | null;
  expiresAt?: Date | null;
  grantedBy?: string;
  note?: string;
  meta?: RequestMeta;
}

export class EntitlementError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'EntitlementError';
    this.status = status;
  }
}

export function dedupeKeyFor(subject: Subject, capability: string, source: string, sourceRef: string | null | undefined): string {
  const who = subject.userId ? `user:${subject.userId}` : `org:${subject.organizationId}`;
  return `${who}:${capability}:${source}:${sourceRef ?? ''}`;
}

function subjectWhere(subject: Subject) {
  return subject.userId ? { userId: subject.userId } : { organizationId: subject.organizationId };
}

function actorFor(grantedBy: string | undefined) {
  if (grantedBy && grantedBy.startsWith('staff:')) return { type: 'staff' as const, id: grantedBy.slice('staff:'.length) };
  return { type: 'system' as const };
}

/**
 * Grant, idempotently. The same (subject, capability, source, sourceRef)
 * upserts: a replayed webhook, a second click, a re-sync after a plan change
 * back to the earlier plan all land on the one row, reactivating it if it had
 * been revoked. A quantity or expiry that changed is updated in place and
 * audited as a grant; nothing else is written when nothing changed.
 */
export async function grantEntitlement(client: Client, input: GrantInput): Promise<{ id: string; changed: boolean }> {
  const def = CAPABILITIES[input.capability];
  if (!def) throw new EntitlementError(`Unknown capability ${input.capability}.`);
  if (def.kind === 'quantity' && (input.quantity === undefined || !Number.isInteger(input.quantity) || input.quantity < 0)) {
    throw new EntitlementError(`${input.capability} needs a non-negative integer quantity.`);
  }
  if (def.kind === 'boolean' && input.quantity !== undefined) throw new EntitlementError(`${input.capability} is a boolean capability.`);
  const dedupeKey = dedupeKeyFor(input.subject, input.capability, input.source, input.sourceRef);
  const existing = await client.entitlement.findUnique({ where: { dedupeKey } });
  const expiresAt = input.expiresAt ?? null;
  const quantity = def.kind === 'quantity' ? (input.quantity as number) : null;
  const grantedBy = input.grantedBy ?? 'system';

  if (existing && existing.revokedAt === null && existing.quantity === quantity && (existing.expiresAt?.getTime() ?? null) === (expiresAt?.getTime() ?? null)) {
    return { id: existing.id, changed: false };
  }

  const row = existing
    ? await client.entitlement.update({
        where: { id: existing.id },
        data: { quantity, expiresAt, revokedAt: null, revokedBy: null, revokedReason: null, grantedAt: new Date(), grantedBy, note: input.note ?? existing.note },
      })
    : await client.entitlement.create({
        data: { ...subjectWhere(input.subject), capability: input.capability, kind: def.kind, quantity, source: input.source, sourceRef: input.sourceRef ?? null, dedupeKey, expiresAt, grantedBy, note: input.note ?? '' },
      });

  await recordSecurityEvent(
    {
      event: 'entitlement.granted',
      user: input.subject.userId ? { id: input.subject.userId, email: '' } : null,
      actor: actorFor(grantedBy),
      entityType: 'Entitlement',
      entityId: row.id,
      summary: existing ? `Entitlement ${input.capability} refreshed (${input.source})` : `Entitlement ${input.capability} granted (${input.source})`,
      detail: { capability: input.capability, quantity, source: input.source, sourceRef: input.sourceRef ?? null, expiresAt: expiresAt?.toISOString() ?? null, organizationId: input.subject.organizationId ?? null, reactivated: Boolean(existing?.revokedAt) },
      meta: input.meta,
    },
    client,
  );
  return { id: row.id, changed: true };
}

export interface RevokeInput {
  reason: RevokeReason;
  revokedBy?: string;
  meta?: RequestMeta;
  note?: string;
}

/** Revoke one row. Idempotent: an already-revoked row keeps its timestamp and reason. */
export async function revokeEntitlement(client: Client, id: string, input: RevokeInput): Promise<boolean> {
  const row = await client.entitlement.findUnique({ where: { id } });
  if (!row) return false;
  if (row.revokedAt !== null) return true;
  await client.entitlement.update({ where: { id }, data: { revokedAt: new Date(), revokedBy: input.revokedBy ?? 'system', revokedReason: input.reason, note: input.note ?? row.note } });
  await recordSecurityEvent(
    {
      event: 'entitlement.revoked',
      user: row.userId ? { id: row.userId, email: '' } : null,
      actor: actorFor(input.revokedBy),
      entityType: 'Entitlement',
      entityId: row.id,
      summary: `Entitlement ${row.capability} revoked (${input.reason})`,
      detail: { capability: row.capability, source: row.source, sourceRef: row.sourceRef, reason: input.reason, organizationId: row.organizationId },
      reason: input.reason,
      meta: input.meta,
    },
    client,
  );
  return true;
}

/** Revoke every active row of one source for a subject (optionally one sourceRef). Returns how many. */
export async function revokeBySource(client: Client, subject: Subject, source: EntitlementSource, input: RevokeInput & { sourceRef?: string | null; except?: Set<string> }): Promise<number> {
  const rows = await client.entitlement.findMany({
    where: { ...subjectWhere(subject), source, revokedAt: null, ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {}) },
    select: { id: true },
  });
  let n = 0;
  for (const r of rows) {
    if (input.except?.has(r.id)) continue;
    if (await revokeEntitlement(client, r.id, input)) n += 1;
  }
  return n;
}

/**
 * The rows that apply to a person: their own, plus those of every
 * organization they are an accepted member of (a pooled B2B / B2G licence
 * reaches its seats this way; Stage 18-19 add the per-seat accounting).
 */
export async function activeRowsFor(client: Client, userId: string, now: Date = new Date()) {
  const memberships = await client.membership.findMany({ where: { userId, acceptedAt: { not: null }, removedAt: null }, select: { organizationId: true } });
  const orgIds = memberships.map((m) => m.organizationId);
  return client.entitlement.findMany({
    where: {
      revokedAt: null,
      OR: [{ userId }, ...(orgIds.length ? [{ organizationId: { in: orgIds } }] : [])],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
    select: { id: true, capability: true, kind: true, quantity: true, source: true, expiresAt: true, revokedAt: true },
  });
}

/** The whole answer for a person, resolved. */
export async function entitlementsFor(client: Client, userId: string, now: Date = new Date()): Promise<EntitlementSet> {
  return resolveEntitlements(await activeRowsFor(client, userId, now), now);
}

export async function quantityFor(client: Client, userId: string, capability: Capability): Promise<number> {
  return quantityOf(await entitlementsFor(client, userId), capability);
}

export async function can(client: Client, userId: string, capability: Capability): Promise<boolean> {
  return allows(await entitlementsFor(client, userId), capability);
}

// --- plan transitions ----------------------------------------------------------

export interface PlanSyncInput {
  userId: string;
  subscriptionId: string;
  plan: PlanShape;
  /** Plan rows carry no expiry while the subscription is live; a cancel-at-period-end or a trial sets one. */
  expiresAt?: Date | null;
  /** `plan` for a paid plan, `trial` for a trial period. */
  source?: 'plan' | 'trial';
  grantedBy?: string;
  meta?: RequestMeta;
}

/**
 * Make the subject's plan-sourced rows equal to what `plan` grants: grant or
 * refresh each capability with sourceRef `${subscriptionId}:${planCode}`, and
 * revoke plan rows of any OTHER plan (an upgrade or downgrade takes effect
 * now; the previous plan's rows are revoked as plan_changed). Idempotent.
 */
export async function syncPlanEntitlements(client: Client, input: PlanSyncInput): Promise<{ granted: number; revoked: number }> {
  const source = input.source ?? 'plan';
  const sourceRef = `${input.subscriptionId}:${input.plan.code}`;
  const subject: Subject = { userId: input.userId };
  const keep = new Set<string>();
  let granted = 0;
  for (const g of grantsForPlan(input.plan)) {
    const r = await grantEntitlement(client, { subject, capability: g.capability, quantity: g.quantity, source, sourceRef, expiresAt: input.expiresAt ?? null, grantedBy: input.grantedBy, meta: input.meta });
    keep.add(r.id);
    if (r.changed) granted += 1;
  }
  const revoked = await revokeBySource(client, subject, source, { reason: 'plan_changed', revokedBy: input.grantedBy, meta: input.meta, except: keep });
  // A trial that becomes a paid plan, or vice versa, retires the other source's rows for this subscription.
  const other: 'plan' | 'trial' = source === 'plan' ? 'trial' : 'plan';
  const stale = await client.entitlement.findMany({ where: { userId: input.userId, source: other, revokedAt: null, sourceRef: { startsWith: `${input.subscriptionId}:` } }, select: { id: true } });
  let more = 0;
  for (const s of stale) if (await revokeEntitlement(client, s.id, { reason: source === 'plan' ? 'trial_ended' : 'plan_changed', revokedBy: input.grantedBy, meta: input.meta })) more += 1;
  return { granted, revoked: revoked + more };
}

export type SubscriptionAccessState = 'active' | 'trialing' | 'past_due' | 'grace' | 'suspended' | 'canceled';

/**
 * What a payment-state transition does to access. past_due and grace keep
 * everything (dunning is still running; ADR-0010: a lapsed payment retains
 * access until the policy says otherwise); suspended and canceled revoke the
 * subscription's plan and trial rows with the reason. Reactivation is a
 * plan sync, not the inverse of this.
 */
export async function applySubscriptionAccess(client: Client, input: { userId: string; subscriptionId: string; state: SubscriptionAccessState; by?: string; meta?: RequestMeta }): Promise<number> {
  if (input.state !== 'suspended' && input.state !== 'canceled') return 0;
  const reason: RevokeReason = input.state === 'canceled' ? 'canceled' : 'payment_lapsed';
  const rows = await client.entitlement.findMany({ where: { userId: input.userId, source: { in: ['plan', 'trial'] }, revokedAt: null, sourceRef: { startsWith: `${input.subscriptionId}:` } }, select: { id: true } });
  let n = 0;
  for (const r of rows) if (await revokeEntitlement(client, r.id, { reason, revokedBy: input.by, meta: input.meta })) n += 1;
  return n;
}

/** Set the expiry of a subscription's plan rows (cancel at period end: access until then, then nothing). */
export async function expirePlanEntitlementsAt(client: Client, userId: string, subscriptionId: string, expiresAt: Date | null): Promise<number> {
  const r = await client.entitlement.updateMany({ where: { userId, source: { in: ['plan', 'trial'] }, revokedAt: null, sourceRef: { startsWith: `${subscriptionId}:` } }, data: { expiresAt } });
  return r.count;
}

/** Rows whose expiry has passed, marked as such so the trail says why (the resolver already ignores them). */
export async function sweepExpired(client: Client, now: Date = new Date()): Promise<number> {
  const rows = await client.entitlement.findMany({ where: { revokedAt: null, expiresAt: { lte: now } }, select: { id: true } });
  let n = 0;
  for (const r of rows) if (await revokeEntitlement(client, r.id, { reason: 'expired', revokedBy: 'system' })) n += 1;
  return n;
}

/** Staff view: every row for a person, newest first, with the resolved answer. */
export async function describeEntitlements(client: Client, userId: string) {
  const [rows, set] = await Promise.all([
    client.entitlement.findMany({ where: { userId }, orderBy: [{ revokedAt: 'asc' }, { grantedAt: 'desc' }] }),
    entitlementsFor(client, userId),
  ]);
  return { rows, resolved: set };
}

export function parseCapability(value: unknown): Capability {
  if (!isCapability(value)) throw new EntitlementError(`Unknown capability ${String(value)}.`, 422);
  return value;
}

export type { Capability, EntitlementSet, EntitlementSource, Grant, PlanShape, RevokeReason };
