#!/usr/bin/env bash
# Stage 23 (ADR-0037) - a logical backup of the operational database.
#
#   scripts/db/backup.sh <output-dir>           # uses DIRECT_URL (the session endpoint, never the pooler)
#   BACKUP_URL=postgresql://... scripts/db/backup.sh <output-dir>
#
# Writes <output-dir>/jobpilot-<UTC timestamp>.dump in pg_dump's custom format
# (compressed, restorable table by table with pg_restore) plus a .sha256 of
# it, and prints only the file name and size - never the connection string.
#
# What this is: the operator's own backup, restorable with restore.sh, and
# the artefact the restore rehearsal (docs/operations/BACKUP_RESTORE.md)
# proves. What it is not: the managed provider's continuous backup / PITR,
# which is configured on the provider's side and is NOT VERIFIED from here.
set -euo pipefail

OUT_DIR="${1:?usage: backup.sh <output-dir>}"
URL="${BACKUP_URL:-${DIRECT_URL:-}}"
if [[ -z "$URL" ]]; then
  echo "backup.sh: set DIRECT_URL (or BACKUP_URL) to the database's session endpoint" >&2
  exit 2
fi
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT_DIR/jobpilot-$STAMP.dump"

# --no-owner/--no-privileges: the restore target's roles are its own; RLS
# roles and grants are recreated by the migration history, not the dump.
# The sensitive schema (ADR-0007) IS included: a backup that silently omitted
# it would be a data loss on restore. It stays under the same access control
# as the dump file itself, which is why the file is never left world-readable.
umask 077
pg_dump --dbname="$URL" --format=custom --compress=6 --no-owner --no-privileges --file="$FILE"
( cd "$OUT_DIR" && sha256sum "$(basename "$FILE")" > "$(basename "$FILE").sha256" )
SIZE="$(stat -c %s "$FILE")"
echo "backup written: $(basename "$FILE") ($SIZE bytes), checksum $(cut -c1-16 "$FILE.sha256")…"
