/**
 * Apply every service-provider organisation's case-record retention policy
 * (Stage 17, ADR-0032).
 *
 *   npm run cases:retention
 *
 * Notes and assessments older than the organisation's `caseNoteDays`, and
 * closed cases closed longer ago than `closedCaseDays`, are deleted; an
 * organisation with NO policy is untouched. Audited per organisation with
 * counts. Meant for a scheduler; none exists in the codebase (Stage 24).
 */
import { db } from '../../src/lib/db';
import { purgeExpiredCaseRecords } from '../../src/lib/cases/service';

purgeExpiredCaseRecords()
  .then((r) => console.log(`[retention] ${r.organizations} organisation(s) with a policy: ${r.notes} notes, ${r.assessments} assessments, ${r.cases} closed cases purged`))
  .catch((error) => {
    console.error(`[retention] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
