# User Journeys

Each journey names the stage that delivers it and marks steps that do not work
today.

## J1 — Candidate: signup to first submitted application (MVP)
1. Sign up → **verify email** *(planned)* → optional MFA *(planned)*.
2. Onboarding builds the **Digital Twin** — structured history, education, skills,
   certifications, preferences, **work authorization** *(Stage 02)*.
3. Candidate approves **evidence** for each material claim *(Stage 03)*.
4. Define search: titles, adjacent titles, geography, salary, work mode,
   employment type, deal-breakers *(built, needs expansion)*.
5. Connectors discover, normalize and deduplicate postings *(Stages 05–06)*.
6. **Eligibility** runs first — ineligible roles are excluded **with reasons**
   *(Stage 07)*.
7. **Compatibility** scores eligible roles with dimensions, cited evidence, gaps
   and risks *(Stage 08; deterministic engine exists)*.
8. Candidate opens a job, reads the explanation, chooses to apply.
9. Documents are tailored — **grounded in approved evidence only** — as PDF and
   DOCX, versioned *(Stage 09)*.
10. Application questions filled per policy; `NEVER_AUTOMATE` always asked
    *(Stage 03)*.
11. **Review & Submit** — candidate confirms; assisted apply, or authorized ATS
    API where available *(built)*.
12. **Job Folder** created with the posting snapshot and the exact submitted
    documents *(built, expanding in Stage 10)*.
13. Analytics update *(Stage 13)*.

**Guarantee at every step:** the candidate can see exactly what was sent, and
nothing in it was invented.

## J2 — Candidate: employer replies (V1, Stage 11)
Consented mailbox connection → inbound message classified → associated to a Job
Folder **with a confidence score** → low confidence requires confirmation and is
never auto-filed → `INTERVIEW_DETECTED` → calendar event → interview prep →
outcome recorded → analytics.

## J3 — Career changer (V1, Stage 16)
Assessment (current occupation, skills, education, interests, values,
compensation, lifestyle, learning budget, available time, risk tolerance) →
transferable skills → candidate occupations → market attractiveness → transition
difficulty → skill / experience / education / certification gaps → learning
pathway → experience bridge → target jobs.

**The question that must be answerable:** *will this specific course or
certification materially improve my eligibility for these specific jobs?* —
computed against the eligibility engine, not asserted.

## J4 — Case manager (V2, Stage 17)
Client assigned → assessment and barriers → employment goal and target occupation
→ action plan and tasks → job recommendations → résumé and applications →
**copilot flags a stuck client with reasons** → case manager decides on an
intervention → intervention recorded → training referral → employment outcome →
retention follow-up → programme reporting.

**AI recommends. The case manager decides.** No AI output is auto-applied.

## J5 — Recruiter (V2, Stage 18)
Requisition created → hiring requirements → sourcing and matching → recruiter
review → **candidate consent requested** → submission (only after consent) →
pipeline → interviews → offer → hire → time-to-hire and source reporting.

**No candidate is disclosed without consent**, honouring their recruiter-visibility
preference. Sensitive attributes are never employer-visible.

## J6 — Agency placement (V2, Stage 19)
Client contract → fee structure → engagement → representation consent →
submission → interviews → offer → placement → guarantee period → placement invoice.

**Employer-paid. Never billed to the candidate.**

## J7 — Founder operating the business (V2, Stage 20)
Sign in → platform admin → change a price, adjust a matching weight, enable a job
source, approve a prompt version, toggle a feature flag, review integration health
— **all without a developer**, all versioned and audited, and none of it able to
widen a security boundary (`ADR-0019`).
