-- Stage 06 independent review (STAGE06_EVIDENCE.md §9).
--
-- M5: the freshness sweep ordered stale provenance by lastSeenAt and never
-- advanced a row the source could not answer for, so the same rows were
-- re-asked on every sweep and newer stale rows behind the limit were never
-- reached. `lastCheckedAt` records when a source was last asked; the sweep
-- orders by it (never-asked first) and skips rows asked within the window.
-- L18: Job(activeState, postedAt) had no reader — the feed reaches Job through
-- JobMatch — so it is dropped.

-- DropIndex
DROP INDEX "Job_activeState_postedAt_idx";

-- AlterTable
ALTER TABLE "JobProvenance" ADD COLUMN     "lastCheckedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "JobProvenance_sourceId_lastSeenAt_lastCheckedAt_idx" ON "JobProvenance"("sourceId", "lastSeenAt", "lastCheckedAt");

