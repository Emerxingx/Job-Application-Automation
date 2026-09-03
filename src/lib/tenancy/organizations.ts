import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { isOrganizationRole, isOrganizationType, meetsRole, type OrganizationRole, type OrganizationType } from './roles';

/**
 * Organisations and memberships — the tenancy model of ADR-0005, wired.
 *
 * Before Stage 01 both models existed in the schema with zero code references.
 * This module is the only writer of either table. It runs on the SYSTEM client
 * deliberately: creating a workspace at signup, accepting an invitation, and
 * removing a member are all actions whose authorisation is decided here in
 * code (who may do what to whom), and the RLS policies on these tables are the
 * backstop for reads through the tenant path, not the mechanism by which the
 * roster is administered.
 *
 * Every mutating function takes the ACTOR as its first argument and refuses
 * when the actor's membership does not permit the change. There is no
 * "trusted" variant; staff tooling that needs to bypass goes through the
 * console gate and its own audited functions.
 */

type Client = Prisma.TransactionClient | typeof db;

export class OrganizationAccessError extends Error {
  readonly status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.name = 'OrganizationAccessError';
    this.status = status;
  }
}

/** A membership that currently confers access: accepted, not removed. */
const ACTIVE = { acceptedAt: { not: null }, removedAt: null } as const;

export function personalOrganizationId(userId: string): string {
  return `org_personal_${userId}`;
}

export function personalMembershipId(userId: string): string {
  return `mem_personal_${userId}`;
}

/**
 * Create the personal workspace every user owns. Idempotent: the ids are
 * derived from the user id, exactly as the migration backfill derives them, so
 * calling this for a user who already has one is a no-op rather than a second
 * workspace. Runs inside the caller's transaction when given one, so signup
 * either creates the user AND their workspace or neither.
 */
export async function ensurePersonalWorkspace(
  client: Client,
  user: { id: string; email: string; fullName: string },
) {
  const organizationId = personalOrganizationId(user.id);
  const organization = await client.organization.upsert({
    where: { id: organizationId },
    create: {
      id: organizationId,
      name: user.fullName,
      slug: `personal-${user.id}`,
      type: 'personal',
      billingEmail: user.email,
      status: 'active',
    },
    update: {},
  });
  await client.membership.upsert({
    where: { organizationId_userId: { organizationId, userId: user.id } },
    create: {
      id: personalMembershipId(user.id),
      organizationId,
      userId: user.id,
      role: 'owner',
      acceptedAt: new Date(),
    },
    update: {},
  });
  return organization;
}

/** The organisations a user currently belongs to, with their role in each. */
export async function listMemberships(client: Client, userId: string) {
  return client.membership.findMany({
    where: { userId, ...ACTIVE },
    include: { organization: true },
    orderBy: [{ organization: { type: 'asc' } }, { createdAt: 'asc' }],
  });
}

/**
 * The actor's active membership of an organisation, or null. This is the
 * primitive every authorisation decision in this module reduces to.
 */
export async function findActiveMembership(client: Client, organizationId: string, userId: string) {
  return client.membership.findFirst({ where: { organizationId, userId, ...ACTIVE } });
}

/**
 * Require that `userId` is an active member of `organizationId` at or above
 * `role`. Fails CLOSED: no membership, a pending invitation, a removed
 * membership and an unrecognised stored role all refuse. Returns the
 * membership so callers can read the role without a second query.
 */
export async function requireMembership(
  client: Client,
  organizationId: string,
  userId: string,
  role: OrganizationRole = 'member',
) {
  const membership = await findActiveMembership(client, organizationId, userId);
  if (!membership) {
    // 404 rather than 403: whether the organisation exists is itself
    // information a non-member is not entitled to.
    throw new OrganizationAccessError('Organization not found.', 404);
  }
  if (!meetsRole(membership.role, role)) {
    throw new OrganizationAccessError(`This action requires the ${role} role.`, 403);
  }
  return membership;
}

const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Create a non-personal organisation with the actor as its owner. The type
 * is validated against the closed list; `personal` cannot be created this way
 * because a user has exactly one and it is created at signup.
 */
export async function createOrganization(
  actorUserId: string,
  input: { name: string; type: OrganizationType; slug?: string; billingEmail: string },
) {
  if (!isOrganizationType(input.type) || input.type === 'personal' || input.type === 'platform') {
    throw new OrganizationAccessError('That organization type cannot be created here.', 422);
  }
  const slug = input.slug ?? slugify(input.name);
  if (!SLUG_SHAPE.test(slug)) {
    throw new OrganizationAccessError('Slug must be 3–64 lowercase letters, digits or hyphens.', 422);
  }
  return db.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        name: input.name.trim(),
        slug,
        type: input.type,
        billingEmail: input.billingEmail.toLowerCase().trim(),
        status: 'active',
      },
    });
    await tx.membership.create({
      data: { organizationId: organization.id, userId: actorUserId, role: 'owner', acceptedAt: new Date() },
    });
    return organization;
  });
}

