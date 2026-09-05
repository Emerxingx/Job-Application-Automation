-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "serviceRole" TEXT;

-- CreateTable
CREATE TABLE "RetentionPolicy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseNoteDays" INTEGER NOT NULL,
    "closedCaseDays" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "setById" TEXT NOT NULL,
    "setByEmail" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetentionPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientUserId" TEXT NOT NULL,
    "caseManagerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'invited',
    "consentedAt" TIMESTAMP(3),
    "consentRecordId" TEXT,
    "employmentGoal" TEXT NOT NULL DEFAULT '',
    "targetOccupationId" TEXT,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseNote" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorEmail" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseAssessment" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'intake',
    "summary" TEXT NOT NULL DEFAULT '',
    "barriers" TEXT NOT NULL DEFAULT '[]',
    "employmentGoal" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseTask" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'planned',
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "offeringId" TEXT,
    "recommendationId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseOutcome" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "employerName" TEXT NOT NULL DEFAULT '',
    "startDate" TIMESTAMP(3),
    "hoursPerWeek" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    "recordedById" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseFollowUp" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "outcomeId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseFollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseRecommendation" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '{}',
    "suggestedAction" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT NOT NULL DEFAULT '',
    "copilotVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RetentionPolicy_organizationId_key" ON "RetentionPolicy"("organizationId");

-- CreateIndex
CREATE INDEX "Case_organizationId_status_idx" ON "Case"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Case_caseManagerId_status_idx" ON "Case"("caseManagerId", "status");

-- CreateIndex
CREATE INDEX "Case_clientUserId_idx" ON "Case"("clientUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Case_organizationId_clientUserId_key" ON "Case"("organizationId", "clientUserId");

-- CreateIndex
CREATE INDEX "CaseNote_caseId_createdAt_idx" ON "CaseNote"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "CaseNote_organizationId_createdAt_idx" ON "CaseNote"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "CaseAssessment_caseId_createdAt_idx" ON "CaseAssessment"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "CaseAssessment_organizationId_idx" ON "CaseAssessment"("organizationId");

-- CreateIndex
CREATE INDEX "CaseTask_caseId_status_idx" ON "CaseTask"("caseId", "status");

-- CreateIndex
CREATE INDEX "CaseTask_organizationId_status_idx" ON "CaseTask"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CaseOutcome_caseId_recordedAt_idx" ON "CaseOutcome"("caseId", "recordedAt");

-- CreateIndex
CREATE INDEX "CaseOutcome_organizationId_kind_idx" ON "CaseOutcome"("organizationId", "kind");

-- CreateIndex
CREATE INDEX "CaseFollowUp_caseId_dueAt_idx" ON "CaseFollowUp"("caseId", "dueAt");

-- CreateIndex
CREATE INDEX "CaseFollowUp_organizationId_status_dueAt_idx" ON "CaseFollowUp"("organizationId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "CaseRecommendation_caseId_status_idx" ON "CaseRecommendation"("caseId", "status");

-- CreateIndex
CREATE INDEX "CaseRecommendation_organizationId_status_idx" ON "CaseRecommendation"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "RetentionPolicy" ADD CONSTRAINT "RetentionPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_clientUserId_fkey" FOREIGN KEY ("clientUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_caseManagerId_fkey" FOREIGN KEY ("caseManagerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseNote" ADD CONSTRAINT "CaseNote_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseAssessment" ADD CONSTRAINT "CaseAssessment_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseTask" ADD CONSTRAINT "CaseTask_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseTask" ADD CONSTRAINT "CaseTask_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "LearningOffering"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseOutcome" ADD CONSTRAINT "CaseOutcome_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFollowUp" ADD CONSTRAINT "CaseFollowUp_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFollowUp" ADD CONSTRAINT "CaseFollowUp_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "CaseOutcome"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseRecommendation" ADD CONSTRAINT "CaseRecommendation_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

