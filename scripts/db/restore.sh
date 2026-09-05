#!/usr/bin/env bash
# Stage 23 (ADR-0037) - restore a backup.sh dump into a database and prove it.
#
#   RESTORE_URL=postgresql://... scripts/db/restore.sh <dump-file>
#
# The target database must exist and be EMPTY (the rehearsal creates a fresh
# one; production restores go to a fresh instance, never over the live one -
# docs/operations/BACKUP_RESTORE.md). After the restore the script verifies:
# the checksum of the dump, that every migration in the dump's history is
# marked applied in the target, that the RLS roles the migration history
# expects exist and are granted to the restoring login, that the TENANT PATH
# works (a transaction that sets the context and assumes app_tenant can read
# a forced table - Stage 23 review H2: a dump restored without its grants
# looked healthy to the system client and served nothing to a person), and
# prints the row counts of a handful of tables so the operator can compare
# them with the source. It never prints a URL.
set -euo pipefail

DUMP="${1:?usage: restore.sh <dump-file>}"
URL="${RESTORE_URL:-}"
if [[ -z "$URL" ]]; then
  echo "restore.sh: set RESTORE_URL to the EMPTY target database (session endpoint)" >&2
  exit 2
fi
if [[ -f "$DUMP.sha256" ]]; then
  ( cd "$(dirname "$DUMP")" && sha256sum --check --quiet "$(basename "$DUMP").sha256" ) || { echo "restore.sh: checksum mismatch - refusing to restore a damaged dump" >&2; exit 3; }
  echo "checksum verified"
fi

# The dump carries no roles (--no-privileges): the tenant and sensitive roles
# must already exist on the target, exactly as `db:migrate:deploy` creates
# them, because RLS policies reference them by name and a restore that
# recreated policies against missing roles would fail half-way.
for role in app_tenant app_sensitive; do
  if [[ "$(psql "$URL" -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$role'")" != "1" ]]; then
    psql "$URL" -qc "CREATE ROLE $role NOLOGIN" >/dev/null
    echo "created role $role (it did not exist on the target)"
  fi
done

pg_restore --dbname="$URL" --no-owner --exit-on-error "$DUMP"
echo "restore completed"

# Role membership is cluster-level and never in a dump: the migration granted
# app_tenant and app_sensitive to the role that ran it so the application can
# SET LOCAL ROLE to them; grant them to the restoring login the same way.
psql "$URL" -qc "DO \$\$ BEGIN EXECUTE format('GRANT app_tenant, app_sensitive TO %I', current_user); END \$\$;" >/dev/null
echo "role membership granted to the restoring login"

# Prove the tenant path, not only the system client: establish a context the
# way src/lib/tenancy/context.ts does and read a forced table as app_tenant.
# A missing GRANT fails here, before anyone repoints the application.
TENANT_PROOF="$(psql "$URL" -tA -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SELECT set_config('app.current_user_id', 'restore-proof', true);
SELECT set_config('app.current_organization_id', '', true);
SET LOCAL ROLE app_tenant;
SELECT 'tenant-path-ok:' || count(*) FROM "User";
ROLLBACK;
SQL
)" || { echo "restore.sh: the TENANT PATH does not work on the restored database (grants missing?)" >&2; exit 5; }
echo "tenant path: $(echo "$TENANT_PROOF" | grep tenant-path-ok)"
SENSITIVE_PROOF="$(psql "$URL" -tA -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SELECT set_config('app.current_user_id', 'restore-proof', true);
SET LOCAL ROLE app_sensitive;
SELECT 'sensitive-path-ok:' || count(*) FROM sensitive.self_identification;
ROLLBACK;
SQL
)" || { echo "restore.sh: the SENSITIVE PATH does not work on the restored database" >&2; exit 5; }
echo "sensitive path: $(echo "$SENSITIVE_PROOF" | grep sensitive-path-ok)"

PENDING="$(psql "$URL" -tAc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL')"
APPLIED="$(psql "$URL" -tAc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')"
echo "migrations applied: $APPLIED, pending or failed: $PENDING"
if [[ "$PENDING" != "0" ]]; then echo "restore.sh: the restored history has pending or failed migrations" >&2; exit 4; fi

FORCED="$(psql "$URL" -tAc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity")"
echo "tables with forced row-level security: $FORCED"

for t in User Organization Application Invoice Payment AuditLog ConsentRecord DocumentVersion; do
  printf '%-16s %s rows\n' "$t" "$(psql "$URL" -tAc "SELECT count(*) FROM \"$t\"")"
done
