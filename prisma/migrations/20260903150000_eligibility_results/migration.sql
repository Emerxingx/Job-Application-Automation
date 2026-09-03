-- Stage 07: the eligibility engine (JOB_INTELLIGENCE_ARCHITECTURE "Eligibility
-- engine (Stage 07) — distinct from scoring").
--
-- Classification (src/lib/tenancy/rls-tables.ts):
--   EligibilityResult — user-owned (userId): one verdict per candidate per
--   canonical job, with every rule's status and a human-readable reason,
--   never a number. Evaluated before and apart from fit; `unknown` never
--   excludes. Holds no sensitive attribute (ADR-0007): the engine reads work
--   authorisation, preferences, certifications and languages only.

-- CreateTable
CREATE TABLE "EligibilityResult" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "rules" TEXT NOT NULL DEFAULT '[]',
    "rulesVersion" TEXT NOT NULL,
    "profileVersion" TEXT NOT NULL DEFAULT '',
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EligibilityResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EligibilityResult_userId_outcome_idx" ON "EligibilityResult"("userId", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "EligibilityResult_userId_jobId_key" ON "EligibilityResult"("userId", "jobId");

-- AddForeignKey
ALTER TABLE "EligibilityResult" ADD CONSTRAINT "EligibilityResult_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EligibilityResult" ADD CONSTRAINT "EligibilityResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

