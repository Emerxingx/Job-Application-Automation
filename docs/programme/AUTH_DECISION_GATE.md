# Stage 01 — Authentication Decision Gate

**Status:** DECISION RECORDED, PENDING ONE VERIFICATION (see §6)
**Required by:** `../adr/ADR-0004-authentication.md` — no authentication implementation begins until this is recorded.
**Date:** 2026-09-02

`ADR-0004` deliberately did not pick an implementation. It recorded the target
characteristics and deferred the choice to this evidence-based gate.

---

## 1. The finding that dominates the decision

**There are no production users.**

Measured in this repository: no database is committed, and `prisma/seed.ts`
creates exactly one account — `demo@jobpilot.ai`, a seeded demo. Every
deployment's user table is created by `db push` and seeded from scratch.

Migration impact is normally the heaviest cost in an authentication decision,
because moving password hashes and sessions between systems is disruptive and
risky. **Right now that cost is approximately zero.** It will not stay that way:
it rises monotonically with every real account created.

This inverts the usual conclusion about timing. The cheapest possible moment to
change authentication is *before* the first real user, and that moment is now.
Deferring the decision is not neutral — it is choosing "extend custom auth" by
default and paying the migration cost later if that turns out wrong.

## 2. What exists today (the baseline being compared against)

| Element | Measure |
| --- | --- |
| `src/lib/auth.ts` | 100 lines — bcrypt cost 10, `jose` HS256 cookie sessions |
| `src/lib/crm/auth.ts` | 265 lines — the staff console two-lock gate |
| Routes calling `requireUser()` | 45 |
| Routes behind the console gate | 18 |
| `src/middleware.ts` | Added in Stage 01: deny-by-default edge gate |

Quality is genuinely good: the production secret is rejected **by value** against
the published `.env.example` placeholder, `PAYLOAD_SECRET` is kept separate, and
the console gate fails closed with an unknown role degrading to the weakest staff
level. None of that is throwaway work.

What is absent: email verification, MFA, account recovery, device/session
management, OAuth, enterprise SSO, and — most seriously — **server-side session
revocation**. The JWT is stateless with a 30-day expiry, so logout only deletes
the cookie and a stolen token stays valid until it expires.

## 3. Options

| | Option |
| --- | --- |
| **A** | Extend the existing custom authentication |
| **B** | Supabase Auth |
| **C** | Another managed identity platform (Auth0, Clerk, WorkOS) |
| **D** | Hybrid — local primary credential, delegated OAuth/SSO |

## 4. Assessment

Legend: ✅ available / ⚠️ possible with work / ❌ absent or must be built.

| Criterion | A — extend | B — Supabase Auth | C — other managed | D — hybrid |
| --- | --- | --- | --- | --- |
| **Existing-user migration impact** | none | **near zero today** (§1) | near zero today | none |
| **Canada residency** | ours to control | ⚠️ **must be verified** (§6) | ⚠️ varies by vendor | ours to control |
| **MFA** | ❌ build TOTP + recovery codes | ✅ TOTP and phone factors | ✅ | ⚠️ build |
| **Email verification** | ❌ build | ✅ | ✅ | ❌ build |
| **Account recovery** | ❌ build | ✅ | ✅ | ❌ build |
| **OAuth (Google/MS/Apple)** | ❌ build 3 integrations | ✅ | ✅ | ✅ delegated |
| **Session/device revocation** | ❌ build session table + cache invalidation | ✅ server-side sessions | ✅ | ⚠️ build |
| **Enterprise SSO path** | ❌ build SAML/OIDC | ✅ SAML 2.0 | ✅ | ⚠️ |
| **RBAC integration** | ours | ⚠️ roles stay ours | ⚠️ | ours |
| **RLS integration** | ⚠️ we set the GUCs ourselves | ✅ **`auth.uid()` / `aal` usable directly in policies** | ❌ foreign to Postgres | ⚠️ |
| **Auditability** | ours | ⚠️ split across two systems | ⚠️ split | ⚠️ split |
| **Vendor lock-in** | none | moderate — but same vendor as the database | **high — a new vendor** | low |
| **Operational burden** | ours forever | low | low | medium |
| **Security-maintenance burden** | **high and permanent** | vendor's | vendor's | shared |
| **Cost** | engineering time | included in the Supabase project | separate subscription | mixed |
| **Founder operability** | ❌ no admin UI without building one | ✅ dashboard | ✅ dashboard | ⚠️ |

## 5. Decision — Option B, Supabase Auth, with the console gate retained

Four things decide it, in order of weight.

**1. The migration cost is zero now and never will be again.** §1. Every other
consideration is dominated by the fact that this is the last cheap moment.

**2. Supabase is already the chosen database vendor.** `ADR-0002` and `ADR-0015`
already put the transactional store on Supabase in a Canadian region. Option B
therefore adds **no new vendor**, no new subscription, and no new residency
question beyond the one already answered for the database. Option C would
introduce a second vendor for a problem the first one already solves — that is
the decisive argument against it.

**3. It composes with the RLS backstop rather than fighting it.** Verified from
the Supabase docs source: authenticated identity is available inside policies via
`auth.uid()`, and the MFA assurance level is a JWT claim (`aal1`/`aal2`)
enforceable directly in a policy with `as restrictive`. `ADR-0005` already
requires RLS as the tenancy backstop; Option B lets identity and step-up
assurance live in the same enforcement layer. A third-party IdP (Option C) is
foreign to Postgres and cannot do this without extra plumbing.

**4. Option A's real cost is permanent, not one-off.** Extending custom auth
means building and then *maintaining* TOTP, recovery codes, verification and
recovery token flows, three OAuth integrations, a session store with
synchronous revocation, and eventually SAML — on a platform holding case notes
and mailbox content, run by a non-technical founder. The build is finite; the
security-maintenance obligation is not.

### What is explicitly retained
- **The staff-console two-lock gate.** `STAFF_EMAILS` allowlist **and** database
  role, failing closed, unknown role degrading to the weakest staff level. This
  is a platform authorisation control and does not move to the identity provider.
  Supabase authenticates; the two-lock gate still authorises.
- **`src/middleware.ts`** deny-by-default, re-pointed at Supabase session
  verification.
- **Roles and permissions stay ours** (`ADR-0005`). The IdP answers *who*, the
  platform answers *what they may do*.

### What this supersedes
`ADR-0004`'s decision section. Its target characteristics stand unchanged and
become the acceptance criteria.

## 6. The one verification that must precede implementation

**Supabase Auth data residency for a Canadian project could not be verified from
primary documentation in this environment** — `supabase.com` is blocked by the
network egress proxy, so `docs/guides/platform/regions` was unreachable. MFA and
RLS facts above were verified from the docs *source* in the `supabase/supabase`
GitHub repository; the residency question was not.

`ADR-0015` requires personal data to stay in Canada by default, and authentication
data — email addresses, and the identity graph itself — is personal data.

**Required before any implementation work:** confirm from Supabase's own regions
and security documentation, or in writing from Supabase, that Auth data for a
Canada-Central project resides in that region. Record the answer in
`../governance/COMPLIANCE_REGISTER.md`.

If it does **not**, this decision is void and the gate re-opens with Option A or
D favoured, because residency is a hard constraint and not a preference. This is
recorded as a blocker rather than assumed away.

## 7. Status

| Item | State |
| --- | --- |
| Gate performed | **YES** |
| Options compared against all `ADR-0004` criteria | **YES** |
| Decision | **Option B — Supabase Auth** |
| Decision ratified | **NO** — blocked on the §6 residency verification |
| Implementation started | **NO**, and must not start until §6 clears |
