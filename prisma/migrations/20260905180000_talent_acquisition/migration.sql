-- CreateTable
CREATE TABLE "Requisition" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "department" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'CA',
    "workMode" TEXT NOT NULL DEFAULT 'onsite',
    "jobType" TEXT NOT NULL DEFAULT 'full_time',
    "description" TEXT NOT NULL DEFAULT '',
    "requiredSkills" TEXT NOT NULL DEFAULT '[]',
    "preferredSkills" TEXT NOT NULL DEFAULT '[]',
    "certificationRequirements" TEXT NOT NULL DEFAULT '[]',
    "experienceYearsMin" INTEGER,
    "salaryMin" INTEGER,
    "salaryMax" INTEGER,
    "salaryCurrency" TEXT NOT NULL DEFAULT 'CAD',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "hiringManagerId" TEXT,
    "recruiterId" TEXT,
    "jobId" TEXT,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Requisition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Disclosure" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "candidateUserId" TEXT NOT NULL,
    "requisitionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "message" TEXT NOT NULL DEFAULT '',
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "consentRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Disclosure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TalentPool" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TalentPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TalentPoolMember" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "candidateUserId" TEXT NOT NULL,
    "disclosureId" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TalentPoolMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requisitionId" TEXT NOT NULL,
    "candidateUserId" TEXT NOT NULL,
    "disclosureId" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'sourced',
    "source" TEXT NOT NULL DEFAULT 'sourced',
    "matchScore" INTEGER,
    "matchBreakdown" TEXT NOT NULL DEFAULT '{}',
    "weightVersion" TEXT NOT NULL DEFAULT '',
    "pipelineVersion" TEXT NOT NULL DEFAULT '',
    "ownerId" TEXT,
    "rejectedReason" TEXT NOT NULL DEFAULT '',
    "hiredAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionEvent" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fromStage" TEXT NOT NULL,
    "toStage" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubmissionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployerInterview" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "requisitionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'screen',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER,
    "interviewerIds" TEXT NOT NULL DEFAULT '[]',
    "outcome" TEXT NOT NULL DEFAULT 'scheduled',
    "feedback" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployerInterview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployerNote" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorEmail" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployerNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "requisitionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "salaryCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "startDate" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "extendedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Requisition_jobId_key" ON "Requisition"("jobId");

-- CreateIndex
CREATE INDEX "Requisition_organizationId_status_idx" ON "Requisition"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Requisition_hiringManagerId_idx" ON "Requisition"("hiringManagerId");

-- CreateIndex
CREATE INDEX "Requisition_recruiterId_idx" ON "Requisition"("recruiterId");

-- CreateIndex
CREATE INDEX "Disclosure_candidateUserId_status_idx" ON "Disclosure"("candidateUserId", "status");

-- CreateIndex
CREATE INDEX "Disclosure_organizationId_status_idx" ON "Disclosure"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Disclosure_organizationId_candidateUserId_key" ON "Disclosure"("organizationId", "candidateUserId");

-- CreateIndex
CREATE INDEX "TalentPool_organizationId_idx" ON "TalentPool"("organizationId");

-- CreateIndex
CREATE INDEX "TalentPoolMember_organizationId_idx" ON "TalentPoolMember"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "TalentPoolMember_poolId_candidateUserId_key" ON "TalentPoolMember"("poolId", "candidateUserId");

-- CreateIndex
CREATE INDEX "Submission_organizationId_stage_idx" ON "Submission"("organizationId", "stage");

-- CreateIndex
CREATE INDEX "Submission_candidateUserId_idx" ON "Submission"("candidateUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_requisitionId_candidateUserId_key" ON "Submission"("requisitionId", "candidateUserId");

-- CreateIndex
CREATE INDEX "SubmissionEvent_submissionId_at_idx" ON "SubmissionEvent"("submissionId", "at");

-- CreateIndex
CREATE INDEX "SubmissionEvent_organizationId_toStage_at_idx" ON "SubmissionEvent"("organizationId", "toStage", "at");

-- CreateIndex
CREATE INDEX "EmployerInterview_submissionId_scheduledAt_idx" ON "EmployerInterview"("submissionId", "scheduledAt");

-- CreateIndex
CREATE INDEX "EmployerInterview_organizationId_scheduledAt_idx" ON "EmployerInterview"("organizationId", "scheduledAt");

-- CreateIndex
CREATE INDEX "EmployerNote_submissionId_createdAt_idx" ON "EmployerNote"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "EmployerNote_organizationId_idx" ON "EmployerNote"("organizationId");

-- CreateIndex
CREATE INDEX "Offer_submissionId_status_idx" ON "Offer"("submissionId", "status");

-- CreateIndex
CREATE INDEX "Offer_organizationId_status_idx" ON "Offer"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "Requisition" ADD CONSTRAINT "Requisition_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Requisition" ADD CONSTRAINT "Requisition_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Disclosure" ADD CONSTRAINT "Disclosure_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Disclosure" ADD CONSTRAINT "Disclosure_candidateUserId_fkey" FOREIGN KEY ("candidateUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TalentPool" ADD CONSTRAINT "TalentPool_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TalentPoolMember" ADD CONSTRAINT "TalentPoolMember_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "TalentPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TalentPoolMember" ADD CONSTRAINT "TalentPoolMember_disclosureId_fkey" FOREIGN KEY ("disclosureId") REFERENCES "Disclosure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "Requisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_disclosureId_fkey" FOREIGN KEY ("disclosureId") REFERENCES "Disclosure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionEvent" ADD CONSTRAINT "SubmissionEvent_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployerInterview" ADD CONSTRAINT "EmployerInterview_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployerInterview" ADD CONSTRAINT "EmployerInterview_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "Requisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployerNote" ADD CONSTRAINT "EmployerNote_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "Requisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

