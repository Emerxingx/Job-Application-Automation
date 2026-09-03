-- ---------------------------------------------------------------------------
-- ADR-0007 — the `sensitive` schema: demographic self-identification,
-- physically separated from everything a matching, scoring, ranking,
-- recommendation or document-generation path can touch.
--
-- HAND-WRITTEN AND OUTSIDE PRISMA ON PURPOSE. There is no Prisma model for this
-- table. The Prisma client therefore has no way to select it, join it, include
-- it or serialise it; the only reader is src/lib/sensitive/*, which reaches it
-- with raw SQL inside a transaction that has assumed the `app_sensitive` role.
-- The tenant role (`app_tenant`) and the matching path never hold a privilege
-- on this schema, so inclusion is a runtime permission error, not a silent
-- leak. Prisma's drift check diffs only the `public` schema and ignores this.
--
-- Classification: RESTRICTED (DATA_CLASSIFICATION.md).
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS sensitive;
COMMENT ON SCHEMA sensitive IS 'classification: RESTRICTED — ADR-0007; no Prisma model; readable only through app_sensitive';

REVOKE ALL ON SCHEMA sensitive FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_sensitive') THEN
    CREATE ROLE app_sensitive NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  EXECUTE format('GRANT app_sensitive TO %I', current_user);
END $$;

CREATE TABLE IF NOT EXISTS sensitive.self_identification (
  user_id           text PRIMARY KEY REFERENCES public."User"("id") ON DELETE CASCADE,
  -- Every attribute is a closed vocabulary that INCLUDES 'prefer_not_to_say',
  -- stored as a real value so "declined" is distinguishable from "never asked".
  gender            text NOT NULL DEFAULT 'prefer_not_to_say',
  ethnicity         text NOT NULL DEFAULT 'prefer_not_to_say',
  indigenous_status text NOT NULL DEFAULT 'prefer_not_to_say',
  veteran_status    text NOT NULL DEFAULT 'prefer_not_to_say',
  disability_status text NOT NULL DEFAULT 'prefer_not_to_say',
  -- Which version of the self-identification notice the candidate agreed to
  -- when they answered (src/lib/sensitive/self-identification.ts).
  notice_version    text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE sensitive.self_identification IS 'classification: RESTRICTED';

ALTER TABLE sensitive.self_identification ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensitive.self_identification FORCE ROW LEVEL SECURITY;

-- The migration role's access is named, as in the public schema. Policies are
-- dropped-if-exists first so the migration is idempotent: Prisma's shadow
-- database reset clears only the schemas it manages (`public`), so this file
-- may run twice against one shadow database during `migrate dev`.
DROP POLICY IF EXISTS system_full_access ON sensitive.self_identification;
DROP POLICY IF EXISTS owner_only ON sensitive.self_identification;
DO $$ BEGIN EXECUTE format('CREATE POLICY system_full_access ON sensitive.self_identification TO %I USING (true) WITH CHECK (true)', current_user); END $$;

-- The candidate's own row, and nothing else, for the sensitive role — keyed on
-- the same transaction-scoped context the public policies use.
CREATE POLICY owner_only ON sensitive.self_identification
  TO app_sensitive
  USING      (user_id = public.app_current_user_id())
  WITH CHECK (user_id = public.app_current_user_id());

-- Privileges: the sensitive role gets exactly this table and the context
-- accessor. Nothing is granted to app_tenant, and PUBLIC's default USAGE on
-- the schema was revoked above, so the tenant role cannot even name the table.
GRANT USAGE ON SCHEMA sensitive TO app_sensitive;
GRANT SELECT, INSERT, UPDATE, DELETE ON sensitive.self_identification TO app_sensitive;
GRANT USAGE ON SCHEMA public TO app_sensitive;
GRANT EXECUTE ON FUNCTION public.app_current_user_id() TO app_sensitive;

-- Belt and braces: the tenant role and Supabase's REST roles are denied by name.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_tenant', 'anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA sensitive FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA sensitive FROM %I', r);
    END IF;
  END LOOP;
END $$;
