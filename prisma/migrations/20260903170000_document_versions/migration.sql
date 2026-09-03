-- CreateTable
CREATE TABLE "DocumentVersion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "applicationId" TEXT,
    "jobId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "contentHash" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "evidenceIds" TEXT NOT NULL DEFAULT '[]',
    "aiRunId" TEXT,
    "atsReport" TEXT NOT NULL DEFAULT '{}',
    "scanReport" TEXT NOT NULL DEFAULT '{}',
    "sealedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentVersion_userId_applicationId_idx" ON "DocumentVersion"("userId", "applicationId");

-- CreateIndex
CREATE INDEX "DocumentVersion_userId_createdAt_idx" ON "DocumentVersion"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_userId_scopeKey_kind_format_version_key" ON "DocumentVersion"("userId", "scopeKey", "kind", "format", "version");

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Stage 09 — a submitted document version is immutable (MASTER_BUILD_PLAN
-- Stage 09: "The exact submitted version is retained immutably").
--
-- The service layer (src/lib/documents/versions.ts) offers no way to change a
-- version at all; sealing sets status = 'submitted'. This trigger is the
-- independent, database-side form of the rule: once a row is submitted, an
-- UPDATE of ANY column raises, whatever issued it. A DELETE is refused when
-- it is direct (pg_trigger_depth() = 1: this trigger itself is the only
-- trigger on the stack) and allowed when it arrives through a referential
-- cascade (depth >= 2: the owner's User row — account erasure — or the
-- Application row was deleted), because a person's right to erasure outranks
-- our record-keeping and a sealed document has no meaning without its owner.
-- Idempotent (CREATE OR REPLACE / DROP IF EXISTS) so a shadow database replays
-- it cleanly, matching the evidence-immutability migration's posture.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.document_version_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'submitted' AND pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'DocumentVersion % is submitted and immutable; it cannot be deleted directly', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'submitted' THEN
    RAISE EXCEPTION 'DocumentVersion % is submitted and immutable', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS document_version_immutable_update ON "DocumentVersion";
CREATE TRIGGER document_version_immutable_update
  BEFORE UPDATE ON "DocumentVersion"
  FOR EACH ROW
  EXECUTE FUNCTION public.document_version_guard_immutable();

DROP TRIGGER IF EXISTS document_version_immutable_delete ON "DocumentVersion";
CREATE TRIGGER document_version_immutable_delete
  BEFORE DELETE ON "DocumentVersion"
  FOR EACH ROW
  EXECUTE FUNCTION public.document_version_guard_immutable();

COMMENT ON FUNCTION public.document_version_guard_immutable() IS 'Stage 09: a submitted document version is immutable; it leaves only with its owner (src/lib/documents/versions.ts).';
