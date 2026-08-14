/**
 * Staff authorization for /console.
 *
 * Every endpoint under src/app/(app)/api/console reads other people's personal
 * data — names, emails, invoices, application history. requireUser() only
 * proves *someone* is signed in, so it is not sufficient here: without a second
 * gate, any customer who guesses a URL reads the whole book of business.
 *
 * THE GATE HAS TWO INDEPENDENT LOCKS, AND BOTH MUST OPEN:
 *
 *   1. STAFF_EMAILS — an explicit, comma-separated allowlist supplied at
 *      deploy time. This is the outer lock and it FAILS CLOSED: if the
 *      variable is unset, empty, or contains only separators, NOBODY is staff
 *      and every console route returns 403. There is no wildcard, no "*", and
 *      no bare-domain form: "@jobpilot.ai" would silently admit every alias,
 *      catch-all address and former employee the mail server still accepts.
 *
 *   2. User.role — the database column (member | support | billing_ops |
 *      admin) decides HOW MUCH an allowlisted person may do, not whether they
 *      get in at all.
 *
 * Why both. The schema note is explicit that a mis-set role on a customer
 * account would otherwise grant console access — role is one UPDATE away from
 * being wrong, and it is written by application code. STAFF_EMAILS is written
 * by a human editing a deployment config. Requiring both means neither a bad
 * migration nor a compromised admin endpoint can mint a staff account on its
 * own.
 *
 * An allowlisted person whose role is still the default "member" is admitted
 * at the WEAKEST staff level (support) rather than being locked out — the
 * allowlist already established that they are staff, and failing safe means
 * granting the least privilege, not the most.
 */

import { requireUser } from '../auth';
import { fail, route } from '../api';

// --- Roles ------------------------------------------------------------------

/** Staff roles, weakest first. `member` is a customer and is not in this set. */
export type StaffRole = 'support' | 'billing_ops' | 'admin';

export const STAFF_ROLES = ['support', 'billing_ops', 'admin'] as const;

/**
 * A deliberately LINEAR privilege ladder. Real organisations sometimes want
 * billing_ops and support to be siblings rather than a hierarchy; a lattice is
 * harder to reason about and impossible to check with one comparison, and
 * every additional branch is somewhere a check can be forgotten. If the
 * business ever needs orthogonal permissions, replace this with named scopes —
 * do not smuggle them in as extra roles.
 */
export const STAFF_RANK: Record<StaffRole, number> = {
  support: 1,
  billing_ops: 2,
  admin: 3,
};

export function isStaffRole(value: string): value is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(value);
}

/**
 * The privilege level an allowlisted person actually operates at.
 *
 * A role we do not recognise — including the default "member" — collapses to
 * `support`, the least-privileged staff level. Never to admin.
 */
export function effectiveStaffRole(role: string | null | undefined): StaffRole {
  return role && isStaffRole(role) ? role : 'support';
}

/** Whether `actual` satisfies a requirement of `required`. */
export function meetsStaffRole(actual: StaffRole, required: StaffRole): boolean {
  return STAFF_RANK[actual] >= STAFF_RANK[required];
}

// --- The allowlist ----------------------------------------------------------

/**
 * Split STAFF_EMAILS into normalised addresses.
 *
 * Accepts commas, semicolons and whitespace as separators so a value pasted
 * out of a spreadsheet or a multi-line secret still parses. Entries are
 * lowercased and trimmed. Anything that is not a plausible address — no "@",
 * or nothing before/after it — is dropped rather than trusted, which is what
 * kills the "@company.com" domain-wildcard attempt.
 */
export function parseStaffAllowlist(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;\s]+/)) {
    const email = part.trim().toLowerCase();
    if (!email) continue;
    const at = email.indexOf('@');
    // Reject "*", "all", bare domains ("@jobpilot.ai") and bare local parts.
    if (at <= 0 || at === email.length - 1) continue;
    if (email.indexOf('@', at + 1) !== -1) continue;
    seen.add(email);
  }
  return [...seen];
}

/**
 * The default-deny check. Unset, blank or junk-only STAFF_EMAILS ⇒ false for
 * every address, including addresses that look internal.
 */
