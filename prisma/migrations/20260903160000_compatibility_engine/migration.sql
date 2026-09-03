-- Stage 08: the compatibility engine (JOB_INTELLIGENCE_ARCHITECTURE
-- "Compatibility engine (Stage 08)").
--
-- Classification (src/lib/tenancy/rls-tables.ts):
--   MatchDimension     — user-owned (userId): the named dimensions a match
--                        score decomposes into, each with its weight,
--                        contribution, matched / missing items and the
--                        approved evidence ids cited for it.
--   MatchWeightVersion — system-only: the governed, versioned weight register.
--   JobMatch           — unchanged classification; gains the weight and
--                        pipeline versions a score was computed with, so a
--                        later weight change never rewrites history.
-- No weight version is seeded: until an admin creates, a second admin
-- approves and one is activated, the built-in weights apply and are recorded
-- as "builtin:1" — the tested baseline, not a silent default.

-- AlterTable
ALTER TABLE "JobMatch" ADD COLUMN     "pipelineVersion" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "weightVersion" TEXT NOT NULL DEFAULT 'builtin:1';

-- CreateTable
CREATE TABLE "MatchDimension" (
    "id" TEXT NOT NULL,
    "jobMatchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "contribution" DOUBLE PRECISION NOT NULL,
    "matched" TEXT NOT NULL DEFAULT '[]',
    "missing" TEXT NOT NULL DEFAULT '[]',
    "evidenceIds" TEXT NOT NULL DEFAULT '[]',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchDimension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchWeightVersion" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "weights" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdByEmail" TEXT,
    "approvedById" TEXT,
    "approvedByEmail" TEXT,
    "approvedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchWeightVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MatchDimension_userId_idx" ON "MatchDimension"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchDimension_jobMatchId_dimension_key" ON "MatchDimension"("jobMatchId", "dimension");

-- CreateIndex
CREATE UNIQUE INDEX "MatchWeightVersion_version_key" ON "MatchWeightVersion"("version");

-- CreateIndex
CREATE INDEX "MatchWeightVersion_status_idx" ON "MatchWeightVersion"("status");

-- AddForeignKey
ALTER TABLE "MatchDimension" ADD CONSTRAINT "MatchDimension_jobMatchId_fkey" FOREIGN KEY ("jobMatchId") REFERENCES "JobMatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

