#!/usr/bin/env bash
#
# One-time GCP setup, as commands rather than prose.
#
#   ./infra/setup.sh preflight   # who am I, what exists, no writes
#   ./infra/setup.sh project     # project, APIs, service account
#   ./infra/setup.sh registry    # Artifact Registry + cleanup policy
#   ./infra/setup.sh sql         # Cloud SQL instance, database, app user
#   ./infra/setup.sh secrets     # create empty secrets, then fill them by hand
#   ./infra/setup.sh build       # build and push the image
#   ./infra/setup.sh deploy      # deploy / update the Cloud Run service
#   ./infra/setup.sh domain      # map okie-aco.com
#   ./infra/setup.sh urls        # print the service URL and the DB socket path
#
# Run them in that order. Each step is safe to re-run: it checks whether the resource
# exists before creating it, so this doubles as documentation you can replay on a
# rebuild rather than a one-shot script you have to trust from memory.
#
# WHAT THIS FILE MUST NEVER CONTAIN
# No secret values. `secrets` creates the containers; you pipe the values in yourself so
# they never land in a shell history, a build log, or this repository.
#
# ORDER THAT MATTERS
#   - VAULT_KEY_K1 goes into Secret Manager BEFORE any data is restored. Restoring first
#     leaves a database of AES envelopes that nothing can open.
#   - `prisma migrate deploy` runs by hand, through the proxy, BEFORE the data restore
#     and never on container boot -- three instances racing the migration table takes the
#     site down instead of failing loudly in one place.
#   - Data comes last, via ./infra/migrate-to-cloud-sql.sh.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-okie-aco}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-okie-aco-site}"
REPO="${REPO:-okie}"
SQL_INSTANCE="${SQL_INSTANCE:-okie-pg}"
SQL_DB="${SQL_DB:-okie}"
SQL_USER="${SQL_USER:-okie_app}"
RUNTIME_SA="${RUNTIME_SA:-okie-run}"
DOMAIN="${DOMAIN:-okie-aco.com}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}"

# Secrets the service reads. Values are supplied by you, never by this script.
SECRETS=(
  DATABASE_URL
  AUTH_SECRET
  AUTH_DISCORD_SECRET
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
  VAULT_KEY_K1
  BOT_INGEST_TOKEN
  DISCORD_VAULT_WEBHOOK_URL
  DISCORD_PAYMENT_WEBHOOK_URL
)

# Non-secret runtime configuration. Safe in plain text on the service.
#   AUTH_URL starts as the run.app URL and moves to the domain at the `domain` step.
#   SERVER_ACTIONS_ALLOWED_ORIGINS is the run.app host; the domain is already allowed
#   in next.config.ts.
PLAIN_ENV=(
  "AUTH_TRUST_HOST=true"
  "VAULT_KEY_ACTIVE=k1"
  "DB_POOL_MAX=3"
)

say() { printf '\n== %s ==\n' "$1"; }
exists() { eval "$1" >/dev/null 2>&1; }

guard_account() {
  local account project
  account="$(gcloud config get-value account 2>/dev/null || true)"
  project="$(gcloud config get-value project 2>/dev/null || true)"

  # This laptop is signed in to an employer account by default. A personal side project
  # must not land on their project or their billing.
  case "$account" in
    *@nova-compression.com)
      echo "REFUSING: gcloud is authenticated as $account (employer account)."
      echo "Create a separate configuration first:"
      echo "  gcloud config configurations create okie"
      echo "  gcloud auth login <personal account>"
      echo "  gcloud config set project $PROJECT_ID"
      exit 1
      ;;
  esac
  if [ "$project" = "nova-app-387015" ]; then
    echo "REFUSING: active project is nova-app-387015 (employer project)."
    exit 1
  fi
  echo "  account : ${account:-<unset>}"
  echo "  project : ${project:-<unset>}"
}

case "${1:-preflight}" in

preflight)
  say "identity"
  guard_account
  say "billing"
  # Reported from the field rather than from the exit code: the first `gcloud beta` call
  # on a machine can fail while it installs the component, which looked exactly like
  # "billing not linked" and is a bad thing to be wrong about.
  billing_out="$(gcloud beta billing projects describe "$PROJECT_ID" 2>&1 || true)"
  case "$billing_out" in
    *"billingEnabled: true"*)
      echo "  linked   : $(printf '%s' "$billing_out" | sed -n 's/^billingAccountName: billingAccounts\///p')"
      echo "  enabled  : yes"
      ;;
    *"billingEnabled: false"*)
      echo "  a billing account is attached but billing is DISABLED"
      ;;
    *)
      echo "  could not read billing state:"
      printf '%s
