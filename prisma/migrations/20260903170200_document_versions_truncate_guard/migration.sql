-- ---------------------------------------------------------------------------
-- Stage 09 review (LOW): row-level triggers do not fire on TRUNCATE, so a
-- TRUNCATE would remove sealed versions silently. No application code issues
-- one, and the owner role can; this statement-level trigger closes the gap
-- the same way the row guard does — a table holding a submitted version
-- cannot be truncated. Idempotent for the shadow database.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.document_version_guard_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DocumentVersion" WHERE status = 'submitted') THEN
    RAISE EXCEPTION 'DocumentVersion holds submitted, immutable versions and cannot be truncated'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS document_version_immutable_truncate ON "DocumentVersion";
CREATE TRIGGER document_version_immutable_truncate
  BEFORE TRUNCATE ON "DocumentVersion"
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.document_version_guard_truncate();
