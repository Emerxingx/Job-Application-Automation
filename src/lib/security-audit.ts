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
  // Stage 14: a mobile sign-in mints a device key; revocation is by the owner,
  // by password change, or by "sign out everywhere else".
  | 'auth.device.issued'
  | 'auth.device.revoked'
  // Stage 15: entitlement state changes - capability, source and reason, never an amount.
  | 'entitlement.granted'
  | 'entitlement.revoked'
  // Stage 15: a refund is recorded as money moving; it never revokes on its own.
  | 'billing.refund.recorded'
  // Stage 03: step-up re-authentication for prompt governance (failures only;
  // a success is implied by the prompt.* audit row that follows it).
  | 'auth.step_up.failed'
  | 'consent.granted'
  | 'consent.revoked'
  // ADR-0007: every access to the sensitive schema is audited — never its values.
  | 'sensitive.read'
  | 'sensitive.write'
  | 'sensitive.erased'
  // Stage 07: work authorisation is operationally relevant but access-controlled
  // and audited — one row per evaluation batch, never a value.
  | 'eligibility.profile.read'
  | 'organization.created'
  | 'organization.member.invited'
  | 'organization.member.accepted'
  | 'organization.member.role_changed'
  | 'organization.member.removed'
  // Stage 11: mailbox and calendar connections — never a subject, an address
  // in clear, or a token; counts, scopes and digests only.
  | 'mailbox.connected'
  | 'mailbox.synced'
  | 'mailbox.thread.confirmed'
  | 'mailbox.thread.rejected'
  | 'mailbox.event.confirmed'
  | 'mailbox.event.rejected'
  | 'mailbox.revoked'
  // Stage 17 (ADR-0032): case management. Reads of RESTRICTED rows are audited
  // BEFORE the read, strictly; ids and kinds only, never a note or a barrier.
  | 'organization.create.refused'
  | 'case.invited'
  | 'case.consented'
  | 'case.declined'
  | 'case.assigned'
  | 'case.closed'
  | 'case.client.read'
  | 'case.note.read'
  | 'case.note.written'
  | 'case.assessment.read'
  | 'case.assessment.written'
  | 'case.copilot.run'
  | 'case.recommendation.decided'
  | 'case.retention.set'
  | 'case.retention.purged'
  // Stage 18 (ADR-0033): employer-side hiring. A candidate's identity reaches an employer only behind a granted disclosure, and every such read is audited.
  | 'disclosure.requested'
  | 'disclosure.granted'
  | 'disclosure.declined'
  | 'disclosure.revoked'
  | 'employer.sourcing.run'
  | 'employer.candidate.read'
  | 'employer.submission.moved'
  | 'employer.offer.decided'
  // Stage 19 (ADR-0034): staffing. Fee data is CONFIDENTIAL: the rows carry ids, kinds and amounts in cents, never a candidate's name or a client's contact.
  | 'staffing.jurisdiction.recorded'
  | 'staffing.role.set'
  | 'representation.requested'
  | 'representation.granted'
  | 'representation.declined'
  | 'representation.revoked'
  | 'staffing.placement.created'
  | 'staffing.placement.updated'
  | 'staffing.invoice.issued'
  | 'staffing.invoice.updated'
  // Stage 20 (ADR-0035): enterprise controls. Staff administration carries a
  // reason and before/after values; SSO and SCIM carry digests, never an
  // address, and never a secret or a token.
  | 'organization.verified'
  | 'organization.suspended'
  | 'organization.reactivated'
  | 'organization.policy.set'
  | 'staff.role.set'
  | 'feature_flag.set'
  | 'user.impersonation.started'
  | 'user.impersonation.ended'
  | 'audit.exported'
  | 'analytics.exported'
  | 'privacy.erasure.requested'
  | 'privacy.erasure.canceled'
  | 'privacy.erased'
  | 'retention.swept'
  | 'sso.connection.updated'
  | 'auth.sso.succeeded'
  | 'auth.sso.failed'
  | 'auth.sso.provisioned'
  | 'scim.token.issued'
  | 'scim.token.revoked'
  | 'scim.user.provisioned'
  | 'scim.user.deactivated'
  | 'scim.user.reactivated';

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
    requestId: request.headers.get('x-request-id')?.slice(0, 128) ?? null,
  };
}

export interface SecurityEventInput {
  event: SecurityEvent;
  /** The account the event concerns, when one exists. */
  user?: { id: string; email: string; role?: string } | null;
  /** Who acted — defaults to the user. */
  actor?: { type: 'user' | 'staff' | 'system' | 'api_key'; id?: string | null; email?: string; role?: string } | null;
  entityType?: string;
  entityId?: string;
  summary: string;
  /** Non-sensitive detail. Never a secret, never a body. */
  detail?: Record<string, string | number | boolean | null>;
  reason?: string | null;
  meta?: RequestMeta;
}

/**
 * Write one security event.
 *
 * On the module-level client this never throws: an audit write failing must
 * not turn a successful sign-in into a 500, but it must not be silent either,
 * so the failure is logged with the event name and nothing else.
 *
 * With `strict: true` it also throws, so an audit-gated action can refuse to
 * proceed when its record cannot be written. Inside a caller's TRANSACTION the
 * same holds, and swallowing would be a lie: PostgreSQL aborts the transaction on the failed INSERT, every later
 * statement fails with 25P02, and the caller's commit fails anyway. So a
 * transactional audit write rethrows — the event and the action it records
 * commit together or not at all.
 */
export async function recordSecurityEvent(
  input: SecurityEventInput,
  client: Prisma.TransactionClient | typeof db = db,
  options: { strict?: boolean } = {},
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
    // `strict` is for accesses whose audit is a precondition (ADR-0007: every
    // access to the sensitive schema is audited — so an access that cannot be
    // audited must not happen). The caller writes the audit FIRST and aborts on
    // failure.
    if (client !== db || options.strict) throw error;
  }
}