' "$billing_out" | sed 's/^/    /' | head -4
      echo "    (if this mentions a component install, re-run once it finishes)"
      ;;
  esac
  say "what already exists"
  exists "gcloud projects describe $PROJECT_ID" && echo "  project      yes" || echo "  project      no"
  exists "gcloud artifacts repositories describe $REPO --location=$REGION" &&
    echo "  registry     yes" || echo "  registry     no"
  exists "gcloud sql instances describe $SQL_INSTANCE" &&
    echo "  cloud sql    yes" || echo "  cloud sql    no"
  exists "gcloud run services describe $SERVICE --region=$REGION" &&
    echo "  cloud run    yes" || echo "  cloud run    no"
  ;;

project)
  guard_account
  say "APIs"
  gcloud services enable \
    run.googleapis.com \
    sqladmin.googleapis.com \
    artifactregistry.googleapis.com \
    secretmanager.googleapis.com \
    cloudbuild.googleapis.com \
    --project "$PROJECT_ID"

  say "runtime service account"
  # Its own identity rather than the default compute SA, so the grants below are the
  # complete list of what the site can reach.
  exists "gcloud iam service-accounts describe ${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com" ||
    gcloud iam service-accounts create "$RUNTIME_SA" \
      --display-name="Okie ACO site runtime" --project "$PROJECT_ID"

  for role in roles/cloudsql.client roles/secretmanager.secretAccessor; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
      --member="serviceAccount:${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
      --role="$role" --condition=None >/dev/null
    echo "  granted $role"
  done
  ;;

registry)
  guard_account
  exists "gcloud artifacts repositories describe $REPO --location=$REGION" ||
    gcloud artifacts repositories create "$REPO" \
      --repository-format=docker --location="$REGION" \
      --description="Okie ACO images" --project "$PROJECT_ID"
  gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
  echo "  images push to $IMAGE"
  echo "  Set a cleanup policy keeping the 5 most recent in the console, or with"
  echo "  'gcloud artifacts repositories set-cleanup-policies' -- unbounded tags cost storage forever."
  ;;

sql)
  guard_account
  say "instance"
  # A public IP is assigned but NO authorized networks are added, which is what makes
  # this unreachable from the internet: with an empty allowlist nothing may connect
  # directly. Cloud Run reaches it through the built-in connector over a unix socket,
  # authenticated by IAM rather than by network position.
  #
  # Do NOT "harden" this with --no-assign-ip: that disables the public path entirely and
  # the API rejects the instance for having no connectivity at all, since we aren't
  # configuring private IP or PSC.
  #
  # --edition=enterprise is load-bearing. PostgreSQL 17 defaults to enterprise-plus,
  # which rejects the shared-core tiers outright and only accepts db-perf-optimized-N-*
  # -- an order of magnitude more per month than this project needs.
  exists "gcloud sql instances describe $SQL_INSTANCE" ||
    gcloud sql instances create "$SQL_INSTANCE" \
      --database-version=POSTGRES_17 \
      --edition=enterprise \
      --tier=db-f1-micro \
      --region="$REGION" \
      --storage-size=10 --storage-type=SSD \
      --availability-type=zonal \
      --backup --backup-start-time=09:00 \
      --project "$PROJECT_ID"

  say "database"
  exists "gcloud sql databases describe $SQL_DB --instance=$SQL_INSTANCE" ||
    gcloud sql databases create "$SQL_DB" --instance="$SQL_INSTANCE" --project "$PROJECT_ID"

  say "application user"
  echo "  Generate a password from [A-Za-z0-9] ONLY. A '#', '@', '/', or '%' inside a"
  echo "  URL-form connection string fails at parse time, in Cloud Run, with an error"
  echo "  that says nothing about the cause:"
  echo "    openssl rand -hex 24"
  echo
  echo "  gcloud sql users create $SQL_USER --instance=$SQL_INSTANCE --password=<value>"
  echo
  echo "  Then the DATABASE_URL secret is:"
  echo "    postgresql://${SQL_USER}:<value>@localhost/${SQL_DB}?host=/cloudsql/${PROJECT_ID}:${REGION}:${SQL_INSTANCE}&connection_limit=3"
  echo
  echo "  connection_limit=3 is deliberate: db-f1-micro allows ~25 connections, and"
  echo "  max-instances=3 x 3 is nine. Raising max-instances without lowering this"
  echo "  produces 'too many clients already' mid-drop."
  ;;

