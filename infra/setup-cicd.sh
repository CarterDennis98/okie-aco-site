#!/usr/bin/env bash
#
# One-time CI/CD setup: let GitHub Actions deploy without a service account key.
#
#   ./infra/setup-cicd.sh check      # what exists now, no writes
#   ./infra/setup-cicd.sh pool       # workload identity pool + GitHub OIDC provider
#   ./infra/setup-cicd.sh account    # the deployer service account and its roles
#   ./infra/setup-cicd.sh bind       # let each repo impersonate that account
#   ./infra/setup-cicd.sh values     # print what to paste into GitHub
#
# WHY NOT A SERVICE ACCOUNT KEY
# A JSON key is a bearer credential that never expires and works from anywhere. Stored in
# GitHub it is one leaked log line away from full deploy access. Workload Identity
# Federation trades a short-lived token for a GitHub-signed OIDC assertion instead, so
# there is no long-lived secret to leak and access dies with the workflow run.
#
# THE PROVIDER CONDITION IS LOAD-BEARING
# A provider bound only to the GitHub issuer can be assumed from ANY repository on
# GitHub -- including one an attacker creates. Two independent limits are applied:
#
#   1. an attribute-condition on the provider, restricting it to this owner, and
#   2. IAM bindings scoped to attribute.repository for each exact repo.
#
# Either alone would do; both means a mistake in one is not a breach.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-okie-aco}"
PROJECT_NUMBER="${PROJECT_NUMBER:-651840006282}"
REGION="${REGION:-us-central1}"
POOL="${POOL:-github}"
PROVIDER="${PROVIDER:-github}"
DEPLOYER="${DEPLOYER:-okie-deploy}"
RUNTIME_SA="${RUNTIME_SA:-okie-run}"
BOT_SA="${BOT_SA:-okie-bot}"
GITHUB_OWNER="${GITHUB_OWNER:-CarterDennis98}"
SITE_REPO="${SITE_REPO:-okie-aco-site}"
BOT_REPO="${BOT_REPO:-okie-aco-mirror}"
VM="${VM:-okie-bot}"
ZONE="${ZONE:-us-central1-a}"

DEPLOYER_EMAIL="${DEPLOYER}@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_EMAIL="${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
BOT_EMAIL="${BOT_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
# Cloud Build runs as the default compute service account unless told otherwise.
BUILD_EMAIL="${BUILD_EMAIL:-${PROJECT_NUMBER}-compute@developer.gserviceaccount.com}"
POOL_PATH="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}"

say() { printf '\n== %s ==\n' "$1"; }
exists() { eval "$1" >/dev/null 2>&1; }

# Same guard as setup.sh: this must never touch the employer's project.
guard_account() {
  local account project
  account="$(gcloud config get-value account 2>/dev/null)"
  project="$(gcloud config get-value project 2>/dev/null)"
  case "$account" in
    *@nova-compression.com)
      echo "Refusing to run: gcloud is authenticated as $account (work account)."
      exit 1
      ;;
  esac
  if [ "$project" = "nova-app-387015" ]; then
    echo "Refusing to run: active project is $project (work project)."
    exit 1
  fi
  echo "  account : $account"
  echo "  project : $PROJECT_ID"
}

repo_principal() {
  echo "principalSet://iam.googleapis.com/${POOL_PATH}/attribute.repository/${GITHUB_OWNER}/$1"
}

case "${1:-check}" in

