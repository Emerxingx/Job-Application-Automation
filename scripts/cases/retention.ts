/**
 * Apply every service-provider organisation's case-record retention policy
 * (Stage 17, ADR-0032).
 *
 *   npm run cases:retention
 *
 * Notes and assessments of cases CLOSED longer ago than the organisation's
 * `caseNoteDays`, and closed cases closed longer ago than `closedCaseDays`
 * (with everything under them), are deleted; an open case is never thinned;
 * an organisation with NO policy is untouched. Audited per organisation with
 * counts. Meant for a scheduler; none exists in the codebase (Stage 24).
 */
import { db } from '../../src/lib/db';
import { purgeExpiredCaseRecords } from '../../src/lib/cases/service';
import { redactError } from '../../src/lib/log';

purgeExpiredCaseRecords()
  .then((r) => console.log(`[retention] ${r.organizations} organisation(s) with a policy: ${r.notes} notes, ${r.assessments} assessments, ${r.cases} closed cases (${r.children} rows under them) purged`))
  .catch((error) => {
    console.error(`[retention] failed: ${redactError(error).message}`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
