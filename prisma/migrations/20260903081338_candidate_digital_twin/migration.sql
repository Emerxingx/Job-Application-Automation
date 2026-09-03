-- CreateTable
CREATE TABLE "CandidateProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "headline" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL DEFAULT '',
    "currentTitle" TEXT,
    "yearsExperience" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'editor',
    "backfilledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmploymentHistory" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "employmentType" TEXT,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL DEFAULT '',
    "bullets" TEXT NOT NULL DEFAULT '[]',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmploymentHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Education" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "credential" TEXT NOT NULL,
    "fieldOfStudy" TEXT,
    "level" TEXT,
    "startYear" INTEGER,
    "endYear" INTEGER,
    "location" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Education_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "category" TEXT,
    "taxonomyCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateSkill" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "skillId" TEXT,
    "proficiency" TEXT,
    "yearsUsed" INTEGER,
    "lastUsedYear" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'self',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Certification" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "issuer" TEXT,
    "issuedAt" TEXT,
    "expiresAt" TEXT,
    "credentialId" TEXT,
    "credentialUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Certification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "url" TEXT,
    "startDate" TEXT,
    "endDate" TEXT,
    "technologies" TEXT NOT NULL DEFAULT '[]',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Achievement" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "employmentId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "metric" TEXT,
    "occurredAt" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Achievement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateLanguage" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "proficiency" TEXT NOT NULL DEFAULT 'professional',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateLanguage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CareerPreferences" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetTitles" TEXT NOT NULL DEFAULT '[]',
    "adjacentTitles" TEXT NOT NULL DEFAULT '[]',
    "employmentTypes" TEXT NOT NULL DEFAULT '[]',
    "workModes" TEXT NOT NULL DEFAULT '[]',
    "locations" TEXT NOT NULL DEFAULT '[]',
    "countries" TEXT NOT NULL DEFAULT '[]',
    "salaryMinCents" INTEGER,
    "salaryCurrency" TEXT NOT NULL DEFAULT 'CAD',
    "travelPercentMax" INTEGER,
    "relocation" TEXT NOT NULL DEFAULT 'no',
    "recruiterVisibility" TEXT NOT NULL DEFAULT 'hidden',
    "autonomy" TEXT NOT NULL DEFAULT 'assist_only',
    "noticePeriodDays" INTEGER,
    "availableFrom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CareerPreferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkAuthorization" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'CA',
    "status" TEXT NOT NULL DEFAULT 'unspecified',
    "permitType" TEXT,
    "permitExpiresAt" TEXT,
    "sponsorshipNeeded" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT NOT NULL DEFAULT '',
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CandidateProfile_userId_key" ON "CandidateProfile"("userId");

-- CreateIndex
CREATE INDEX "EmploymentHistory_userId_sortOrder_idx" ON "EmploymentHistory"("userId", "sortOrder");

-- CreateIndex
CREATE INDEX "EmploymentHistory_profileId_idx" ON "EmploymentHistory"("profileId");

-- CreateIndex
CREATE INDEX "Education_userId_sortOrder_idx" ON "Education"("userId", "sortOrder");

-- CreateIndex
CREATE INDEX "Education_profileId_idx" ON "Education"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_normalizedName_key" ON "Skill"("normalizedName");

-- CreateIndex
CREATE INDEX "Skill_taxonomyCode_idx" ON "Skill"("taxonomyCode");

-- CreateIndex
CREATE INDEX "CandidateSkill_userId_idx" ON "CandidateSkill"("userId");

-- CreateIndex
CREATE INDEX "CandidateSkill_skillId_idx" ON "CandidateSkill"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateSkill_profileId_normalizedName_key" ON "CandidateSkill"("profileId", "normalizedName");

-- CreateIndex
CREATE INDEX "Certification_userId_sortOrder_idx" ON "Certification"("userId", "sortOrder");

-- CreateIndex
CREATE INDEX "Certification_profileId_idx" ON "Certification"("profileId");

-- CreateIndex
CREATE INDEX "Project_userId_sortOrder_idx" ON "Project"("userId", "sortOrder");

-- CreateIndex
CREATE INDEX "Project_profileId_idx" ON "Project"("profileId");

-- CreateIndex
CREATE INDEX "Achievement_userId_sortOrder_idx" ON "Achievement"("userId", "sortOrder");

-- CreateIndex
CREATE INDEX "Achievement_profileId_idx" ON "Achievement"("profileId");

-- CreateIndex
CREATE INDEX "Achievement_employmentId_idx" ON "Achievement"("employmentId");

-- CreateIndex
CREATE INDEX "CandidateLanguage_userId_idx" ON "CandidateLanguage"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateLanguage_profileId_language_key" ON "CandidateLanguage"("profileId", "language");

