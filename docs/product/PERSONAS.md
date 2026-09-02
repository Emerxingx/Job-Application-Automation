# Personas

## P1 — Candidate

**Priya — mid-career newcomer to Canada.** Ten years of experience abroad;
Canadian employers do not recognise her credentials. Needs to know which roles she
is **eligible** for (work authorisation, credential recognition), which of her
experience transfers, and what specifically to fix.
*Depends on:* eligibility engine, evidence vault, credential recognition, NOC
mapping, career transition.

**Daniel — laid-off senior developer.** Applying at volume, hearing nothing, no
idea whether the problem is his résumé, his targeting, or the market. Wants
truthful tailoring and evidence of what is actually working.
*Depends on:* compatibility explanation, document versioning, candidate analytics,
Job Folder.

**Sam — first job after college.** Little experience, unsure what to target, does
not know the vocabulary employers use.
*Depends on:* adjacent titles, skills taxonomy, question bank, guided onboarding.

**What every candidate needs and cannot get today:** to see exactly what was sent
on their behalf, and to trust that nothing in it was invented.

## P2 — Employer / Talent Acquisition

**Maria — in-house recruiter, 15 open requisitions.** Drowning in unqualified
applicants. Wants genuinely qualified, consented, available candidates and a
pipeline she can report on.
*Depends on:* matching, consent gating, pipeline, recruiter analytics.

**Tom — hiring manager.** Needs shortlists and interview coordination, not a
recruiting tool to learn.
*Depends on:* collaboration, interview scheduling, simple review surfaces.

**Alia — agency recruiter.** Represents candidates to multiple clients. Needs
explicit representation consent, ownership, and fee tracking.
*Depends on:* staffing module, representation consent, placement fees, guarantees.

## P3 — Employment Services / WorkBC

**Janelle — WorkBC case manager, caseload of 60.** Spends more time on
documentation than on clients. Needs to know **which clients are stuck and why**,
and needs the platform to produce evidence for programme reporting.
*Depends on:* caseload dashboard, AI copilot (recommend-only), action plans, case
notes, outcome and retention reporting.

**Ken — supervisor.** Accountable for outcomes and audit. Needs caseload
distribution, outcome rates and a defensible audit trail.
*Depends on:* organisational reporting, audit, retention policy.

**Constraint:** case notes are among the most sensitive data on the platform.
Strict isolation, full audit, no AI processing without organisational consent.

## P4 — Career changer

**Rob — tradesperson with a shoulder injury.** Must change occupation. Needs to
know which occupations his skills transfer to, what the gap is, what training
closes it, and whether the training is **worth it**.
*Depends on:* transition engine, skills graph, learning catalog, eligibility
counterfactual.

## Platform

**Avinash — founder, non-technical.** Must be able to change prices, plans,
entitlements, job sources, AI models, matching weights and feature flags without
a developer. Must be able to see what the business is doing and trust that
reported numbers are real.
*Depends on:* the admin operating system (`../adr/ADR-0019`), honest status
reporting, evidence-backed dashboards.

**Support / billing ops staff.** Need to help customers without unrestricted
access to personal data. Impersonation must be read-only, reason-required and
time-boxed.
