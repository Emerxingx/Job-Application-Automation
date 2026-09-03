-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "activeState" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "sourceHash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "sourceId" TEXT;

-- CreateTable
CREATE TABLE "JobSource" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 6,
    "status" TEXT NOT NULL DEFAULT 'disabled',
    "legalBasis" TEXT NOT NULL DEFAULT '',
    "termsReviewedAt" TIMESTAMP(3),
    "termsReviewedByEmail" TEXT,
    "robotsPosition" TEXT NOT NULL DEFAULT '',
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 0,
    "attributionRequired" BOOLEAN NOT NULL DEFAULT false,
    "attributionText" TEXT NOT NULL DEFAULT '',
    "dataCategories" TEXT NOT NULL DEFAULT '[]',
    "personalData" BOOLEAN NOT NULL DEFAULT false,
    "retentionRef" TEXT NOT NULL DEFAULT '',
    "approvedAt" TIMESTAMP(3),
    "approvedByEmail" TEXT,
    "credentialEnvVars" TEXT NOT NULL DEFAULT '[]',
    "lastRunAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastHealthAt" TIMESTAMP(3),
    "lastHealthStatus" TEXT NOT NULL DEFAULT 'unknown',
    "lastError" TEXT,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobSourceRun" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "discovered" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "closed" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "meta" TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "JobSourceRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobSnapshot" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sourceId" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceHash" TEXT NOT NULL,
    "payload" TEXT NOT NULL,

    CONSTRAINT "JobSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AtsRuleset" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "navigationFlowType" TEXT NOT NULL DEFAULT 'single_page',
    "pacing" TEXT NOT NULL DEFAULT 'standard',
    "selectorMap" TEXT NOT NULL DEFAULT '{}',
    "fallbackSelectors" TEXT NOT NULL DEFAULT '{}',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdByEmail" TEXT NOT NULL DEFAULT '',
    "approvedById" TEXT,
    "approvedByEmail" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AtsRuleset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobSource_key_key" ON "JobSource"("key");

-- CreateIndex
CREATE INDEX "JobSourceRun_sourceId_startedAt_idx" ON "JobSourceRun"("sourceId", "startedAt");

-- CreateIndex
CREATE INDEX "JobSnapshot_jobId_capturedAt_idx" ON "JobSnapshot"("jobId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobSnapshot_jobId_sourceHash_key" ON "JobSnapshot"("jobId", "sourceHash");

-- CreateIndex
CREATE INDEX "AtsRuleset_platform_status_idx" ON "AtsRuleset"("platform", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AtsRuleset_platform_version_key" ON "AtsRuleset"("platform", "version");

-- CreateIndex
CREATE INDEX "Job_sourceId_activeState_lastSeenAt_idx" ON "Job"("sourceId", "activeState", "lastSeenAt");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "JobSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobSourceRun" ADD CONSTRAINT "JobSourceRun_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "JobSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobSnapshot" ADD CONSTRAINT "JobSnapshot_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobSnapshot" ADD CONSTRAINT "JobSnapshot_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "JobSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- Classification (DATA_CLASSIFICATION.md).
-- ---------------------------------------------------------------------------
COMMENT ON TABLE "JobSource"    IS 'classification: INTERNAL — per-connector legal basis, terms review, approval, health; credential NAMES only';
COMMENT ON TABLE "JobSourceRun" IS 'classification: INTERNAL — audit of every discovery / refresh / health run; query shape only, never candidate identity';
COMMENT ON TABLE "JobSnapshot"  IS 'classification: INTERNAL — the posting as captured, immutable (DATA_RETENTION_MATRIX: 3 years after closed_at)';
COMMENT ON TABLE "AtsRuleset"   IS 'classification: INTERNAL — security-relevant automation configuration, staff-administered (ADR-0019 Tier 1)';
COMMENT ON COLUMN "Job"."sourceHash"  IS 'Stage 05: SHA-256 of the last normalised capture; a change writes a JobSnapshot';
COMMENT ON COLUMN "Job"."activeState" IS 'Stage 05: active | closed | unknown, kept honest by refresh() and detectClosed()';

-- Snapshots are immutable: the Job Folder promises "exactly what the posting
-- said". An UPDATE is refused outright; DELETE is left to retention (cascade
-- from Job) — DATA_RETENTION_MATRIX.md.
CREATE OR REPLACE FUNCTION public.job_snapshot_guard_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'JobSnapshot % is immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
DROP TRIGGER IF EXISTS job_snapshot_immutable ON "JobSnapshot";
CREATE TRIGGER job_snapshot_immutable BEFORE UPDATE ON "JobSnapshot" FOR EACH ROW EXECUTE FUNCTION public.job_snapshot_guard_immutable();