-- CreateIndex
CREATE UNIQUE INDEX "CareerPreferences_profileId_key" ON "CareerPreferences"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "CareerPreferences_userId_key" ON "CareerPreferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkAuthorization_profileId_key" ON "WorkAuthorization"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkAuthorization_userId_key" ON "WorkAuthorization"("userId");

-- AddForeignKey
ALTER TABLE "CandidateProfile" ADD CONSTRAINT "CandidateProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmploymentHistory" ADD CONSTRAINT "EmploymentHistory_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Education" ADD CONSTRAINT "Education_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateSkill" ADD CONSTRAINT "CandidateSkill_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateSkill" ADD CONSTRAINT "CandidateSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certification" ADD CONSTRAINT "Certification_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Achievement" ADD CONSTRAINT "Achievement_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Achievement" ADD CONSTRAINT "Achievement_employmentId_fkey" FOREIGN KEY ("employmentId") REFERENCES "EmploymentHistory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateLanguage" ADD CONSTRAINT "CandidateLanguage_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareerPreferences" ADD CONSTRAINT "CareerPreferences_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkAuthorization" ADD CONSTRAINT "WorkAuthorization_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Classification (DATA_CLASSIFICATION.md): every new table declares its level.
-- ---------------------------------------------------------------------------
COMMENT ON TABLE "CandidateProfile"  IS 'classification: CONFIDENTIAL';
COMMENT ON TABLE "EmploymentHistory" IS 'classification: CONFIDENTIAL';
COMMENT ON TABLE "Education"         IS 'classification: CONFIDENTIAL';
COMMENT ON TABLE "Skill"             IS 'classification: INTERNAL';
COMMENT ON TABLE "CandidateSkill"    IS 'classification: CONFIDENTIAL';
COMMENT ON TABLE "Certification"     IS 'classification: CONFIDENTIAL';
COMMENT ON TABLE "Project"           IS 'classification: CONFIDENTIAL';
COMMENT ON TABLE "Achievement"       IS 'classification: CONFIDENTIAL';
COMMENT ON TABLE "CandidateLanguage" IS 'classification: CONFIDENTIAL';
COMMENT ON TABLE "CareerPreferences" IS 'classification: CONFIDENTIAL';
COMMENT ON TABLE "WorkAuthorization" IS 'classification: CONFIDENTIAL';

