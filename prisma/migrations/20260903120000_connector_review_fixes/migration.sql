-- Stage 05 independent review (STAGE05_EVIDENCE.md §11).

-- L4: the console orders the run audit by startedAt across every source.
-- CreateIndex
CREATE INDEX "JobSourceRun_startedAt_idx" ON "JobSourceRun"("startedAt");

-- L5: `Job.firstSeenAt` was added with DEFAULT now(), which stamped every
-- pre-existing posting with the migration time. `scrapedAt` holds the real
-- first capture for those rows (it only moves forward on re-capture, so a
-- row whose firstSeenAt is LATER than its scrapedAt can only be one the
-- default stamped). Idempotent: a second run matches nothing.
UPDATE "Job" SET "firstSeenAt" = "scrapedAt" WHERE "firstSeenAt" > "scrapedAt";
