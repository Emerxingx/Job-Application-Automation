# Stage 11 — Email and calendar intelligence — evidence

Recorded 2026-09-03 on branch `claude/stage-11-email-calendar-intelligence`,
stacked on Stage 10 → 09 (PR #21) → 08 (#20) → 07 (#19) → 06 (#18) → 05 (#17)
→ 04 (#16) → 03 (#15) → 02 (#14) → 01 (#13, PARTIAL). Every line was run or
read; nothing is PASS on the strength of a mock, a skipped test or a
document. This stage's honest centre: **the whole chain — consent, a
metadata-only grant, encrypted tokens, a sync that stores references and
never a body, an explainable association that never auto-files a doubtful
match, a revocation that purges — is built and proven on a fixture-backed
connector; neither Google nor Microsoft has been called from this codebase,
because no client credentials exist here. "Both providers live" is
therefore NOT MET, and it is stated, not approximated.**

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 11: associate employer communication to the
right folder with confidence controls. Gmail and Microsoft Graph with
least-privilege incremental scopes; explicit per-connection consent; both
calendars. Thread→folder association with a confidence score; low-confidence
matches require confirmation and are never auto-filed. Events
`EMAIL_RECEIVED`, `INTERVIEW_DETECTED`, `OFFER_RECEIVED`. Security: the
highest privacy surface — scope minimisation, revocation, encrypted token
storage, retention limits, no mailbox content in prompts without explicit
consent; RESTRICTED. Testing: association precision/recall on a fixture
corpus; scope-revocation behaviour; a leakage test proving mailbox content
never reaches an unconsented AI call. Acceptance: connect, sync, associate,
revoke — all provable; revocation purges derived content. Exit gate: both
providers live with audited consent. Gap G-15.

## 2. Schema and migrations — `PASS` locally; `NOT VERIFIED` on Supabase (R-34, inherited)

| Migration | Content | Rehearsal |
| --- | --- | --- |
| `20260903190000_mailbox_intelligence` | `MailboxConnection` (provider, kind, account, GRANTED scopes, status, the consent it was made under); `MailboxSecret` (AES-256-GCM ciphertext, iv, tag, key version — **system-only**); `EmailThread` (subject, participants, from, dates, invite flag, association state and signals, detections — no body column exists); `EmailMessageRef`; `CalendarEventRef`; `IntegrationEvent` | applied fresh and incrementally; drift clean |
| `20260903190100_rls_mailbox_tables` | Generated (manifest `RLS_MANIFESTS[10]`): the five reference tables user-owned; `MailboxSecret` system — **no tenant policy, so the tenant role cannot read a token at all** (tested) | determinism test; **116** public tables forced |

Consent purposes `mailbox_sync` and `calendar_sync` (version `2026-09-03`)
are added to `src/lib/consent.ts`; security events `mailbox.connected`,
`mailbox.synced`, `mailbox.thread.confirmed`, `mailbox.thread.rejected`,
`mailbox.revoked`.

## 3. Scope inventory — `PASS`

| Provider · kind | Requested (metadata) | Listed, NEVER requested (content) |
| --- | --- | --- |
| Google · mail | `gmail.metadata` | `gmail.readonly` |
| Google · calendar | `calendar.events.readonly` | — |
| Microsoft · mail | `Mail.ReadBasic`, `offline_access` | `Mail.Read` |
| Microsoft · calendar | `Calendars.Read`, `offline_access` | — |

`gmail.metadata` and `Mail.ReadBasic` cannot return a message body; that is
the design, not a setting. The inventory is a constant the tests assert
(no content scope is ever in a request; the authorize URL carries the
metadata scope and no `readonly`) and the settings page shows to the
applicant before they connect. A grant that comes back WITH a content scope
is revoked at the provider and refused, and nothing is saved (tested).

## 4. Connect — `PASS` (mock) · `IMPLEMENTED-NOT-VALIDATED` (real)

`beginConnection` refuses without the current consent for the kind; the
OAuth `state` is signed (HMAC, ten-minute expiry, nonce) and bound to the
signed-in user — a callback with someone else's state is refused (tested);
`completeConnection` exchanges the code, checks the granted scopes,
encrypts the token set and writes the connection against the consent id.
Audited as `mailbox.connected` with the scopes and a digest of the address
— never the address, never a token (tested). Without
`MAILBOX_ENCRYPTION_KEY` nothing can be stored and the flow refuses with a
clear message (tested).

The Google and Microsoft adapters (`src/lib/mailbox/providers/google.ts`,
`microsoft.ts`) implement the code flow, refresh, thread and event listing
with header-only selections, and revocation, against the documented APIs.
**No request has been made to either provider from this codebase**: no
client id or secret exists in this environment. The registry refuses to
serve an unconfigured real adapter and — unlike a job source — never falls
back to the mock in production (a fake mailbox would be a lie to the
applicant); `MAILBOX_CONNECTOR=mock` is honoured outside production only.

## 5. Sync and association — `PASS` (fixture)

`syncConnection`: tokens decrypted on the system client and used only to
call the connector; folders (applications the employer has, with their
contacts) loaded on the tenant path; every thread and event written on the
tenant path with the owner's id; a provider failure marks the connection
`error` with a stable code. No cursor is persisted: the window (180 days) is
re-read each sync and every write is an idempotent upsert (a second sync
adds no rows and no events — tested).

`src/lib/mailbox/associate.ts` — signals and weights:

| Signal | Weight | Meaning |
| --- | --- | --- |
| `contact_address` | 0.60 | a Stage 10 contact's address is a participant |
| `company_domain` | 0.50 | a sender-domain label IS the company's name run together or one distinctive token — "maplewoodcondos" is not "maple" (tested) |
| `contact_domain` | 0.45 | the sender's domain is a contact's (non-free-mail) domain |
| `subject_company` | 0.30 | the subject names the company |
| `subject_title` | 0.25 | the subject names the role |
| `ats_sender` | 0.25 | an applicant-tracking system sent it — only beside a subject match, because an ATS says "a hiring process", not which |
| `after_application` / `before_application` | +0.10 / −0.40 | timing against `appliedAt` |

Sum, capped at 1. **≥ 0.85 with no rival within 0.10 → `auto`** (filed,
reversible); **≥ 0.50 → `pending`** (a suggestion the applicant confirms or
rejects — never filed); else `none`. Ties break on the company name. The
applicant's decision (`confirmed` / `rejected`) is never overwritten by a
re-sync (tested).

**Corpus** (`tests/fixtures/mailbox-corpus.json`): three applications of
one applicant (Maple Analytics — Greenhouse, with a named recruiter; Birch
Financial; Cedar Health — Workday) and 25 labelled threads: ATS
confirmations, recruiter mail, calendar invites, an outbound reply, a
"following up" with no subject signal (pending), an ambiguous ATS "Data
Analyst opportunity" that fits two folders (pending, rival named), an
agency's unrelated approach, a company newsletter and a promotion sent
BEFORE the application, a shipping notice, a dentist's invite, a condo
developer whose domain starts with the company's token, a career-coach
newsletter, an "Application update" from an ATS with no other signal, an
offer letter, a compensation-details thread, and an "Interview request" from
the employer's domain with no other signal (pending AND interview-detected —
the case whose event fires only on confirmation).

| Measure (auto-filing, `tests/mailbox-association.test.ts`) | Result |
| --- | --- |
| Every thread files as labelled (status and folder) | 25 / 25 |
| Precision of automatic filing | **1.00** (12 auto, 0 wrong) |
| Recall of automatic filing against the labelled auto set | **1.00** |
| Low-confidence never auto-filed; near-tie pending with its rival named; pre-application thread penalised; look-alike domain not filed | asserted |
| Detection (interview, offer) from subject and invite only, incl. "special offer" not an offer | 25 / 25 |

The corpus is small and hand-labelled; the numbers say the rules do what
they say on it, not what they would do on a real mailbox (no real mailbox
has been read — §4).

**Events**: `EMAIL_RECEIVED` once per new thread; `INTERVIEW_DETECTED` and
`OFFER_RECEIVED` once per thread and only for a FILED thread (auto or
confirmed) — a dentist's invite files nowhere and fires nothing; a pending
thread's detection fires when the applicant confirms it (tested on t25).
A calendar invite fires `INTERVIEW_DETECTED` once, on the sync that FILES
it — its first, or a later one after a contact is added to the folder — or on
the applicant's confirmation; a pending invite is a suggestion on the folder
with the same confirm / reject as a thread (tested). Payloads carry ids
only (tested).

## 6. Revocation — `PASS`

`revokeConnection`: the provider is asked to invalidate the grant (best
effort; Microsoft has no per-grant endpoint — recorded); then, in one
transaction, the secret, every thread and message reference, every calendar
reference and every integration event of the connection are deleted and the
connection marked `revoked`. The counts come back to the applicant and go to
the audit (`mailbox.revoked`) — no subject, no address, no token (tested:
the audit blob contains none of them). A revoked connection cannot sync.

Retention: references older than the 180-day window that are not filed or
confirmed are pruned by the sweep (`npm run mailbox:sync`); rows in the
retention matrix.

## 7. The leakage proof — `PASS`

`tests/mailbox-leakage.test.ts`: (1) static — nothing under
`src/lib/mailbox` imports the AI gateway, grounding, a model provider or
the SDK; (2) runtime — the gateway's RESTRICTED-field check refuses any
payload carrying a `mailbox` key, however nested. There is no consented
path either: **AI over mailbox content is NOT IMPLEMENTED** in this stage,
by design (ADR-0025 §4), so "never reaches an unconsented AI call" holds
because no call exists, not because a flag is checked.

## 8. Surfaces

- Settings → "Email and calendar": the scope inventory per connection with
  its consent checkbox, connect, sync now, revoke (with the purge counts),
  and the callback's outcome.
- Application folder → "Communications": filed threads (with why, and the
  interview / offer chips), suggestions — threads AND calendar events — to
  confirm or reject, filed calendar events (each removable). Headers only;
  the copy says so.

## 9. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 8 warnings (baseline) |
| Typecheck | 0 |
| Tests | **1033 / 1033**, 0 skipped (Stage 10: 1016) — new: `mailbox-association` 7, `mailbox-leakage` 2, `mailbox-sync` 7 — seventeen with the RLS coverage row |
| Build | passes; `/api/mailbox`, `/api/mailbox/connect`, `/api/mailbox/callback`, `/api/mailbox/[id]`, `/api/mailbox/[id]/sync`, `/api/mailbox/threads/[threadId]` present |
| Migrations | thirty applied fresh; drift clean; 116 public tables forced; RLS migration equals the generator output |

## 10. Exit gate — verdict

| Condition | State |
| --- | --- |
| Least-privilege incremental scopes; explicit per-connection consent | **MET** (inventory asserted; a content-scope grant refused) |
| Encrypted token storage; tenant role cannot read tokens | **MET** |
| Association with confidence; low confidence never auto-filed | **MET** on the fixture corpus (P = R = 1.00) |
| Events | **MET** — emitted; nothing consumes them automatically yet (ADR-0011 not built) |
| Revocation purges derived content | **MET** |
| No mailbox content in an AI call without consent | **MET** — no such call exists (NOT IMPLEMENTED by design) |
| Both providers live with audited consent | **NOT MET — BLOCKED (CREDENTIAL + EXTERNAL_SERVICE)**: adapters written, never called; no client credentials in this environment |

**Verdict: Stage 11 passes every engineering gate that can be run here;
its exit is BLOCKED** on provider credentials — the adapters are
IMPLEMENTED-NOT-VALIDATED and the register says so — and PARTIAL on the
inherited causes. Merge posture inherited from the stack.

## 11. What a founder or operator has to do

1. Create the Google Cloud OAuth client (scopes `gmail.metadata`,
   `calendar.events.readonly`; verification will be required for a
   restricted Gmail scope) and the Microsoft Entra app registration
   (`Mail.ReadBasic`, `Calendars.Read`, `offline_access`); set
   `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `MICROSOFT_OAUTH_CLIENT_ID/SECRET`
   (and tenant), and a 32-byte `MAILBOX_ENCRYPTION_KEY`.
2. Validate connect → sync → revoke against a real test mailbox for each
   provider and record the result in the register.
3. Decide the consent design for AI over mailbox content, if ever (L-3
   remains open); until then the platform has no such path.
4. Staging — unchanged (R-34).

## 12. Independent review

An independent adversarial pass over the whole diff (tenant leakage, secret
handling, content, OAuth, the engine, migration, revocation, false PASS,
dead code). Nothing HIGH; four MEDIUM and two LOW, every one fixed:

| Severity | Finding | Disposition |
| --- | --- | --- |
| MEDIUM | `subject_title` was vacuously true for a job title with no distinctive word ("PM"): `[].every()` is `true`, so a contact's unrelated mail could cross the auto threshold | **Fixed** — an empty word list never matches; pure test (contact address alone stays `pending`) |
| MEDIUM | The evidence claimed "a pending thread's detection fires on confirmation (tested)" but no corpus thread was both pending and detected; the test proved the opposite case only | **Fixed** — t25 added (pending + interview); the test asserts 0 events while pending, 1 after confirmation, still 1 after a re-sync |
| MEDIUM | The retention matrix carried the old 90-day placeholder rows beside the new 180-day rows | **Fixed** — placeholders removed |
| MEDIUM | A `pending` calendar event had no path to be seen or decided (no route, not queried), and an invite that became filable on a later sync never fired its event | **Fixed** — `decideEventAssociation` + `PATCH /api/mailbox/events/:id`, event suggestions on the folder with confirm / reject, filed events removable; emission keyed on "first filed" rather than "first seen"; database test covers first-sync filing, suggestion, confirmation, re-sync, later-sync filing and the audit content |
| LOW | `.env.example` said the key may be hex; the code read base64 only, so a hex key failed closed with a misleading message | **Fixed** — 64 hex characters accepted alongside base64; tested |
| LOW | A non-`MailboxError` failure in the OAuth callback (a network error mid-redirect) surfaced as a JSON 500 page | **Fixed** — every failure lands on settings with a notice; the log line carries the message only, never the code, the state or a token |

Found sound, with the line read: `MailboxSecret` has no tenant policy and
is classified system; every decision path filters by the owner; the state
is signed, expiring, nonce-bearing and user-bound; tokens are encrypted with
a fresh IV per write and never rendered or audited; both real adapters
select headers only; the registry refuses an unconfigured adapter and the
mock in production; the single-transaction purge matches the counts the
test asserts; precision and recall are computed, not asserted constants.
