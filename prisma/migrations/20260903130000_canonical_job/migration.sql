-- Stage 06: the canonical job (JOB_INTELLIGENCE_ARCHITECTURE "Canonical job").
--
-- Classification (src/lib/tenancy/rls-tables.ts):
--   Job           — reference (unchanged); the new columns are derived from the
--                   posting text by src/lib/jobs/canonical.ts and hold no
--                   personal data.
--   JobProvenance — reference: which registered sources carry a canonical job,
--                   with each source's own apply link, first/last sighting
--                   and last content hash. Shared like Job.
--
-- The canonical columns are added with defaults and filled by the pipeline on
-- the next capture of each posting, and for the existing rows by
-- `npm run jobs:canonicalize` (an idempotent, resumable operator command —
-- see docs/operations/DATABASE_MIGRATIONS.md). Provenance for the existing
-- rows IS backfilled here, from the (sourceId, externalId) every Stage 05
-- capture already carries, because it is pure SQL and idempotent.

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "canonicalHash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "certificationRequirements" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN     "educationRequirements" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN     "experienceYearsMax" INTEGER,
ADD COLUMN     "experienceYearsMin" INTEGER,
ADD COLUMN     "languageRequirements" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN     "normalizedCompany" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "normalizedTitle" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "occupationFamily" TEXT,
ADD COLUMN     "postalRegion" TEXT,
ADD COLUMN     "preferredSkills" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN     "requiredSkills" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN     "socCode" TEXT,
ADD COLUMN     "sponsorship" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "workAuthorization" TEXT;

-- CreateTable
CREATE TABLE "JobProvenance" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "applyUrl" TEXT NOT NULL DEFAULT '',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceHash" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "JobProvenance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobProvenance_jobId_idx" ON "JobProvenance"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "JobProvenance_sourceId_externalId_key" ON "JobProvenance"("sourceId", "externalId");

-- CreateIndex
CREATE INDEX "Job_canonicalHash_idx" ON "Job"("canonicalHash");

-- CreateIndex
CREATE INDEX "Job_normalizedTitle_idx" ON "Job"("normalizedTitle");

-- CreateIndex
CREATE INDEX "Job_activeState_postedAt_idx" ON "Job"("activeState", "postedAt");

-- AddForeignKey
ALTER TABLE "JobProvenance" ADD CONSTRAINT "JobProvenance_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobProvenance" ADD CONSTRAINT "JobProvenance_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "JobSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: one provenance row per existing capture. Idempotent.
INSERT INTO "JobProvenance" ("id", "jobId", "sourceId", "externalId", "applyUrl", "firstSeenAt", "lastSeenAt", "sourceHash")
SELECT 'prov_' || "id", "id", "sourceId", "externalId", "applyUrl", "firstSeenAt", "lastSeenAt", "sourceHash"
FROM "Job"
WHERE "sourceId" IS NOT NULL
ON CONFLICT ("sourceId", "externalId") DO NOTHING;