check)
  guard_account
  say "workload identity"
  if exists "gcloud iam workload-identity-pools describe $POOL --location=global --project=$PROJECT_ID"; then
    echo "  pool     : $POOL exists"
  else
    echo "  pool     : missing -- run: $0 pool"
  fi
  if exists "gcloud iam workload-identity-pools providers describe $PROVIDER --workload-identity-pool=$POOL --location=global --project=$PROJECT_ID"; then
    echo "  provider : $PROVIDER exists"
    gcloud iam workload-identity-pools providers describe "$PROVIDER" \
      --workload-identity-pool="$POOL" --location=global --project="$PROJECT_ID" \
      --format="value[prefix='  condition: '](attributeCondition)"
  else
    echo "  provider : missing -- run: $0 pool"
  fi

  say "deployer"
  if exists "gcloud iam service-accounts describe $DEPLOYER_EMAIL --project=$PROJECT_ID"; then
    echo "  account  : $DEPLOYER_EMAIL"
    echo "  roles    :"
    gcloud projects get-iam-policy "$PROJECT_ID" \
      --flatten="bindings[].members" \
      --filter="bindings.members:${DEPLOYER_EMAIL}" \
      --format="value[prefix='    '](bindings.role)" 2>/dev/null
    echo "  repos allowed to impersonate it:"
    gcloud iam service-accounts get-iam-policy "$DEPLOYER_EMAIL" --project="$PROJECT_ID" \
      --flatten="bindings[].members" \
      --filter="bindings.role:roles/iam.workloadIdentityUser" \
      --format="value[prefix='    '](bindings.members)" 2>/dev/null \
      | sed "s|principalSet://iam.googleapis.com/${POOL_PATH}/attribute.repository/||"
  else
    echo "  account  : missing -- run: $0 account"
  fi
  ;;

pool)
  guard_account
  if ! exists "gcloud iam workload-identity-pools describe $POOL --location=global --project=$PROJECT_ID"; then
    say "creating pool $POOL"
    gcloud iam workload-identity-pools create "$POOL" \
      --location=global \
      --display-name="GitHub Actions" \
      --project="$PROJECT_ID"
  fi

  if ! exists "gcloud iam workload-identity-pools providers describe $PROVIDER --workload-identity-pool=$POOL --location=global --project=$PROJECT_ID"; then
    say "creating provider $PROVIDER"
    # `repository` is what the IAM bindings key off, so it must be mapped. The condition
    # is the first of the two limits described at the top of this file.
    gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
      --location=global \
      --workload-identity-pool="$POOL" \
      --display-name="GitHub" \
      --issuer-uri="https://token.actions.githubusercontent.com" \
      --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner,attribute.ref=assertion.ref" \
      --attribute-condition="assertion.repository_owner == '${GITHUB_OWNER}'" \
      --project="$PROJECT_ID"
  fi
  echo "  provider ready"
  ;;

