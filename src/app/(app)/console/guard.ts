/**
 * The console's access gate, in the one shape a React Server Component can use.
 *
 * `requireStaff()` in src/lib/crm/auth.ts is the real decision and this module
 * never second-guesses it — it only translates the two exceptions it throws
 * into a value a page can branch on. A page that let `requireStaff()` throw
 * would render the section's `error.tsx`, which in production shows a generic
 * "something went wrong" with a digest; "you are not staff" is not an error,
 * it is an answer, and it deserves a page that says so.
 *
 * WHY EVERY PAGE CALLS THIS AND THE LAYOUT DOES TOO. The layout check is the
 * one that cannot be forgotten: a new file dropped into this directory inherits
 * it without anybody remembering. The per-page check is the one that cannot be
 * bypassed: layouts do not re-render on every navigation in the App Router, and
 * a Route Handler under this directory (see invoices/[id]/pdf) does not run
 * layouts at all. Neither check is redundant with the other, and every page
 * under /console reads other people's personal data, so both are cheap.
 */

import { UnauthorizedError } from '@/lib/auth';
import { StaffAccessError, requireStaff, type StaffContext, type StaffRole } from '@/lib/crm/auth';

export type ConsoleGate =
  | { ok: true; staff: StaffContext }
  | { ok: false; signedIn: boolean; required: StaffRole };

/**
 * Run the staff check without throwing.
 *
 * `signedIn` distinguishes the two denials because they deserve different
 * treatment: an anonymous visitor should be sent to sign in, while a signed-in
 * customer should be told plainly that this area is not theirs — bouncing them
 * to a login form they have already completed reads as a broken app.
 *
 * The denial itself is deliberately uninformative about *why* (see
 * `authorizeStaff`): a customer probing /console must not learn the difference
 * between "not staff" and "staff, but not senior enough".
 */
export async function consoleGate(required: StaffRole = 'support'): Promise<ConsoleGate> {
  try {
    return { ok: true, staff: await requireStaff(required) };
  } catch (error) {
    if (error instanceof StaffAccessError) return { ok: false, signedIn: true, required };
    if (error instanceof UnauthorizedError) return { ok: false, signedIn: false, required };
    // A database outage is not an authorization answer. Let it reach error.tsx
    // rather than being reported to staff as "you do not have access".
    throw error;
  }
}