secrets)
  guard_account
  say "creating empty secrets"
  for name in "${SECRETS[@]}"; do
    if exists "gcloud secrets describe $name --project $PROJECT_ID"; then
      echo "  $name already exists"
    else
      gcloud secrets create "$name" --replication-policy=automatic --project "$PROJECT_ID"
      echo "  $name created (no version yet)"
    fi
  done
  cat <<'EOF'

  Add each value WITHOUT putting it in your shell history:

    printf %s "$(read -rsp 'value: ' v; echo "$v")" |
      gcloud secrets versions add SECRET_NAME --data-file=-

  Or straight from a file, then delete the file.

  VAULT_KEY_K1 is the one that cannot be regenerated. It decrypts every stored card,
  CVV, retailer login, and app password. Add it BEFORE restoring any data, and make
  sure it is the same value as your local .env -- a different key does not fail loudly,
  it just makes every existing row permanently unreadable.
EOF
  ;;

build)
  guard_account
  tag="$(git rev-parse --short HEAD)"
  say "building ${IMAGE}:${tag}"
  # Tagged with the commit, never :latest, so a rollback is one update-traffic away.
  gcloud builds submit --tag "${IMAGE}:${tag}" --project "$PROJECT_ID" .
  echo "  built ${IMAGE}:${tag}"
  ;;

deploy)
  guard_account
  tag="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
  secret_flags=""
  for name in "${SECRETS[@]}"; do
    secret_flags="${secret_flags}${name}=${name}:latest,"
  done
  env_flags="$(IFS=','; echo "${PLAIN_ENV[*]}")"

  say "deploying ${IMAGE}:${tag}"
  gcloud run deploy "$SERVICE" \
    --image "${IMAGE}:${tag}" \
    --region "$REGION" \
    --platform managed \
    --service-account "${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --add-cloudsql-instances "${PROJECT_ID}:${REGION}:${SQL_INSTANCE}" \
    --set-secrets "${secret_flags%,}" \
    --set-env-vars "$env_flags" \
    --cpu 1 --memory 512Mi \
    --min-instances 0 --max-instances 3 \
    --concurrency 80 \
    --cpu-boost \
    --allow-unauthenticated \
    --project "$PROJECT_ID"

  cat <<EOF

  Still to set by hand, because they depend on the URL you just got:
    AUTH_URL, SERVER_ACTIONS_ALLOWED_ORIGINS, ADMIN_DISCORD_IDS,
    AUTH_DISCORD_ID, DISCORD_GUILD_ID, DISCORD_OG_ROLE_ID,
    DISCORD_INVITE_URL, DISCORD_PAYMENT_URL

    gcloud run services update $SERVICE --region $REGION \\
      --update-env-vars AUTH_URL=https://<the url>,SERVER_ACTIONS_ALLOWED_ORIGINS=<the host>

  Then, before any data:
    cloud-sql-proxy ${PROJECT_ID}:${REGION}:${SQL_INSTANCE} --port 5433
    DATABASE_URL="postgresql://${SQL_USER}:<pw>@localhost:5433/${SQL_DB}" npx prisma migrate deploy
    ./infra/migrate-to-cloud-sql.sh check
EOF
  ;;

domain)
  guard_account
  say "mapping $DOMAIN"
  gcloud beta run domain-mappings create \
    --service "$SERVICE" --domain "$DOMAIN" \
    --region "$REGION" --project "$PROJECT_ID" ||
    echo "  (already mapped, or the domain needs verifying first)"
  cat <<EOF

  After DNS resolves:
    1. gcloud run services update $SERVICE --region $REGION \\
         --update-env-vars AUTH_URL=https://$DOMAIN
    2. Add https://$DOMAIN/api/auth/callback/discord to the Discord app's redirect URIs.
       Keep the run.app callback too until you are sure.
EOF
  ;;

urls)
  gcloud run services describe "$SERVICE" --region "$REGION" \
    --format='value(status.url)' --project "$PROJECT_ID"
  echo "cloudsql socket: /cloudsql/${PROJECT_ID}:${REGION}:${SQL_INSTANCE}"
  ;;

*)
  echo "Usage: $0 {preflight|project|registry|sql|secrets|build|deploy|domain|urls}"
  exit 1
  ;;
esac
