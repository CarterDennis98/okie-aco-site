#!/usr/bin/env bash
#
# Move the local database to Cloud SQL. Run once, at first deploy.
#
#   ./infra/migrate-to-cloud-sql.sh check     # what's here, what's there, no writes
#   ./infra/migrate-to-cloud-sql.sh dump      # write a local dump file
#   ./infra/migrate-to-cloud-sql.sh restore   # load that dump into Cloud SQL
#   ./infra/migrate-to-cloud-sql.sh verify    # compare row counts on both sides
#
# WHY A DUMP AND NOT A RE-IMPORT
# The importers can rebuild most of this from the AYCD/Shikari exports, but not all of
# it: the owner-map decisions, the settled-bill receipts, and the member-created
# forwarding aliases exist nowhere else. A dump carries everything, and it carries the
# ciphertext untouched.
#
# THE CIPHERTEXT ONLY WORKS WITH ITS KEY
# Card numbers, CVVs, retailer passwords, and app passwords all move as AES envelopes.
# They are readable in Cloud SQL only if the SAME VAULT_KEY_K1 is present there. Put the
# key in Secret Manager BEFORE restoring, or you will have a database full of values
# nothing can open.
#
# MIGRATIONS FIRST
# Restore into a schema that already exists: run `prisma migrate deploy` against Cloud
# SQL first, then restore data only. That keeps Prisma's migration history correct
# instead of inheriting whatever the dump happened to contain.

set -euo pipefail

DUMP_FILE="${DUMP_FILE:-./okie-local.dump}"
# The Cloud SQL Auth Proxy listens here; start it in another terminal with
#   cloud-sql-proxy PROJECT:us-central1:okie-pg --port 5433
CLOUD_URL="${CLOUD_DATABASE_URL:-postgresql://okie_app@localhost:5433/okie}"
LOCAL_URL="${LOCAL_DATABASE_URL:-${DATABASE_URL:-}}"

# The Auth.js tables -- users, sessions, accounts, verification_tokens -- are
# deliberately NOT migrated:
#
#   sessions   are live logins. The local ones were minted by scripts/dev-session.ts
#              without authentication; copying them to production would hand out working
#              admin logins. Never migrate this table.
#   accounts   are OAuth links with their tokens already nulled. Recreated on first
#              sign-in, on the production domain, which is where they belong.
#   users      is recreated by the adapter on sign-in. The only member state it holds is
#              `hide_from_public_feed`, which is currently set on nobody -- check that
#              again before running, and hand-carry it if anyone has opted out by then:
#                psql "$LOCAL_URL" -c "select discord_user_id from users where hide_from_public_feed"
#
# DiscordMember, not User, is the canonical member record, and it IS migrated below.
TABLES=(
  discord_members profiles items item_aliases checkouts
  pas_runs pas_bills pas_bill_lines payments
  vault_accounts vault_profiles email_credentials email_aliases
  vault_changes vault_reveals vault_exports
  testimonials admin_audit backfill_progress
)

# The Postgres client tools ship with the Windows installer but are not added to PATH.
# Found here rather than demanded of the caller, so this works from a fresh shell.
# PG_BIN overrides for any other layout.
if ! command -v psql >/dev/null 2>&1; then
  for candidate in "${PG_BIN:-}" /c/Program\ Files/PostgreSQL/*/bin /usr/lib/postgresql/*/bin; do
    if [ -x "$candidate/psql" ]; then PATH="$candidate:$PATH"; break; fi
  done
fi

require() {
  command -v "$1" >/dev/null || {
    echo "Need $1 on PATH. Postgres client tools live in the install's bin/ directory;"
    echo "set PG_BIN=/path/to/postgresql/bin if they are somewhere unusual."
    exit 1
  }
}

counts() {
  local url="$1" label="$2"
  echo "  --- $label ---"
  for t in "${TABLES[@]}"; do
    n=$(psql "$url" -tAc "select count(*) from $t" 2>/dev/null || echo "-")
    printf "    %-22s %s\n" "$t" "$n"
  done
}

