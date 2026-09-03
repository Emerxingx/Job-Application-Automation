/**
 * Backfill the Stage 06 canonical columns on jobs captured before the
 * canonical migration (their `canonicalHash` is still empty), in batches.
 *
 *   npm run jobs:canonicalize        # all rows with an empty canonicalHash
 *
 * Idempotent and resumable: a row is skipped once it has a hash, so a
 * crash mid-way loses nothing. The canonical fields are computed from the
 * stored capture through the same pure function the pipeline uses; nothing
 * is merged here — provenance was backfilled by the migration, and dedup
 * applies to captures as they arrive.
 */
import { db } from '../../src/lib/db';
import { canonicalColumns, canonicalize } from '../../src/lib/jobs/canonical';
import type { NormalizedPosting } from '../../src/lib/connectors/types';
import { parseJson } from '../../src/lib/types';

const BATCH = 200;

async function main() {
  let done = 0;
  for (;;) {
    const rows = await db.job.findMany({ where: { canonicalHash: '' }, take: BATCH, orderBy: { firstSeenAt: 'asc' } });
    if (rows.length === 0) break;
    for (const job of rows) {
      const posting: NormalizedPosting = {
        source: job.source,
        externalId: job.externalId,
        title: job.title,
        company: job.company,
        companyLogo: job.companyLogo ?? undefined,
        location: job.location,
        country: job.country as NormalizedPosting['country'],
        workMode: job.workMode as NormalizedPosting['workMode'],
        jobType: job.jobType as NormalizedPosting['jobType'],
        salaryMin: job.salaryMin ?? undefined,
        salaryMax: job.salaryMax ?? undefined,
        salaryCurrency: job.salaryCurrency,
        description: job.description,
        requirements: parseJson<string[]>(job.requirements, []),
        skills: parseJson<string[]>(job.skills, []),
        nocCode: job.nocCode ?? undefined,
        applyUrl: job.applyUrl,
        applyMethod: job.applyMethod as NormalizedPosting['applyMethod'],
        postedAt: job.postedAt.toISOString(),
      };
      // The occupation family is set by classification against the spine
      // (ADR-0009: confidence recorded, never implied), not from the capture-time regex guess.
      await db.job.update({ where: { id: job.id }, data: canonicalColumns(canonicalize(posting)) });
      done += 1;
    }
    console.log(`[canonicalize] ${done} job(s) so far`);
  }
  console.log(`[canonicalize] done: ${done} job(s) canonicalised`);
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
