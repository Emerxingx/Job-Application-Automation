/**
 * The STAFF_EMAILS allow-list, on its own so `src/lib/auth.ts` (sessions and
 * impersonation) can consult it without importing `./auth` here, which
 * imports `requireUser` from there - a cycle. Moved from crm/auth.ts in the
 * Stage 20 review (M2); crm/auth.ts re-exports both functions unchanged.
 */
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

