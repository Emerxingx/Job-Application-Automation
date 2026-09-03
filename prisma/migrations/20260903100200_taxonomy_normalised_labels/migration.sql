-- AlterTable
ALTER TABLE "OccupationLabel" ADD COLUMN     "normalizedAlternates" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN     "normalizedTitle" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "TaxonomyDataset" ADD COLUMN     "publisherTerms" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "OccupationLabel_normalizedTitle_idx" ON "OccupationLabel"("normalizedTitle");