account)
  guard_account
  if ! exists "gcloud iam service-accounts describe $DEPLOYER_EMAIL --project=$PROJECT_ID"; then
    say "creating $DEPLOYER_EMAIL"
    gcloud iam service-accounts create "$DEPLOYER" \
      --display-name="GitHub Actions deployer" \
      --project="$PROJECT_ID"
  fi

  say "enabling APIs the deploy path needs"
  gcloud services enable cloudresourcemanager.googleapis.com \
    --project="$PROJECT_ID" --quiet >/dev/null
  echo "  cloudresourcemanager.googleapis.com"

  say "granting project roles"
  # Deliberately narrow. Notably absent: any Secret Manager admin role (CI never creates
  # or reads secret VALUES except the one DB URL granted per-secret below), and any
  # database owner role.
  for role in \
    roles/cloudbuild.builds.editor \
    roles/artifactregistry.writer \
    roles/run.admin \
    roles/cloudsql.client \
    roles/compute.osAdminLogin \
    roles/iap.tunnelResourceAccessor \
    roles/compute.viewer \
    roles/serviceusage.serviceUsageConsumer \
    roles/storage.admin; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
      --member="serviceAccount:${DEPLOYER_EMAIL}" \
      --role="$role" \
      --condition=None \
      --quiet >/dev/null
    echo "  $role"
  done

  # The last two above are what `gcloud builds submit` actually needs, and neither is
  # obvious from its error message -- it reports "forbidden from accessing the bucket
  # [<project>_cloudbuild]" for both:
  #
  #   serviceUsageConsumer  grants serviceusage.services.use. Without it the Storage call
  #                         cannot be attributed to this project and is refused.
  #   storage.admin         PROJECT level, not bucket level. objectAdmin covers objects
  #                         but not storage.buckets.get/list, which submit needs to find
  #                         and validate the staging bucket.

  # Deploying a service that RUNS AS okie-run means acting as it. Scoped to those two
  # accounts rather than granted project-wide.
  #
  # BOTH are required, and the second is easy to miss. SSHing into a VM that runs as a
  # service account also needs actAs on THAT account -- without it OS Login's policy check
  # denies the login and sshd reports the useless "Server refused our key", which looks
  # like a key problem and is actually an IAM one.
  # THREE accounts, and each is a workload that runs AS one of them:
  #   okie-run   the Cloud Run service
  #   okie-bot   the VM (SSH into a VM running as an SA needs actAs on that SA)
  #   <n>-compute  what Cloud Build itself runs as -- submitting a build is "act as"
  #
  # Every one of these produced a different, unhelpful error when missing: "Server refused
  # our key" for the VM, and "caller does not have permission to act as service account
  # projects/.../107095928486223113574" for Cloud Build.
  say "letting the deployer act as $RUNTIME_SA, $BOT_SA, and Cloud Build's runtime"
  for target in "$RUNTIME_EMAIL" "$BOT_EMAIL" "$BUILD_EMAIL"; do
    gcloud iam service-accounts add-iam-policy-binding "$target" \
      --member="serviceAccount:${DEPLOYER_EMAIL}" \
      --role="roles/iam.serviceAccountUser" \
      --project="$PROJECT_ID" --quiet >/dev/null
    echo "  $target"
  done

  # gcloud compute ssh falls back to writing the generated key into instance metadata
  # unless OS Login is on, and that needs compute.instances.setMetadata -- a much broader
  # permission than logging in. Enabled on the INSTANCE, not project-wide, so the blast
  # radius is this one VM.
  say "enabling OS Login on $VM"
  gcloud compute instances add-metadata "$VM" \
    --zone="$ZONE" --metadata enable-oslogin=TRUE \
    --project="$PROJECT_ID" --quiet >/dev/null
  echo "  ok"

  # Only the database URL, and only this one secret: the migration check needs it to
  # reach Cloud SQL. The vault key is NOT granted -- CI has no business decrypting.
  say "granting read on DATABASE_URL only"
  gcloud secrets add-iam-policy-binding DATABASE_URL \
    --member="serviceAccount:${DEPLOYER_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" \
    --project="$PROJECT_ID" --quiet >/dev/null
  echo "  ok"
  ;;

bind)
  guard_account
  say "allowing each repo to impersonate $DEPLOYER"
  for repo in "$SITE_REPO" "$BOT_REPO"; do
    gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_EMAIL" \
      --member="$(repo_principal "$repo")" \
      --role="roles/iam.workloadIdentityUser" \
      --project="$PROJECT_ID" --quiet >/dev/null
    echo "  ${GITHUB_OWNER}/${repo}"
  done
  ;;

values)
  cat <<EOF

Add these as repository VARIABLES (not secrets -- none of it is sensitive; the
identifiers are useless without a GitHub-signed token from the named repo):

  GCP_PROJECT_ID          ${PROJECT_ID}
  GCP_WIF_PROVIDER        ${POOL_PATH}/providers/${PROVIDER}
  GCP_DEPLOY_SA           ${DEPLOYER_EMAIL}

In both repos:
  gh variable set GCP_PROJECT_ID   --body "${PROJECT_ID}"
  gh variable set GCP_WIF_PROVIDER --body "${POOL_PATH}/providers/${PROVIDER}"
  gh variable set GCP_DEPLOY_SA    --body "${DEPLOYER_EMAIL}"

Or paste them under Settings -> Secrets and variables -> Actions -> Variables.

EOF
  ;;

*)
  echo "Usage: $0 {check|pool|account|bind|values}"
  exit 1
  ;;
esac
