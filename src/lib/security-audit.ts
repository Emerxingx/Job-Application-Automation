import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from './db';

/**
 * Security and account events, written to the same append-only `AuditLog`
 * the staff console uses, so one feed answers "what happened to this account"
 * for a support case, an incident, or a subject-access request.
 *
 * WHAT IS DELIBERATELY NOT RECORDED
 * ---------------------------------
 * No secret ever reaches this table: not a password, a hash, a session token,
 * a reset token, or a provider access token. No free-text request body is
 * copied in. The email address is stored only as a SHA-256 digest
 * (`emailHash` in `after`) so a failed sign-in for an address that has no
 * account does not write that address to disk in clear, while a sequence of
 * failures against one address is still correlatable. The actor's email is
 * recorded in clear ONLY for events on an account that exists and whose owner
 * performed the action, matching what the console already stores.
 *
 * IP and user agent are stored because ADR-0004 requires the account holder
 * to see their own sessions, and "where from" is what makes that list useful.
 */

export type SecurityEvent =
  | 'auth.login.succeeded'
  | 'auth.login.failed'
  | 'auth.signup'
  | 'auth.logout'
  | 'auth.session.revoked'
  | 'auth.sessions.revoked_all'
  | 'auth.password.changed'
  | 'auth.identity.linked'
  | 'consent.granted'
  | 'consent.revoked'
  | 'organization.created'
  | 'organization.member.invited'
  | 'organization.member.accepted'
  | 'organization.member.role_changed'
  | 'organization.member.removed';

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/** Read the coarse request context the audit row keeps. */
export function requestMeta(request: Request | undefined): RequestMeta {
  if (!request) return {};
  const forwarded = request.headers.get('x-forwarded-for');
  return {
    ip: forwarded ? forwarded.split(',')[0].trim() : (request.headers.get('x-real-ip') ?? null),
    userAgent: request.headers.get('user-agent')?.slice(0, 256) ?? null,
    requestId: request.headers.get('x-request-id') ?? null,
  };
}

export interface SecurityEventInput {
  event: SecurityEvent;
  /** The account the event concerns, when one exists. */
  user?: { id: string; email: string; role?: string } | null;
  /** Who acted — defaults to the user. */
  actor?: { type: 'user' | 'staff' | 'system'; id?: string | null; email?: string; role?: string } | null;
  entityType?: string;
  entityId?: string;
  summary: string;
  /** Non-sensitive detail. Never a secret, never a body. */
  detail?: Record<string, string | number | boolean | null>;
  reason?: string | null;
  meta?: RequestMeta;
}

/**
 * Write one security event. Never throws: an audit write failing must not
 * turn a successful sign-in into a 500, but it must not be silent either, so
 * the failure is logged with the event name and nothing else.
 */
export async function recordSecurityEvent(
  input: SecurityEventInput,
  client: Prisma.TransactionClient | typeof db = db,
): Promise<void> {
  const actor = input.actor ?? (input.user ? { type: 'user' as const, id: input.user.id, email: input.user.email, role: input.user.role } : { type: 'system' as const });
  try {
    await client.auditLog.create({
      data: {
        actorType: actor.type,
        actorId: actor.id ?? null,
        actorEmail: actor.email ?? '',
        actorRole: actor.role ?? '',
        action: input.event,
        entityType: input.entityType ?? 'User',
        entityId: input.entityId ?? input.user?.id ?? '',
        summary: input.summary,
        before: '{}',
        after: JSON.stringify(input.detail ?? {}),
        changedFields: '[]',
        reason: input.reason ?? null,
        ip: input.meta?.ip ?? null,
        userAgent: input.meta?.userAgent ?? null,
        requestId: input.meta?.requestId ?? null,
      },
    });
  } catch (error) {
    console.error(`[security-audit] failed to record ${input.event}:`, error instanceof Error ? error.message : error);
  }
}
