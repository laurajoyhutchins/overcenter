#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-project-6b810532-a302-48dc-b56}"
POOL_ID="${GCP_WIF_POOL_ID:-github}"
PROVIDER_ID="${GCP_WIF_PROVIDER_ID:-overcenter}"
DEPLOYER_SA_NAME="${GCP_DEPLOYER_SERVICE_ACCOUNT_NAME:-overcenter-deployer}"
RUNTIME_SA="${OVERCENTER_RUNTIME_SERVICE_ACCOUNT:-overcenter-runtime@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com}"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-laurajoyhutchins/overcenter}"
GITHUB_REPOSITORY_ID="${GITHUB_REPOSITORY_ID:-1339925321}"
GITHUB_REPOSITORY_OWNER_ID="${GITHUB_REPOSITORY_OWNER_ID:-219002713}"

for command in gcloud gh; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required" >&2
    exit 2
  fi
done

if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  echo "gh must be authenticated to github.com before bootstrap" >&2
  exit 2
fi

if [[ -z "$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n1)" ]]; then
  echo "gcloud must have an active Google Cloud account before bootstrap" >&2
  exit 2
fi

gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
if [[ -z "$PROJECT_NUMBER" ]]; then
  echo "Could not resolve Google Cloud project number for $PROJECT_ID" >&2
  exit 2
fi

DEPLOYER_SA="${DEPLOYER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

# Complete host-side dependency set for source deployment, keyless GitHub
# authentication, Cloud SQL attachment, secret injection, and project metadata.
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  cloudresourcemanager.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com \
  --project="$PROJECT_ID"

if ! gcloud iam service-accounts describe "$DEPLOYER_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$DEPLOYER_SA_NAME" \
    --project="$PROJECT_ID" \
    --display-name="Overcenter GitHub deployer"
fi

for role in roles/run.sourceDeveloper roles/serviceusage.serviceUsageConsumer roles/run.invoker; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOYER_SA}" \
    --role="$role" \
    --condition=None >/dev/null
done

# Source deployments build as the project's Compute Engine default service
# account. The build identity owns build permissions; the deployer only gets
# permission to select/impersonate it for this deployment boundary.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${BUILD_SA}" \
  --role="roles/run.builder" \
  --condition=None >/dev/null

gcloud iam service-accounts add-iam-policy-binding "$BUILD_SA" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${DEPLOYER_SA}" \
  --role="roles/iam.serviceAccountUser" >/dev/null

# The deployer may select the dedicated runtime identity, but does not inherit
# that identity's database or secret permissions.
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${DEPLOYER_SA}" \
  --role="roles/iam.serviceAccountUser" >/dev/null

if ! gcloud iam workload-identity-pools describe "$POOL_ID" \
    --project="$PROJECT_ID" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL_ID" \
    --project="$PROJECT_ID" \
    --location=global \
    --display-name="GitHub Actions"
fi

ATTRIBUTE_MAPPING="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref"
ATTRIBUTE_CONDITION="assertion.repository_id == '${GITHUB_REPOSITORY_ID}' && assertion.repository_owner_id == '${GITHUB_REPOSITORY_OWNER_ID}' && (assertion.ref == 'refs/heads/work/gcp-cloud-run-cloud-sql-bootstrap' || assertion.ref == 'refs/heads/dev')"

if gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
    --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_ID" \
    --project="$PROJECT_ID" \
    --location=global \
    --workload-identity-pool="$POOL_ID" \
    --issuer-uri="https://token.actions.githubusercontent.com/" \
    --attribute-mapping="$ATTRIBUTE_MAPPING" \
    --attribute-condition="$ATTRIBUTE_CONDITION"
else
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
    --project="$PROJECT_ID" \
    --location=global \
    --workload-identity-pool="$POOL_ID" \
    --display-name="Overcenter GitHub Actions" \
    --issuer-uri="https://token.actions.githubusercontent.com/" \
    --attribute-mapping="$ATTRIBUTE_MAPPING" \
    --attribute-condition="$ATTRIBUTE_CONDITION"
fi

FEDERATED_REPOSITORY="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository_id/${GITHUB_REPOSITORY_ID}"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_SA" \
  --project="$PROJECT_ID" \
  --member="$FEDERATED_REPOSITORY" \
  --role="roles/iam.workloadIdentityUser" >/dev/null

WIF_PROVIDER="$(gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
  --project="$PROJECT_ID" \
  --location=global \
  --workload-identity-pool="$POOL_ID" \
  --format='value(name)')"

if [[ -z "$WIF_PROVIDER" ]]; then
  echo "Workload Identity Provider did not return a resource name" >&2
  exit 1
fi

# These are coordinates, not credentials. Persist them as Actions variables so
# the deployment workflow contains no long-lived Google key material.
gh variable set GCP_PROJECT_ID --repo "$GITHUB_REPOSITORY" --body "$PROJECT_ID"
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo "$GITHUB_REPOSITORY" --body "$WIF_PROVIDER"
gh variable set GCP_DEPLOY_SERVICE_ACCOUNT --repo "$GITHUB_REPOSITORY" --body "$DEPLOYER_SA"

printf '%s\n' \
  "Overcenter GitHub OIDC bootstrap ready" \
  "Google project:   ${PROJECT_ID}" \
  "Project number:   ${PROJECT_NUMBER}" \
  "Deploy identity:  ${DEPLOYER_SA}" \
  "Build identity:   ${BUILD_SA}" \
  "Runtime identity: ${RUNTIME_SA}" \
  "WIF provider:     ${WIF_PROVIDER}" \
  "GitHub repo:      ${GITHUB_REPOSITORY}" \
  "Next: rerun the failed GCP hosted shadow deployment workflow."