/**
 * Invite an existing user into an organisation. Admin or above. The
 * invitation is a pending membership (no `acceptedAt`), which confers NO
 * access — `requireMembership` and the RLS helper both require acceptance.
 * The invitee's role is capped at the actor's own: an admin cannot mint an
 * owner.
 */
export async function inviteMember(
  actorUserId: string,
  organizationId: string,
  input: { userId: string; role: OrganizationRole },
) {
  if (!isOrganizationRole(input.role)) {
    throw new OrganizationAccessError('Unknown role.', 422);
  }
  return db.$transaction(async (tx) => {
    const actor = await requireMembership(tx, organizationId, actorUserId, 'admin');
    if (!meetsRole(actor.role, input.role)) {
      throw new OrganizationAccessError('You cannot grant a role above your own.', 403);
    }
    const organization = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    if (organization.type === 'personal') {
      throw new OrganizationAccessError('A personal workspace has exactly one member.', 422);
    }
    // An ACTIVE membership is never touched by an invitation. Without this
    // check the upsert below would let an admin "invite" the owner as a
    // member and, by resetting acceptedAt, lock them out — bypassing every
    // guard in changeRole and removeMember. (Found in the Stage 01 review.)
    const existing = await tx.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId: input.userId } },
    });
    if (existing && existing.acceptedAt !== null && existing.removedAt === null) {
      throw new OrganizationAccessError('That user is already a member; change their role instead.', 409);
    }
    const target = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true } });
    if (!target) throw new OrganizationAccessError('No such user.', 404);
    return tx.membership.upsert({
      where: { organizationId_userId: { organizationId, userId: input.userId } },
      // A removed member can be re-invited; a pending invitation is refreshed.
      create: { organizationId, userId: input.userId, role: input.role, invitedAt: new Date() },
      update: { role: input.role, invitedAt: new Date(), acceptedAt: null, removedAt: null },
    });
  });
}

/**
 * Withdraw a pending invitation. Admin or above; only a membership that has
 * NOT been accepted qualifies — an active member is removed with removeMember,
 * which carries the role and last-owner guards.
 */
export async function withdrawInvitation(actorUserId: string, organizationId: string, targetUserId: string) {
  return db.$transaction(async (tx) => {
    await requireMembership(tx, organizationId, actorUserId, 'admin');
    const pending = await tx.membership.findFirst({
      where: { organizationId, userId: targetUserId, acceptedAt: null, removedAt: null },
    });
    if (!pending) throw new OrganizationAccessError('No pending invitation for that user.', 404);
    return tx.membership.update({ where: { id: pending.id }, data: { removedAt: new Date() } });
  });
}

/** Accept one's own pending invitation. Nobody can accept on another's behalf. */
export async function acceptInvitation(actorUserId: string, organizationId: string) {
  const pending = await db.membership.findFirst({
    where: { organizationId, userId: actorUserId, acceptedAt: null, removedAt: null },
  });
  if (!pending) throw new OrganizationAccessError('No pending invitation.', 404);
  return db.membership.update({ where: { id: pending.id }, data: { acceptedAt: new Date() } });
}

/**
 * Change a member's role. Owner only, and never on oneself — the last owner
 * cannot demote themselves into an organisation with no owner.
 */
export async function changeRole(
  actorUserId: string,
  organizationId: string,
  input: { userId: string; role: OrganizationRole },
) {
  if (!isOrganizationRole(input.role)) {
    throw new OrganizationAccessError('Unknown role.', 422);
  }
  return db.$transaction(async (tx) => {
    await requireMembership(tx, organizationId, actorUserId, 'owner');
    if (input.userId === actorUserId) {
      throw new OrganizationAccessError('You cannot change your own role.', 422);
    }
    const target = await findActiveMembership(tx, organizationId, input.userId);
    if (!target) throw new OrganizationAccessError('That user is not a member.', 404);
    return tx.membership.update({ where: { id: target.id }, data: { role: input.role } });
  });
}

/**
 * Remove a member. Admins may remove members; only owners may remove admins or
 * owners; the last owner cannot be removed; a personal workspace's owner
 * cannot be removed at all (that is account deletion, a different flow).
 */
export async function removeMember(actorUserId: string, organizationId: string, targetUserId: string) {
  return db.$transaction(async (tx) => {
    const actor = await requireMembership(tx, organizationId, actorUserId, 'admin');
    const target = await findActiveMembership(tx, organizationId, targetUserId);
    if (!target) throw new OrganizationAccessError('That user is not a member.', 404);
    const organization = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    if (organization.type === 'personal') {
      throw new OrganizationAccessError('A personal workspace cannot lose its owner.', 422);
    }
    if (meetsRole(target.role, 'admin') && !meetsRole(actor.role, 'owner')) {
      throw new OrganizationAccessError('Only an owner can remove an admin or owner.', 403);
    }
    if (target.role === 'owner') {
      const owners = await tx.membership.count({ where: { organizationId, role: 'owner', ...ACTIVE } });
      if (owners <= 1) throw new OrganizationAccessError('An organization must keep at least one owner.', 422);
    }
    return tx.membership.update({ where: { id: target.id }, data: { removedAt: new Date() } });
  });
}
