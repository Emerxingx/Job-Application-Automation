-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "occupationId" TEXT,
ADD COLUMN     "occupationSource" TEXT;

-- CreateTable
CREATE TABLE "TaxonomyDataset" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "scheme" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL DEFAULT '',
    "licenceName" TEXT NOT NULL DEFAULT '',
    "licenceUrl" TEXT NOT NULL DEFAULT '',
    "attribution" TEXT NOT NULL DEFAULT '',
    "licenceStatus" TEXT NOT NULL DEFAULT 'unrecorded',
    "licenceRecordedAt" TIMESTAMP(3),
    "licenceRecordedById" TEXT,
    "licenceRecordedByEmail" TEXT,
    "ingestionApproved" BOOLEAN NOT NULL DEFAULT false,
    "ingestedAt" TIMESTAMP(3),
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxonomyDataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Occupation" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "parentId" TEXT,
    "datasetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Occupation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OccupationLabel" (
    "id" TEXT NOT NULL,
    "occupationId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "alternateTitles" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OccupationLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OccupationCode" (
    "id" TEXT NOT NULL,
    "occupationId" TEXT NOT NULL,
    "scheme" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "teer" INTEGER,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OccupationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillLabel" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkillLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillMapping" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "scheme" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OccupationSkill" (
    "id" TEXT NOT NULL,
    "occupationId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "importance" INTEGER,
    "level" TEXT,
    "source" TEXT NOT NULL,
    "datasetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OccupationSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CareerPath" (
    "id" TEXT NOT NULL,
    "fromOccupationId" TEXT NOT NULL,
    "toOccupationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL DEFAULT 'CA',
    "source" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CareerPath_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegionLabel" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "RegionLabel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaxonomyDataset_key_key" ON "TaxonomyDataset"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Occupation_slug_key" ON "Occupation"("slug");

-- CreateIndex
CREATE INDEX "Occupation_parentId_idx" ON "Occupation"("parentId");

-- CreateIndex
CREATE INDEX "Occupation_level_idx" ON "Occupation"("level");

-- CreateIndex
CREATE INDEX "OccupationLabel_locale_title_idx" ON "OccupationLabel"("locale", "title");

-- CreateIndex
CREATE UNIQUE INDEX "OccupationLabel_occupationId_locale_key" ON "OccupationLabel"("occupationId", "locale");

-- CreateIndex
CREATE INDEX "OccupationCode_scheme_code_idx" ON "OccupationCode"("scheme", "code");

-- CreateIndex
CREATE INDEX "OccupationCode_occupationId_idx" ON "OccupationCode"("occupationId");

-- CreateIndex
CREATE UNIQUE INDEX "OccupationCode_scheme_version_code_occupationId_key" ON "OccupationCode"("scheme", "version", "code", "occupationId");

-- CreateIndex
CREATE UNIQUE INDEX "SkillLabel_skillId_locale_key" ON "SkillLabel"("skillId", "locale");

-- CreateIndex
CREATE INDEX "SkillMapping_skillId_idx" ON "SkillMapping"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "SkillMapping_scheme_version_code_skillId_key" ON "SkillMapping"("scheme", "version", "code", "skillId");

-- CreateIndex
CREATE INDEX "OccupationSkill_skillId_idx" ON "OccupationSkill"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "OccupationSkill_occupationId_skillId_key" ON "OccupationSkill"("occupationId", "skillId");

-- CreateIndex
CREATE INDEX "CareerPath_toOccupationId_idx" ON "CareerPath"("toOccupationId");

-- CreateIndex
CREATE UNIQUE INDEX "CareerPath_fromOccupationId_toOccupationId_kind_key" ON "CareerPath"("fromOccupationId", "toOccupationId", "kind");

-- CreateIndex
CREATE INDEX "Region_parentId_idx" ON "Region"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Region_country_level_code_key" ON "Region"("country", "level", "code");

-- CreateIndex
CREATE UNIQUE INDEX "RegionLabel_regionId_locale_key" ON "RegionLabel"("regionId", "locale");

-- CreateIndex
CREATE INDEX "Job_occupationId_idx" ON "Job"("occupationId");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_occupationId_fkey" FOREIGN KEY ("occupationId") REFERENCES "Occupation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Occupation" ADD CONSTRAINT "Occupation_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Occupation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Occupation" ADD CONSTRAINT "Occupation_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "TaxonomyDataset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OccupationLabel" ADD CONSTRAINT "OccupationLabel_occupationId_fkey" FOREIGN KEY ("occupationId") REFERENCES "Occupation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OccupationCode" ADD CONSTRAINT "OccupationCode_occupationId_fkey" FOREIGN KEY ("occupationId") REFERENCES "Occupation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillLabel" ADD CONSTRAINT "SkillLabel_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillMapping" ADD CONSTRAINT "SkillMapping_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OccupationSkill" ADD CONSTRAINT "OccupationSkill_occupationId_fkey" FOREIGN KEY ("occupationId") REFERENCES "Occupation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OccupationSkill" ADD CONSTRAINT "OccupationSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OccupationSkill" ADD CONSTRAINT "OccupationSkill_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "TaxonomyDataset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareerPath" ADD CONSTRAINT "CareerPath_fromOccupationId_fkey" FOREIGN KEY ("fromOccupationId") REFERENCES "Occupation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareerPath" ADD CONSTRAINT "CareerPath_toOccupationId_fkey" FOREIGN KEY ("toOccupationId") REFERENCES "Occupation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Region" ADD CONSTRAINT "Region_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegionLabel" ADD CONSTRAINT "RegionLabel_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- Classification (DATA_CLASSIFICATION.md). The occupational spine is shared
-- reference data: no personal data, readable by every tenant, written only by
-- the licence-gated ingestion path (ADR-0009, SOURCE_ACCESS_POLICY.md).
-- ---------------------------------------------------------------------------
COMMENT ON TABLE "TaxonomyDataset" IS 'classification: INTERNAL — licence record per dataset; the L-2 ingestion gate';
COMMENT ON TABLE "Occupation"      IS 'classification: INTERNAL — canonical occupation; jurisdiction codes attached';
COMMENT ON TABLE "OccupationLabel" IS 'classification: INTERNAL — bilingual labels';
COMMENT ON TABLE "OccupationCode"  IS 'classification: INTERNAL — NOC/TEER, SOC codes per version';
COMMENT ON TABLE "SkillLabel"      IS 'classification: INTERNAL — bilingual skill labels';
COMMENT ON TABLE "SkillMapping"    IS 'classification: INTERNAL — external scheme codes where licensed';
COMMENT ON TABLE "OccupationSkill" IS 'classification: INTERNAL — occupation ↔ skill links with source';
COMMENT ON TABLE "CareerPath"      IS 'classification: INTERNAL — occupation transitions with source';
COMMENT ON TABLE "Region"          IS 'classification: INTERNAL — geography tree, CA and US';
COMMENT ON TABLE "RegionLabel"     IS 'classification: INTERNAL — bilingual region names';
COMMENT ON COLUMN "Job"."occupationId"     IS 'Stage 04: canonical occupation the posting was classified to';
COMMENT ON COLUMN "Job"."occupationSource" IS 'Stage 04: classification method — confidence recorded, never implied (ADR-0009)';
