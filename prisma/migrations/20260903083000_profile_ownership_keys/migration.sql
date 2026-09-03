-- DropForeignKey
ALTER TABLE "Achievement" DROP CONSTRAINT "Achievement_profileId_fkey";

-- DropForeignKey
ALTER TABLE "CandidateLanguage" DROP CONSTRAINT "CandidateLanguage_profileId_fkey";

-- DropForeignKey
ALTER TABLE "CandidateSkill" DROP CONSTRAINT "CandidateSkill_profileId_fkey";

-- DropForeignKey
ALTER TABLE "CareerPreferences" DROP CONSTRAINT "CareerPreferences_profileId_fkey";

-- DropForeignKey
ALTER TABLE "Certification" DROP CONSTRAINT "Certification_profileId_fkey";

-- DropForeignKey
ALTER TABLE "Education" DROP CONSTRAINT "Education_profileId_fkey";

-- DropForeignKey
ALTER TABLE "EmploymentHistory" DROP CONSTRAINT "EmploymentHistory_profileId_fkey";

-- DropForeignKey
ALTER TABLE "Project" DROP CONSTRAINT "Project_profileId_fkey";

-- DropForeignKey
ALTER TABLE "WorkAuthorization" DROP CONSTRAINT "WorkAuthorization_profileId_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "CandidateProfile_id_userId_key" ON "CandidateProfile"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CareerPreferences_profileId_userId_key" ON "CareerPreferences"("profileId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkAuthorization_profileId_userId_key" ON "WorkAuthorization"("profileId", "userId");

-- AddForeignKey
ALTER TABLE "EmploymentHistory" ADD CONSTRAINT "EmploymentHistory_profileId_userId_fkey" FOREIGN KEY ("profileId", "userId") REFERENCES "CandidateProfile"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Education" ADD CONSTRAINT "Education_profileId_userId_fkey" FOREIGN KEY ("profileId", "userId") REFERENCES "CandidateProfile"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateSkill" ADD CONSTRAINT "CandidateSkill_profileId_userId_fkey" FOREIGN KEY ("profileId", "userId") REFERENCES "CandidateProfile"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certification" ADD CONSTRAINT "Certification_profileId_userId_fkey" FOREIGN KEY ("profileId", "userId") REFERENCES "CandidateProfile"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_profileId_userId_fkey" FOREIGN KEY ("profileId", "userId") REFERENCES "CandidateProfile"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Achievement" ADD CONSTRAINT "Achievement_profileId_userId_fkey" FOREIGN KEY ("profileId", "userId") REFERENCES "CandidateProfile"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateLanguage" ADD CONSTRAINT "CandidateLanguage_profileId_userId_fkey" FOREIGN KEY ("profileId", "userId") REFERENCES "CandidateProfile"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareerPreferences" ADD CONSTRAINT "CareerPreferences_profileId_userId_fkey" FOREIGN KEY ("profileId", "userId") REFERENCES "CandidateProfile"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkAuthorization" ADD CONSTRAINT "WorkAuthorization_profileId_userId_fkey" FOREIGN KEY ("profileId", "userId") REFERENCES "CandidateProfile"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

