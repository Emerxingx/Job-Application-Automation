-- ---------------------------------------------------------------------------
-- Stage 03 — approved evidence is immutable (MASTER_BUILD_PLAN Stage 03,
-- "Evidence is immutable once approved; edits create versions").
--
-- The service layer (src/lib/evidence/vault.ts) refuses to edit an approved
-- row and creates a new version instead. This trigger is the independent,
-- database-side form of the same rule: an UPDATE that would change the claim,
-- the facts, the kind, the source, the version or the lineage of a row that
-- is (or was) approved raises, whatever issued it — a service bug, a raw
-- query, a console. Status may still move forward (approved → superseded /
-- revoked) and the timestamps that record those moves may be set; nothing
-- else may change.
--
-- Idempotent (CREATE OR REPLACE / DROP IF EXISTS) so a fixed shadow database
-- replays it cleanly, matching the sensitive-schema migration's posture.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.career_evidence_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('approved', 'superseded', 'revoked') THEN
    IF NEW.claim IS DISTINCT FROM OLD.claim
       OR NEW.facts IS DISTINCT FROM OLD.facts
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW."sourceType" IS DISTINCT FROM OLD."sourceType"
       OR NEW."sourceId" IS DISTINCT FROM OLD."sourceId"
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW."supersedesId" IS DISTINCT FROM OLD."supersedesId"
       OR NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
    THEN
      RAISE EXCEPTION 'CareerEvidence % is % and immutable; create a new version instead', OLD.id, OLD.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- Status may only move forward: approved → superseded | revoked. A
    -- superseded or revoked row never comes back.
    IF OLD.status = 'approved' AND NEW.status NOT IN ('approved', 'superseded', 'revoked') THEN
      RAISE EXCEPTION 'CareerEvidence % cannot move from approved to %', OLD.id, NEW.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status IN ('superseded', 'revoked') AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'CareerEvidence % is % and cannot change status', OLD.id, OLD.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS career_evidence_immutable ON "CareerEvidence";
CREATE TRIGGER career_evidence_immutable
  BEFORE UPDATE ON "CareerEvidence"
  FOR EACH ROW
  EXECUTE FUNCTION public.career_evidence_guard_immutable();

COMMENT ON FUNCTION public.career_evidence_guard_immutable() IS 'Stage 03: approved evidence is immutable; corrections are new versions (src/lib/evidence/vault.ts).';
