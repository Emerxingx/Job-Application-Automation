import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from '../db';
import { ensurePersonalWorkspace } from '../tenancy/organizations';
import { grantConsent, REQUIRED_AT_SIGNUP, type ConsentPurpose } from '../consent';
import { recordSecurityEvent, type RequestMeta } from '../security-audit';
import type { SupabaseIdentity } from './supabase';

/**
 * Resolve a verified provider identity to exactly one platform user
 * (ADR-0004 §4, §7: one identity per human; provider identities are LINKED
 * to a user, never a second namespace of users).
 *
 * Linkage rules, in order:
 *   1. A `UserIdentity` row for (provider, subject) wins outright.
 *   2. Otherwise, if the token carries a VERIFIED email and a user with that
 *      email exists, the identity is linked to that user. An unverified email
 *      claim links nothing: it would let anyone who can register that address
 *      at the provider take over the platform account.
 *   3. Otherwise, with explicit consent to the required purposes, a new user
 *      is created with an unusable password (a random 32-byte hash) — the
 *      account authenticates through the provider from then on.
 *
 * Every outcome is audited.
 */
export class IdentityLinkError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'IdentityLinkError';
    this.status = status;
  }
}

export async function linkSupabaseIdentity(
  identity: SupabaseIdentity,
  options: { consents?: ConsentPurpose[]; fullName?: string; meta?: RequestMeta } = {},
) {
  const existing = await db.userIdentity.findUnique({
    where: { provider_subject: { provider: 'supabase', subject: identity.subject } },
    include: { user: true },
  });
  if (existing) {
    await db.userIdentity.update({
      where: { id: existing.id },
      data: { lastAuthenticatedAt: new Date(), emailVerified: identity.emailVerified, email: identity.email },
    });
    return { user: existing.user, created: false, linked: false };
  }

  if (!identity.email) {
    throw new IdentityLinkError('The identity provider did not supply an email address.', 422);
  }

  const byEmail = await db.user.findUnique({ where: { email: identity.email } });
  if (byEmail) {
    if (!identity.emailVerified) {
      throw new IdentityLinkError(
        'An account with this email exists. Verify the email with the identity provider, or sign in with your password first.',
        409,
      );
    }
    await db.$transaction(async (tx) => {
      await tx.userIdentity.create({
        data: {
          userId: byEmail.id,
          provider: 'supabase',
          subject: identity.subject,
          email: identity.email,
          emailVerified: true,
          lastAuthenticatedAt: new Date(),
        },
      });
      if (!byEmail.emailVerifiedAt) {
        await tx.user.update({ where: { id: byEmail.id }, data: { emailVerifiedAt: new Date() } });
      }
      await recordSecurityEvent(
        {
          event: 'auth.identity.linked',
          user: byEmail,
          entityType: 'UserIdentity',
          entityId: identity.subject,
          summary: 'Linked a Supabase identity to an existing account by verified email',
          detail: { provider: 'supabase', assuranceLevel: identity.assuranceLevel },
          meta: options.meta,
        },
        tx,
      );
    });
    return { user: byEmail, created: false, linked: true };
  }

  const consents = options.consents ?? [];
  for (const purpose of REQUIRED_AT_SIGNUP) {
    if (!consents.includes(purpose)) {
      throw new IdentityLinkError('Accept the Terms of Service and Privacy Policy to create an account.', 422);
    }
  }
  if (!identity.emailVerified) {
    throw new IdentityLinkError('Verify your email with the identity provider before creating an account.', 422);
  }

  const user = await db.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: identity.email!,
        passwordHash: await bcrypt.hash(randomBytes(32).toString('hex'), 10),
        fullName: options.fullName?.trim() || identity.email!.split('@')[0],
        emailVerifiedAt: new Date(),
      },
    });
    await tx.userIdentity.create({
      data: {
        userId: created.id,
        provider: 'supabase',
        subject: identity.subject,
        email: identity.email,
        emailVerified: true,
        lastAuthenticatedAt: new Date(),
      },
    });
    await ensurePersonalWorkspace(tx, created);
    for (const purpose of REQUIRED_AT_SIGNUP) {
      await grantConsent(tx, created, purpose, { source: 'signup', meta: options.meta });
    }
    await recordSecurityEvent(
      {
        event: 'auth.identity.linked',
        user: created,
        entityType: 'UserIdentity',
        entityId: identity.subject,
        summary: 'Account created from a Supabase identity',
        detail: { provider: 'supabase', assuranceLevel: identity.assuranceLevel },
        meta: options.meta,
      },
      tx,
    );
    return created;
  });
  return { user, created: true, linked: true };
}
