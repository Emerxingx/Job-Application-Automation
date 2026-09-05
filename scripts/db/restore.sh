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
# expects exist, and prints the row counts of a handful of tables so the
# operator can compare them with the source. It never prints a URL.
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

pg_restore --dbname="$URL" --no-owner --no-privileges --exit-on-error "$DUMP"
echo "restore completed"

PENDING="$(psql "$URL" -tAc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL')"
APPLIED="$(psql "$URL" -tAc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')"
echo "migrations applied: $APPLIED, pending or failed: $PENDING"
if [[ "$PENDING" != "0" ]]; then echo "restore.sh: the restored history has pending or failed migrations" >&2; exit 4; fi

FORCED="$(psql "$URL" -tAc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity")"
echo "tables with forced row-level security: $FORCED"

for t in User Organization Application Invoice Payment AuditLog ConsentRecord DocumentVersion; do
  printf '%-16s %s rows\n' "$t" "$(psql "$URL" -tAc "SELECT count(*) FROM \"$t\"")"
done
