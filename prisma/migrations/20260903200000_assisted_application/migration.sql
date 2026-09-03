-- Stage 12 (ADR-0016, ADR-0026): the applicant's application mode (User.applicationMode;
-- approved_auto_apply is refused by code and never stored), the prepared question set,
-- the mode and the exact field-mapping register version an application was prepared
-- under, whether the employer's ATS accepts an instructed submission, and the governed
-- FieldMappingVersion register (out of the content CMS). Additive; every column defaulted.
-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "applicationMode" TEXT NOT NULL DEFAULT 'review_submit',
ADD COLUMN     "atsSubmittable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fieldMappingVersion" TEXT NOT NULL DEFAULT 'builtin:1',
ADD COLUMN     "preparedQuestions" TEXT NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "applicationMode" TEXT NOT NULL DEFAULT 'review_submit';

-- CreateTable
CREATE TABLE "FieldMappingVersion" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "mappings" TEXT NOT NULL DEFAULT '[]',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdByEmail" TEXT NOT NULL DEFAULT '',
    "approvedById" TEXT,
    "approvedByEmail" TEXT,
    "approvedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FieldMappingVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FieldMappingVersion_version_key" ON "FieldMappingVersion"("version");

-- CreateIndex
CREATE INDEX "FieldMappingVersion_status_idx" ON "FieldMappingVersion"("status");

