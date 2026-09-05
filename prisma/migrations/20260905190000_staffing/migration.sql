-- CreateTable
CREATE TABLE "StaffingJurisdictionRule" (
    "id" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unrecorded',
    "licenceRequired" BOOLEAN,
    "candidateFeesProhibited" BOOLEAN,
    "maxGuaranteeDays" INTEGER,
    "reference" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "recordedByEmail" TEXT NOT NULL DEFAULT '',
    "recordedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffingJurisdictionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientContract" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "clientContactEmail" TEXT NOT NULL DEFAULT '',
    "jurisdiction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "terms" TEXT NOT NULL DEFAULT '',
    "agencyLicenceRef" TEXT NOT NULL DEFAULT '',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeStructure" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contractId" TEXT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "percentBps" INTEGER,
    "flatCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "guaranteeDays" INTEGER NOT NULL DEFAULT 90,
    "paidBy" TEXT NOT NULL DEFAULT 'client',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeeStructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Engagement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "feeStructureId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "jurisdiction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "ownerRecruiterId" TEXT,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Engagement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepresentationConsent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "invitedEmail" TEXT NOT NULL,
    "invitedName" TEXT NOT NULL DEFAULT '',
    "candidateUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "message" TEXT NOT NULL DEFAULT '',
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "consentRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepresentationConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Placement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "candidateUserId" TEXT NOT NULL,
    "representationConsentId" TEXT NOT NULL,
    "recruiterId" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "salaryCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "feeCents" INTEGER NOT NULL,
    "guaranteeDays" INTEGER NOT NULL,
    "guaranteeEndsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fellOffAt" TIMESTAMP(3),
    "fellOffReason" TEXT NOT NULL DEFAULT '',
    "jurisdictionCheck" TEXT NOT NULL DEFAULT '{}',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Placement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlacementInvoice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "placementId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "creditedCents" INTEGER NOT NULL DEFAULT 0,
    "creditReason" TEXT NOT NULL DEFAULT '',
    "issuedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlacementInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffingJurisdictionRule_jurisdiction_key" ON "StaffingJurisdictionRule"("jurisdiction");

-- CreateIndex
CREATE INDEX "ClientContract_organizationId_status_idx" ON "ClientContract"("organizationId", "status");

-- CreateIndex
CREATE INDEX "FeeStructure_organizationId_idx" ON "FeeStructure"("organizationId");

-- CreateIndex
CREATE INDEX "Engagement_organizationId_status_idx" ON "Engagement"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Engagement_ownerRecruiterId_idx" ON "Engagement"("ownerRecruiterId");

-- CreateIndex
CREATE INDEX "RepresentationConsent_candidateUserId_status_idx" ON "RepresentationConsent"("candidateUserId", "status");

-- CreateIndex
CREATE INDEX "RepresentationConsent_organizationId_status_idx" ON "RepresentationConsent"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RepresentationConsent_engagementId_invitedEmail_key" ON "RepresentationConsent"("engagementId", "invitedEmail");

-- CreateIndex
CREATE INDEX "Placement_organizationId_status_idx" ON "Placement"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Placement_engagementId_idx" ON "Placement"("engagementId");

-- CreateIndex
CREATE INDEX "Placement_candidateUserId_idx" ON "Placement"("candidateUserId");

-- CreateIndex
CREATE UNIQUE INDEX "PlacementInvoice_number_key" ON "PlacementInvoice"("number");

-- CreateIndex
CREATE INDEX "PlacementInvoice_organizationId_status_idx" ON "PlacementInvoice"("organizationId", "status");

-- CreateIndex
CREATE INDEX "PlacementInvoice_placementId_idx" ON "PlacementInvoice"("placementId");

-- AddForeignKey
ALTER TABLE "ClientContract" ADD CONSTRAINT "ClientContract_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeStructure" ADD CONSTRAINT "FeeStructure_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeStructure" ADD CONSTRAINT "FeeStructure_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "ClientContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Engagement" ADD CONSTRAINT "Engagement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Engagement" ADD CONSTRAINT "Engagement_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "ClientContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Engagement" ADD CONSTRAINT "Engagement_feeStructureId_fkey" FOREIGN KEY ("feeStructureId") REFERENCES "FeeStructure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepresentationConsent" ADD CONSTRAINT "RepresentationConsent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepresentationConsent" ADD CONSTRAINT "RepresentationConsent_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepresentationConsent" ADD CONSTRAINT "RepresentationConsent_candidateUserId_fkey" FOREIGN KEY ("candidateUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Placement" ADD CONSTRAINT "Placement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Placement" ADD CONSTRAINT "Placement_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Placement" ADD CONSTRAINT "Placement_candidateUserId_fkey" FOREIGN KEY ("candidateUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Placement" ADD CONSTRAINT "Placement_representationConsentId_fkey" FOREIGN KEY ("representationConsentId") REFERENCES "RepresentationConsent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlacementInvoice" ADD CONSTRAINT "PlacementInvoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlacementInvoice" ADD CONSTRAINT "PlacementInvoice_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "Placement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlacementInvoice" ADD CONSTRAINT "PlacementInvoice_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "ClientContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

