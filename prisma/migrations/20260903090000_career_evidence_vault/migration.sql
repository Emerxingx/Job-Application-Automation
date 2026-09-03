-- CreateTable
CREATE TABLE "CareerEvidence" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profileId" TEXT,
    "kind" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "claim" TEXT NOT NULL,
    "facts" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedesId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CareerEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationQuestion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'other',
    "riskLevel" TEXT NOT NULL DEFAULT 'medium',
    "policy" TEXT NOT NULL DEFAULT 'REQUIRE_REVIEW',
    "answer" TEXT NOT NULL DEFAULT '',
    "evidenceIds" TEXT NOT NULL DEFAULT '[]',
    "answerUpdatedAt" TIMESTAMP(3),
    "lastConfirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRun" (
    "id" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "policyState" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "promptSlug" TEXT,
    "promptVersion" INTEGER,
    "inputRefs" TEXT NOT NULL DEFAULT '[]',
    "evidenceRefs" TEXT NOT NULL DEFAULT '[]',
    "outputRef" TEXT,
    "confidence" INTEGER,
    "claimsRejected" INTEGER NOT NULL DEFAULT 0,
    "humanOverride" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "error" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "modelProvider" TEXT NOT NULL DEFAULT 'anthropic',
    "targetModel" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "userPromptTemplate" TEXT,
    "requiredVariables" TEXT NOT NULL DEFAULT '[]',
    "modelParameters" TEXT NOT NULL DEFAULT '{}',
    "outputSchema" TEXT,
    "deploymentStatus" TEXT NOT NULL DEFAULT 'draft',
    "evaluationStatus" TEXT NOT NULL DEFAULT 'pending',
    "evaluationNote" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdByEmail" TEXT NOT NULL DEFAULT '',
    "approvedById" TEXT,
    "approvedByEmail" TEXT,
    "approvedAt" TIMESTAMP(3),
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CareerEvidence_userId_status_idx" ON "CareerEvidence"("userId", "status");

-- CreateIndex
CREATE INDEX "CareerEvidence_userId_sourceType_sourceId_idx" ON "CareerEvidence"("userId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "CareerEvidence_supersedesId_idx" ON "CareerEvidence"("supersedesId");

-- CreateIndex
CREATE INDEX "ApplicationQuestion_userId_category_idx" ON "ApplicationQuestion"("userId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationQuestion_userId_key_key" ON "ApplicationQuestion"("userId", "key");

-- CreateIndex
CREATE INDEX "AiRun_userId_createdAt_idx" ON "AiRun"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiRun_task_createdAt_idx" ON "AiRun"("task", "createdAt");

-- CreateIndex
CREATE INDEX "AiRun_organizationId_createdAt_idx" ON "AiRun"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "PromptVersion_slug_deploymentStatus_idx" ON "PromptVersion"("slug", "deploymentStatus");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_slug_version_key" ON "PromptVersion"("slug", "version");

-- AddForeignKey
ALTER TABLE "CareerEvidence" ADD CONSTRAINT "CareerEvidence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareerEvidence" ADD CONSTRAINT "CareerEvidence_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "CareerEvidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationQuestion" ADD CONSTRAINT "ApplicationQuestion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Classification (DATA_CLASSIFICATION.md).
-- ---------------------------------------------------------------------------
COMMENT ON TABLE "CareerEvidence"      IS 'classification: CONFIDENTIAL';
COMMENT ON TABLE "ApplicationQuestion" IS 'classification: CONFIDENTIAL';
COMMENT ON TABLE "AiRun"               IS 'classification: CONFIDENTIAL — references only, never content';
COMMENT ON TABLE "PromptVersion"       IS 'classification: INTERNAL — security-relevant configuration, staff-administered (ADR-0019 Tier 1)';

-- ---------------------------------------------------------------------------
-- Baseline prompt versions, lifted verbatim from the code that used to
-- hard-code them (src/lib/providers/ai/anthropic.ts). They are APPROVED, not
-- DEFAULT: the governance rule (AI_GOVERNANCE.md) is that a version cannot be
-- default until its evaluation has passed, and no live-model evaluation has
-- been run (no provider credential reaches the build). Until an operator
-- records a passed evaluation and promotes a version, the gateway has no
-- external prompt for these tasks and routes them to the deterministic
-- engine — a fail-closed default, not a regression: the live path was never
-- validated (INTEGRATION_REGISTER.md).
--
-- Idempotent on (slug, version).
-- ---------------------------------------------------------------------------
INSERT INTO "PromptVersion" ("id", "slug", "version", "modelProvider", "targetModel", "systemPrompt", "userPromptTemplate", "requiredVariables", "modelParameters", "deploymentStatus", "evaluationStatus", "evaluationNote", "createdByEmail", "notes", "createdAt", "updatedAt")
VALUES
  ('prompt_analyze_match_v1', 'analyze-match', 1, 'anthropic', 'claude-opus-5',
   'You are an expert technical recruiter and ATS specialist for the Canadian and US job markets. You predict, honestly and without inflation, whether a candidate will clear automated resume screening and a recruiter review. You never invent experience the candidate does not have.',
   E'Score this candidate against the posting.\n\n## Posting\n{{job_block}}\n\n## Deterministic keyword analysis (grounding)\n{{grounding}}\n\n## Candidate resume (JSON)\n{{resume_json}}\n\nReturn a 0-100 match score, a breakdown by skills/experience/keywords/location/seniority (each 0-100), the matched and missing keywords, and a two-sentence rationale.',
   '["job_block","grounding","resume_json"]', '{"effort":"medium","max_tokens":4000}',
   'approved', 'pending', 'Baseline lifted from code on 2026-09-03; no live-model evaluation has been run.', 'system', 'Stage 03 seed.', now(), now()),
  ('prompt_tailor_v1', 'tailor', 1, 'anthropic', 'claude-opus-5',
   'You tailor resumes for specific job postings. Absolute rule: never fabricate employers, titles, dates, credentials, or accomplishments. You may only rephrase, reorder, and reframe what the candidate already has, and surface skills their experience genuinely demonstrates. Write in plain, ATS-parseable language with quantified impact where the source material supports it.',
   E'Tailor this resume and write a cover letter for the posting below.\n\n## Posting\n{{job_block}}\n\n## Gap analysis\n{{gap_analysis}}\n\n## Current resume (JSON)\n{{resume_json}}\n\nReturn: a rewritten summary targeting this role; a headline mirroring the posting title; the skills list reordered so posting-relevant skills lead; the two most recent roles with bullets reordered and rephrased for relevance (same facts, same companies, same titles); a cover letter of three to four paragraphs; a plain-language list of the changes you made; and an estimated ATS score 0-100 after tailoring.',
   '["job_block","gap_analysis","resume_json"]', '{"effort":"high","max_tokens":16000}',
   'approved', 'pending', 'Baseline lifted from code on 2026-09-03; no live-model evaluation has been run.', 'system', 'Stage 03 seed.', now(), now()),
  ('prompt_prepare_interview_v1', 'prepare-interview', 1, 'anthropic', 'claude-opus-5',
   'You are an interview coach. You produce specific, usable preparation material grounded in the candidate''s actual history — never generic advice. STAR stories must be drafted from the real roles and accomplishments provided.',
   E'Prepare this candidate for an interview for the posting below.\n\n## Posting\n{{job_block}}\n\n## Candidate resume (JSON)\n{{resume_json}}\n\nReturn 8-10 likely interview questions with suggested answers and tips (categories: behavioural, technical, situational, culture, closing), 3-4 STAR stories drawn ONLY from the roles and accomplishments in the resume, a short company research brief, and 5 questions the candidate should ask.',
   '["job_block","resume_json"]', '{"effort":"high","max_tokens":12000}',
   'approved', 'pending', 'Baseline lifted from code on 2026-09-03; no live-model evaluation has been run.', 'system', 'Stage 03 seed.', now(), now())
ON CONFLICT ("slug", "version") DO NOTHING;