export function isAllowlistedStaffEmail(
  email: string | null | undefined,
  raw: string | null | undefined,
): boolean {
  if (!email) return false;
  const allowlist = parseStaffAllowlist(raw);
  if (allowlist.length === 0) return false;
  return allowlist.includes(email.trim().toLowerCase());
}

// --- The decision -----------------------------------------------------------

export interface StaffCandidate {
  id: string;
  email: string;
  fullName: string;
  role: string;
  anonymizedAt?: Date | null;
}

export interface StaffContext {
  id: string;
  email: string;
  fullName: string;
  /** The privilege level in force for this request. */
  role: StaffRole;
  /** Whatever the database actually holds, for audit snapshots. */
  storedRole: string;
}

export type StaffDenialReason =
  | 'allowlist_unset'
  | 'not_allowlisted'
  | 'anonymized'
  | 'insufficient_role';

export type StaffAuthorization =
  | { ok: true; staff: StaffContext }
  | { ok: false; reason: StaffDenialReason; status: number; message: string };

/**
 * The whole authorization decision, as a pure function.
 *
 * requireStaff() below is nothing but `requireUser()` + this + `throw`. Keeping
 * the decision pure is what makes it testable without a session, a cookie or a
 * database — and an access check nobody can test is an access check nobody
 * should trust.
 */
export function authorizeStaff(
  candidate: StaffCandidate | null | undefined,
  required: StaffRole = 'support',
  allowlistRaw: string | null | undefined = process.env.STAFF_EMAILS,
): StaffAuthorization {
  // The message is deliberately identical for every denial: a customer probing
  // /console must not be able to tell "you are not staff" from "you are staff
  // but not senior enough", because the difference is a map of the org chart.
  const denied = (reason: StaffDenialReason, status = 403): StaffAuthorization => ({
    ok: false,
    reason,
    status,
    message: 'This area is restricted to JobPilot staff.',
  });

  if (!candidate) return denied('not_allowlisted', 401);

  if (parseStaffAllowlist(allowlistRaw).length === 0) {
    // Fail closed. A deployment that forgot STAFF_EMAILS has no console, which
    // is a visible outage for four people rather than a silent leak of every
    // customer record.
    return denied('allowlist_unset');
  }

  if (!isAllowlistedStaffEmail(candidate.email, allowlistRaw)) {
    return denied('not_allowlisted');
  }

  // An anonymised account is a completed erasure request. Its email column is
  // scrubbed to a placeholder, and a placeholder must never match its way back
  // into the allowlist.
  if (candidate.anonymizedAt) return denied('anonymized');

  const role = effectiveStaffRole(candidate.role);
  if (!meetsStaffRole(role, required)) return denied('insufficient_role');

  return {
    ok: true,
    staff: {
      id: candidate.id,
      email: candidate.email,
      fullName: candidate.fullName,
      role,
      storedRole: candidate.role,
    },
  };
}

// --- Route plumbing ---------------------------------------------------------

/** Thrown by requireStaff(); turned into a clean 403 by consoleRoute(). */
export class StaffAccessError extends Error {
  readonly reason: StaffDenialReason;
  readonly status: number;

  constructor(reason: StaffDenialReason, status: number, message: string) {
    super(message);
    this.name = 'StaffAccessError';
    this.reason = reason;
    this.status = status;
  }
}

/**
 * The single gate every console route calls. Signature mirrors requireUser():
 * it either returns the actor or throws.
 */
export async function requireStaff(required: StaffRole = 'support'): Promise<StaffContext> {
  const user = await requireUser();
  const decision = authorizeStaff(
    {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      anonymizedAt: user.anonymizedAt,
    },
    required,
    process.env.STAFF_EMAILS,
  );

  if (!decision.ok) {
    // Logged, not audited: writing a row per denial would let an unauthenticated
    // flood grow the audit table. Successful staff *mutations* are audited.
    console.warn(
      `[console] denied ${user.email} -> ${required} (${decision.reason})`,
    );
    throw new StaffAccessError(decision.reason, decision.status, decision.message);
  }

  return decision.staff;
}

/**
 * route() for console endpoints: adds StaffAccessError → 403 on top of the
 * standard 401/422/500 handling, so no console handler has to remember to
 * translate it.
 */
export function consoleRoute<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return route(async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof StaffAccessError) return fail(error.message, error.status);
      throw error;
    }
  });
}