case "${1:-check}" in
  check)
    require psql
    [ -n "$LOCAL_URL" ] || { echo "Set DATABASE_URL or LOCAL_DATABASE_URL."; exit 1; }
    counts "$LOCAL_URL" "local"
    echo
    if psql "$CLOUD_URL" -tAc "select 1" >/dev/null 2>&1; then
      counts "$CLOUD_URL" "cloud sql"
    else
      echo "  --- cloud sql --- not reachable at $CLOUD_URL"
      echo "  Start the proxy: cloud-sql-proxy PROJECT:us-central1:okie-pg --port 5433"
    fi
    ;;

  dump)
    require pg_dump
    [ -n "$LOCAL_URL" ] || { echo "Set DATABASE_URL or LOCAL_DATABASE_URL."; exit 1; }
    # Data only: the schema comes from `prisma migrate deploy`, not from here.
    #
    # One pg_dump per table, appended in TABLES order, because TABLES is a valid foreign
    # key dependency order -- parents before children. The obvious alternative,
    # --disable-triggers, cannot work here: suppressing a foreign key's internal trigger
    # needs real superuser, which Cloud SQL never grants, and the restore dies on
    # "permission denied: RI_ConstraintTrigger_... is a system trigger".
    #
    # Safe because every id in this schema is a uuid or cuid: no sequences to carry over,
    # so ordering is the only thing that has to be right.
    : > "$DUMP_FILE"
    for t in "${TABLES[@]}"; do
      pg_dump "$LOCAL_URL" \
        --data-only \
        --no-owner \
        --no-privileges \
        --table="public.$t" \
        >> "$DUMP_FILE"
    done
    echo "Wrote $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"
    echo
    echo "This file contains encrypted card numbers and passwords."
    echo "Delete it once the restore is verified: rm $DUMP_FILE"
    ;;

  restore)
    require psql
    [ -f "$DUMP_FILE" ] || { echo "No dump at $DUMP_FILE. Run: $0 dump"; exit 1; }

    existing=$(psql "$CLOUD_URL" -tAc "select count(*) from vault_profiles" 2>/dev/null || echo "?")
    if [ "$existing" != "0" ] && [ "$existing" != "?" ]; then
      echo "Cloud SQL already holds $existing vault_profiles."
      echo "Restoring on top would duplicate rows. Clear it deliberately first."
      exit 1
    fi
    if [ "$existing" = "?" ]; then
      echo "vault_profiles is missing in Cloud SQL -- run 'prisma migrate deploy' first."
      exit 1
    fi

    psql "$CLOUD_URL" --single-transaction --set ON_ERROR_STOP=1 --file "$DUMP_FILE"
    echo "Restored. Now run: $0 verify"
    ;;

  verify)
    require psql
    [ -n "$LOCAL_URL" ] || { echo "Set DATABASE_URL or LOCAL_DATABASE_URL."; exit 1; }
    echo "  table                    local    cloud   match"
    bad=0
    for t in "${TABLES[@]}"; do
      a=$(psql "$LOCAL_URL" -tAc "select count(*) from $t" 2>/dev/null || echo "-")
      b=$(psql "$CLOUD_URL" -tAc "select count(*) from $t" 2>/dev/null || echo "-")
      if [ "$a" = "$b" ]; then m="yes"; else m="NO"; bad=$((bad + 1)); fi
      printf "  %-22s %7s %8s   %s\n" "$t" "$a" "$b" "$m"
    done
    echo
    if [ "$bad" -eq 0 ]; then
      echo "Row counts match. Next: confirm the secrets actually decrypt in Cloud SQL --"
      echo "  DATABASE_URL=\"\$CLOUD_DATABASE_URL\" npx tsx --conditions=react-server scripts/verify-vault.ts"
      echo "A PASS there means the vault key travelled correctly. Then delete $DUMP_FILE."
    else
      echo "$bad table(s) differ. Do not delete the dump."
      exit 1
    fi
    ;;

  *)
    echo "Usage: $0 {check|dump|restore|verify}"
    exit 1
    ;;
esac
