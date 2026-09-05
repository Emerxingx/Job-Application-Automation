-- Stage 16 (ADR-0031): the career transition, learning and credential graph.
-- Additive: eight new tables; nothing existing changes.
-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "issuerUrl" TEXT NOT NULL DEFAULT '',
    "jurisdiction" TEXT NOT NULL DEFAULT 'CA',
    "recognition" TEXT NOT NULL DEFAULT 'unverified',
    "regulated" BOOLEAN NOT NULL DEFAULT false,
    "validityMonths" INTEGER,
    "renewal" TEXT NOT NULL DEFAULT '',
    "spellings" TEXT NOT NULL DEFAULT '[]',
    "datasetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CredentialSkill" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "level" TEXT,
    "datasetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CredentialSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OccupationCredential" (
    "id" TEXT NOT NULL,
    "occupationId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "requirement" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL DEFAULT 'CA',
    "note" TEXT NOT NULL DEFAULT '',
    "datasetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OccupationCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningProvider" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'CA',
    "region" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL DEFAULT '',
    "datasetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearningProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningOffering" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "credentialId" TEXT,
    "title" TEXT NOT NULL,
    "deliveryMode" TEXT NOT NULL DEFAULT 'online',
    "durationHours" INTEGER,
    "durationWeeks" INTEGER,
    "costCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "prerequisites" TEXT NOT NULL DEFAULT '',
    "jurisdiction" TEXT NOT NULL DEFAULT 'CA',
    "url" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "datasetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearningOffering_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferingSkill" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "level" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfferingSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CareerPlan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "title" TEXT NOT NULL,
    "currentOccupationId" TEXT,
    "targetOccupationId" TEXT NOT NULL,
    "analysis" TEXT NOT NULL DEFAULT '{}',
    "engineVersion" TEXT NOT NULL,
    "supersedesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CareerPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CareerPlanMilestone" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "offeringId" TEXT,
    "credentialId" TEXT,
    "occupationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "evidenceId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CareerPlanMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Credential_slug_key" ON "Credential"("slug");

-- CreateIndex
CREATE INDEX "Credential_kind_idx" ON "Credential"("kind");

-- CreateIndex
CREATE INDEX "Credential_datasetId_idx" ON "Credential"("datasetId");

-- CreateIndex
CREATE INDEX "CredentialSkill_skillId_idx" ON "CredentialSkill"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "CredentialSkill_credentialId_skillId_key" ON "CredentialSkill"("credentialId", "skillId");

-- CreateIndex
CREATE INDEX "OccupationCredential_credentialId_idx" ON "OccupationCredential"("credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "OccupationCredential_occupationId_credentialId_jurisdiction_key" ON "OccupationCredential"("occupationId", "credentialId", "jurisdiction");

-- CreateIndex
CREATE UNIQUE INDEX "LearningProvider_slug_key" ON "LearningProvider"("slug");

-- CreateIndex
CREATE INDEX "LearningProvider_datasetId_idx" ON "LearningProvider"("datasetId");

-- CreateIndex
CREATE UNIQUE INDEX "LearningOffering_slug_key" ON "LearningOffering"("slug");

-- CreateIndex
CREATE INDEX "LearningOffering_providerId_idx" ON "LearningOffering"("providerId");

-- CreateIndex
CREATE INDEX "LearningOffering_credentialId_idx" ON "LearningOffering"("credentialId");

-- CreateIndex
CREATE INDEX "LearningOffering_datasetId_active_idx" ON "LearningOffering"("datasetId", "active");

-- CreateIndex
CREATE INDEX "OfferingSkill_skillId_idx" ON "OfferingSkill"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "OfferingSkill_offeringId_skillId_key" ON "OfferingSkill"("offeringId", "skillId");

-- CreateIndex
CREATE INDEX "CareerPlan_userId_status_createdAt_idx" ON "CareerPlan"("userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CareerPlan_targetOccupationId_idx" ON "CareerPlan"("targetOccupationId");

-- CreateIndex
CREATE INDEX "CareerPlanMilestone_userId_planId_sortOrder_idx" ON "CareerPlanMilestone"("userId", "planId", "sortOrder");

-- CreateIndex
CREATE INDEX "CareerPlanMilestone_planId_idx" ON "CareerPlanMilestone"("planId");

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "TaxonomyDataset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialSkill" ADD CONSTRAINT "CredentialSkill_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialSkill" ADD CONSTRAINT "CredentialSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OccupationCredential" ADD CONSTRAINT "OccupationCredential_occupationId_fkey" FOREIGN KEY ("occupationId") REFERENCES "Occupation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OccupationCredential" ADD CONSTRAINT "OccupationCredential_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningProvider" ADD CONSTRAINT "LearningProvider_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "TaxonomyDataset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningOffering" ADD CONSTRAINT "LearningOffering_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "LearningProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningOffering" ADD CONSTRAINT "LearningOffering_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningOffering" ADD CONSTRAINT "LearningOffering_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "TaxonomyDataset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferingSkill" ADD CONSTRAINT "OfferingSkill_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "LearningOffering"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferingSkill" ADD CONSTRAINT "OfferingSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareerPlan" ADD CONSTRAINT "CareerPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareerPlanMilestone" ADD CONSTRAINT "CareerPlanMilestone_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareerPlanMilestone" ADD CONSTRAINT "CareerPlanMilestone_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CareerPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareerPlanMilestone" ADD CONSTRAINT "CareerPlanMilestone_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "LearningOffering"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareerPlanMilestone" ADD CONSTRAINT "CareerPlanMilestone_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