-- ---------------------------------------------------------------------------
-- Backfill (hand-written; reviewed): EXPAND phase of ADR-0002's expand-and-
-- contract. Each user's master résumé JSON becomes structured rows. The JSON
-- column is NOT dropped here — it is rewritten as a projection of these rows
-- by the profile service from now on, and removed in a later migration once
-- nothing reads it.
--
-- Idempotent: a user who already has a CandidateProfile is skipped, and every
-- id is derived from the user id, so re-running inserts nothing new. Tolerant:
-- unparseable JSON or an unexpected shape skips that user with a NOTICE rather
-- than failing the migration; the row-count report below is how the operator
-- sees what was skipped.
--
-- RECOVERY: additive only. Forward-fix is DELETE FROM "CandidateProfile"
-- WHERE source = 'resume_backfill' (children cascade) and re-run.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r      RECORD;
  c      jsonb;
  pid    text;
  e      jsonb;
  i      int;
  txt    text;
  n_profiles int := 0;
  n_skipped  int := 0;
  n_emp int := 0; n_edu int := 0; n_skill int := 0; n_cert int := 0; n_proj int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (res."userId") res."userId", res."content"
      FROM "Resume" res
     WHERE res."isMaster" = true
     ORDER BY res."userId", res."updatedAt" DESC
  LOOP
    IF EXISTS (SELECT 1 FROM "CandidateProfile" p WHERE p."userId" = r."userId") THEN
      CONTINUE;
    END IF;
    BEGIN
      c := r."content"::jsonb;
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'digital-twin backfill: user % has unparseable resume JSON; skipped', r."userId";
      n_skipped := n_skipped + 1;
      CONTINUE;
    END;
    IF c IS NULL OR jsonb_typeof(c) <> 'object' THEN
      n_skipped := n_skipped + 1;
      CONTINUE;
    END IF;

    pid := 'cp_' || r."userId";
    INSERT INTO "CandidateProfile" ("id", "userId", "headline", "summary", "source", "backfilledAt", "createdAt", "updatedAt")
    VALUES (pid, r."userId", coalesce(c->>'headline', ''), coalesce(c->>'summary', ''), 'resume_backfill', now(), now(), now());
    n_profiles := n_profiles + 1;

    -- Employment: objects with company/title/startDate/endDate/bullets.
    i := 0;
    IF jsonb_typeof(c->'experience') = 'array' THEN
      FOR e IN SELECT value FROM jsonb_array_elements(c->'experience') LOOP
        IF jsonb_typeof(e) = 'object' THEN
          INSERT INTO "EmploymentHistory" ("id", "profileId", "userId", "company", "title", "location", "startDate", "endDate", "isCurrent", "description", "bullets", "sortOrder", "createdAt", "updatedAt")
          VALUES (
            pid || '_emp_' || i, pid, r."userId",
            coalesce(e->>'company', ''), coalesce(e->>'title', ''), nullif(e->>'location', ''),
            coalesce(e->>'startDate', ''),
            CASE WHEN lower(coalesce(e->>'endDate', '')) IN ('', 'present', 'current') THEN NULL ELSE e->>'endDate' END,
            lower(coalesce(e->>'endDate', '')) IN ('', 'present', 'current'),
            '',
            CASE WHEN jsonb_typeof(e->'bullets') = 'array' THEN (e->'bullets')::text ELSE '[]' END,
            i, now(), now());
          n_emp := n_emp + 1;
          i := i + 1;
        END IF;
      END LOOP;
    END IF;

    -- Education: objects with institution/credential/year/location.
    i := 0;
    IF jsonb_typeof(c->'education') = 'array' THEN
      FOR e IN SELECT value FROM jsonb_array_elements(c->'education') LOOP
        IF jsonb_typeof(e) = 'object' THEN
          INSERT INTO "Education" ("id", "profileId", "userId", "institution", "credential", "endYear", "location", "sortOrder", "createdAt", "updatedAt")
          VALUES (
            pid || '_edu_' || i, pid, r."userId",
            coalesce(e->>'institution', ''), coalesce(e->>'credential', ''),
            CASE WHEN coalesce(e->>'year', '') ~ '^[0-9]{4}$' THEN (e->>'year')::int ELSE NULL END,
            nullif(e->>'location', ''), i, now(), now());
          n_edu := n_edu + 1;
          i := i + 1;
        END IF;
      END LOOP;
    END IF;

    -- Skills: strings, de-duplicated on the normalised form.
    i := 0;
    IF jsonb_typeof(c->'skills') = 'array' THEN
      FOR e IN SELECT value FROM jsonb_array_elements(c->'skills') LOOP
        IF jsonb_typeof(e) = 'string' AND btrim(e #>> '{}') <> '' THEN
          txt := btrim(e #>> '{}');
          INSERT INTO "CandidateSkill" ("id", "profileId", "userId", "name", "normalizedName", "source", "sortOrder", "createdAt", "updatedAt")
          VALUES (pid || '_skill_' || i, pid, r."userId", txt, lower(regexp_replace(txt, '\s+', ' ', 'g')), 'self', i, now(), now())
          ON CONFLICT ("profileId", "normalizedName") DO NOTHING;
          n_skill := n_skill + 1;
          i := i + 1;
        END IF;
      END LOOP;
    END IF;

    -- Certifications: strings (name only in the old shape).
    i := 0;
    IF jsonb_typeof(c->'certifications') = 'array' THEN
      FOR e IN SELECT value FROM jsonb_array_elements(c->'certifications') LOOP
        IF jsonb_typeof(e) = 'string' AND btrim(e #>> '{}') <> '' THEN
          INSERT INTO "Certification" ("id", "profileId", "userId", "name", "sortOrder", "createdAt", "updatedAt")
          VALUES (pid || '_cert_' || i, pid, r."userId", btrim(e #>> '{}'), i, now(), now());
          n_cert := n_cert + 1;
          i := i + 1;
        END IF;
      END LOOP;
    END IF;

    -- Projects: objects with name/description.
    i := 0;
    IF jsonb_typeof(c->'projects') = 'array' THEN
      FOR e IN SELECT value FROM jsonb_array_elements(c->'projects') LOOP
        IF jsonb_typeof(e) = 'object' AND coalesce(e->>'name', '') <> '' THEN
          INSERT INTO "Project" ("id", "profileId", "userId", "name", "description", "sortOrder", "createdAt", "updatedAt")
          VALUES (pid || '_proj_' || i, pid, r."userId", e->>'name', coalesce(e->>'description', ''), i, now(), now());
          n_proj := n_proj + 1;
          i := i + 1;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  -- The row-count report ADR-0002 asks for, in the migration output.
  RAISE NOTICE 'digital-twin backfill: profiles=% skipped=% employment=% education=% skills=% certifications=% projects=%',
    n_profiles, n_skipped, n_emp, n_edu, n_skill, n_cert, n_proj;
END $$;
