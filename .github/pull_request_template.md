## What this changes

<!-- What and why. Link the stage and any ADR this implements or alters. -->

**Stage:** <!-- e.g. Stage 00 -->
**ADRs touched:** <!-- e.g. ADR-0014, or "none" -->

## Evidence

<!-- Paste real output. "Should pass" is not evidence. -->

- [ ] `npm run lint:ci`
- [ ] `npx tsc --noEmit`
- [ ] `npm test`
- [ ] `npm run build`

## Checks against the approved baseline

- [ ] No integration is described above its status in `docs/governance/INTEGRATION_REGISTER.md`
- [ ] No UI claims behaviour that is not implemented
- [ ] No test was skipped, disabled or deleted to obtain a green run
- [ ] No sensitive demographic attribute can reach a matching, scoring, ranking or recommendation path (`ADR-0007`)
- [ ] No autonomous application submission was added (`ADR-0016`)
- [ ] No unlawful data acquisition (`docs/governance/SOURCE_ACCESS_POLICY.md`)
- [ ] `npm audit fix --force` was NOT run (`ADR-0017`)
- [ ] Generated files were regenerated with the repo's tooling, not hand-edited
- [ ] Every new query is tenant-scoped

## Anything a reviewer should look at closely

<!-- Trade-offs, risks, or anything you are unsure about. -->
