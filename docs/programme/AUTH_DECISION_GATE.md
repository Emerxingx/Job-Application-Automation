# Stage 01 — Authentication Decision Gate

**Status:** DECISION RECORDED AND **RATIFIED** (see §6, §7)
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
| `src/proxy.ts` | Added in Stage 01: deny-by-default edge gate (Next 16 renamed the convention) |

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
| **Canada residency** | ours to control | ✅ **`ca-central-1`, on founder attestation** (§6) | ⚠️ varies by vendor | ours to control |
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
- **`src/proxy.ts`** deny-by-default, re-pointed at Supabase session
  verification.
- **Roles and permissions stay ours** (`ADR-0005`). The IdP answers *who*, the
  platform answers *what they may do*.

### What this supersedes
`ADR-0004`'s decision section. Its target characteristics stand unchanged and
become the acceptance criteria.

## 6. The residency verification that gated this decision — SATISFIED, with provenance stated

### 6.1 What was open

**Supabase Auth data residency for a Canadian project could not be verified from
primary documentation in this environment** — `supabase.com` is blocked by the
network egress proxy, so `docs/guides/platform/regions` was unreachable. The MFA
and RLS facts in §4 were verified from the docs *source* in the
`supabase/supabase` GitHub repository; the residency question was not, because
the regions page is generated from an API listing rather than from committed
Markdown.

`ADR-0015` requires personal data to stay in Canada by default, and
authentication data — email addresses, and the identity graph itself — is
personal data. So this was recorded as a blocker rather than assumed away.

### 6.2 What resolved it

On **2026-09-02** the founder recorded the following, having provisioned the
project:

> The Supabase project has been explicitly provisioned in: Canada (Central), AWS
> region: `ca-central-1`. Authoritative Supabase documentation confirms: Canada
> Central is an available specific project region; the selected project region
> determines primary project data storage; Supabase Auth is deployed alongside
> the project database; Supabase Auth user records are stored in the project's
> Postgres `auth` schema.
>
> **SUPABASE AUTH TECHNICAL RESIDENCY GATE: SATISFIED**

The chain that makes this dispositive for §6.1 is the third and fourth clauses:
if Auth user records live in the project's own Postgres `auth` schema, then Auth
data has the same residency as the project database, and the residency question
for Auth collapses into the one `ADR-0015` already answered for the database.

### 6.3 Provenance — read this before relying on it

| | |
| --- | --- |
| Source | **Founder attestation**, 2026-09-02 |
| Independently verified by the engineering agent | **NO** — `supabase.com` remains egress-blocked from this environment |
| What the agent *can* verify, and will | That the provisioned project actually reports `ca-central-1`, once project credentials reach an environment the agent can read (see §6.5) |
| Standing of the claim until then | Founder-supplied, recorded as such, **not** an agent-verified measurement |

This distinction is kept deliberately. The programme's evidence standard forbids
recording `PASS` without evidence; an attestation from the accountable owner is
legitimate evidence of a *business* fact (which region was selected) and is the
correct authority for it, but it is not the same artefact as a measurement, and
the register must not later read as though the agent measured it.

### 6.4 What this explicitly does NOT resolve

Recorded verbatim from the founder's instruction, because the boundary matters
more than the clearance:

> This does NOT resolve the separate WorkBC/public-sector legal/compliance
> question regarding subprocessors, cross-border processing, or contractual
> requirements. Keep those public-sector/legal items OPEN in the compliance
> register until counsel resolves them. Do not treat this technical gate as legal
> approval for WorkBC/public-sector deployment.

Accordingly:

- `L-1` (public-sector subprocessor and cross-border processing acceptability)
  stays **OPEN** in `../governance/COMPLIANCE_REGISTER.md`.
- `L-3` (cross-border AI processing under intended customer contracts) stays
  **OPEN**; it was never in scope for this gate and is unaffected.
- **Product 3 (Employment Services / WorkBC Case Manager OS) may not be deployed
  to a public-sector customer on the strength of this section.** The technical
  gate says data sits in Canada. It does not say the contract permits the
  processor, the subprocessor chain, or the support-access path.

### 6.5 The residual verification, and when it must happen

| | |
| --- | --- |
| What | Confirm the provisioned project's region string is `ca-central-1`, from the project itself rather than from documentation |
| How | Read the region from the project's connection endpoint / project settings once credentials are present, without printing the credential |
| Latest point it may remain unverified | Before Stage 01's exit gate is recorded `PASS` |
| Why not blocking now | It cannot change the *decision*: if the project turned out to be in another region the remedy is to re-provision the project in `ca-central-1`, not to pick a different identity vendor. The decision is ratified; the deployment fact is verified at deployment. |

## 7. Ratification

**The decision is RATIFIED: Option B — Supabase Auth**, on the founder
attestation recorded in §6.2, subject to §6.4 (no WorkBC/public-sector
deployment on this basis) and §6.5 (deployment-region confirmation before the
Stage 01 exit gate).

Implementation may now begin. What implementation is *also* gated on is
separate and unchanged: a Supabase project reachable from the build environment.
That is a credential blocker, not a decision blocker — see
`AUTONOMOUS_STATUS.json` → `blockers[SUPABASE-PROJECT]`.

### 7.1 Implementation sequence unlocked by this ratification

In dependency order. Each is `NOT_STARTED` until the credential blocker clears,
except where marked.

1. **Baseline PostgreSQL migration** (`ADR-0002`) — the first migration in the
   repository's history; `prisma/migrations/` does not yet exist.
2. **RLS policies on real tables** (`ADR-0005`), replacing the 63 hand-written
   `where: { userId }` clauses as the *backstop* — the clauses stay; RLS is what
   makes omitting one survivable.
3. **Transaction-scoped tenancy context** — `SET LOCAL`, never session `SET`.
   The mechanism is already proven (`tests/rls-isolation.test.ts`); what needs
   the real project is proof under the actual pooler in the actual pool mode.
4. **`Organization` / `Membership` wiring** — schema-only today.
5. **Server-side session revocation** — the single most serious absence in §2.
6. **Email verification, MFA, account recovery, OAuth.**
7. **Consent capture and the audit trail** for all of the above.

## 8. Status

| Item | State |
| --- | --- |
| Gate performed | **YES** |
| Options compared against all `ADR-0004` criteria | **YES** |
| Decision | **Option B — Supabase Auth** |
| Decision ratified | **YES** — 2026-09-02, on the founder attestation in §6.2 |
| Basis of ratification | Founder attestation, **not** agent-verified (§6.3) |
| Residual verification | Project region confirmed from the project itself, before the Stage 01 exit gate (§6.5) |
| WorkBC / public-sector legal clearance | **NO — `L-1` and `L-3` remain OPEN** (§6.4) |
| Implementation started | **NO** — unblocked by this ratification, still blocked on a reachable Supabase project |
