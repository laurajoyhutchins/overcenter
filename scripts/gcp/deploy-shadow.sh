#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-project-6b810532-a302-48dc-b56}"
REGION="${GCP_REGION:-us-west1}"
SERVICE="${GCP_SERVICE:-overcenter-shadow}"
CONNECTION_NAME="${CLOUD_SQL_CONNECTION_NAME:-project-6b810532-a302-48dc-b56:us-west1:overcenter-postgres}"
RUNTIME_SA="${OVERCENTER_RUNTIME_SERVICE_ACCOUNT:-overcenter-runtime@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com}"
DB_NAME="${PGDATABASE:-overcenter}"
DB_USER="${PGUSER:-overcenter}"
PASSWORD_SECRET="${OVERCENTER_DB_PASSWORD_SECRET:-overcenter-db-password}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

gcloud config set project "$PROJECT_ID" >/dev/null

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
if [[ -z "$PROJECT_NUMBER" ]]; then
  echo "Could not resolve project number for $PROJECT_ID" >&2
  exit 2
fi
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

# Source deployments use the Compute Engine default service account for Cloud Build
# unless a different build identity is explicitly configured. Keep this permission
# on the build identity, never on the Overcenter runtime identity.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${BUILD_SA}" \
  --role="roles/run.builder" \
  --condition=None >/dev/null

# This is deliberately a private shadow service. It has no production authority and
# should not receive traffic from the existing Hatchable control-plane endpoint.
gcloud run deploy "$SERVICE" \
  --source . \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --service-account="$RUNTIME_SA" \
  --add-cloudsql-instances="$CONNECTION_NAME" \
  --set-env-vars="PGHOST=/cloudsql/${CONNECTION_NAME},PGDATABASE=${DB_NAME},PGUSER=${DB_USER}" \
  --set-secrets="PGPASSWORD=${PASSWORD_SECRET}:latest" \
  --no-allow-unauthenticated \
  --min-instances=0 \
  --max-instances=1 \
  --quiet

SERVICE_URL="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format='value(status.url)')"

if [[ -z "$SERVICE_URL" ]]; then
  echo "Cloud Run deployment returned no service URL" >&2
  exit 1
fi

IDENTITY_TOKEN="$(gcloud auth print-identity-token)"
HEALTH="$(curl --fail --silent --show-error \
  -H "Authorization: Bearer ${IDENTITY_TOKEN}" \
  "${SERVICE_URL}/health")"

printf '%s\n' \
  "Overcenter GCP shadow runtime ready" \
  "Project:          ${PROJECT_ID}" \
  "Region:           ${REGION}" \
  "Service:          ${SERVICE}" \
  "Runtime identity: ${RUNTIME_SA}" \
  "Cloud SQL:        ${CONNECTION_NAME}" \
  "URL:              ${SERVICE_URL}" \
  "Health:           ${HEALTH}"
