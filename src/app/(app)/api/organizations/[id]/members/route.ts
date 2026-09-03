import { z } from 'zod';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { fail, ok, route } from '@/lib/api';
import {
  changeRole,
  inviteMember,
  OrganizationAccessError,
  removeMember,
  requireMembership,
} from '@/lib/tenancy/organizations';
import { ORGANIZATION_ROLES } from '@/lib/tenancy/roles';
import { recordSecurityEvent, requestMeta } from '@/lib/security-audit';

type Params = { params: Promise<{ id: string }> };

function handle(error: unknown): Response {
  if (error instanceof OrganizationAccessError) return fail(error.message, error.status);
  throw error;
}

/** The roster. Any active member may read it; pending invitations are marked. */
export const GET = route(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { id } = await params;
  try {
    await requireMembership(db, id, user.id, 'member');
    const members = await db.membership.findMany({
      where: { organizationId: id, removedAt: null },
      include: { user: { select: { id: true, fullName: true, email: true } } },
      orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
    });
    return ok({
      members: members.map((m) => ({
        userId: m.userId,
        fullName: m.user.fullName,
        email: m.user.email,
        role: m.role,
        pending: m.acceptedAt === null,
        joinedAt: m.acceptedAt,
      })),
    });
  } catch (error) {
    return handle(error);
  }
});

const inviteSchema = z.object({ userId: z.string().min(1), role: z.enum(ORGANIZATION_ROLES) });

export const POST = route(async (request: Request, { params }: Params) => {
  const user = await requireUser();
  const { id } = await params;
  const body = inviteSchema.parse(await request.json());
  try {
    const membership = await inviteMember(user.id, id, body);
    await recordSecurityEvent({
      event: 'organization.member.invited',
      user,
      entityType: 'Membership',
      entityId: membership.id,
      summary: `Invited a member as ${body.role}`,
      detail: { organizationId: id, inviteeUserId: body.userId, role: body.role },
      meta: requestMeta(request),
    });
    return ok({ ok: true, membershipId: membership.id }, { status: 201 });
  } catch (error) {
    return handle(error);
  }
});

const roleSchema = z.object({ userId: z.string().min(1), role: z.enum(ORGANIZATION_ROLES) });

export const PATCH = route(async (request: Request, { params }: Params) => {
  const user = await requireUser();
  const { id } = await params;
  const body = roleSchema.parse(await request.json());
  try {
    const membership = await changeRole(user.id, id, body);
    await recordSecurityEvent({
      event: 'organization.member.role_changed',
      user,
      entityType: 'Membership',
      entityId: membership.id,
      summary: `Changed a member's role to ${body.role}`,
      detail: { organizationId: id, targetUserId: body.userId, role: body.role },
      meta: requestMeta(request),
    });
    return ok({ ok: true });
  } catch (error) {
    return handle(error);
  }
});

const removeSchema = z.object({ userId: z.string().min(1) });

export const DELETE = route(async (request: Request, { params }: Params) => {
  const user = await requireUser();
  const { id } = await params;
  const body = removeSchema.parse(await request.json());
  try {
    const membership = await removeMember(user.id, id, body.userId);
    await recordSecurityEvent({
      event: 'organization.member.removed',
      user,
      entityType: 'Membership',
      entityId: membership.id,
      summary: 'Removed a member',
      detail: { organizationId: id, targetUserId: body.userId },
      meta: requestMeta(request),
    });
    return ok({ ok: true });
  } catch (error) {
    return handle(error);
  }
});
