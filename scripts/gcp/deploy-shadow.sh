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

# Deployment IAM is provisioned once by bootstrap-github-oidc.sh. Ordinary
# deployments deliberately cannot mutate project IAM.
#
# /health performs SELECT 1 against Postgres. Making it the startup probe means
# Cloud Run only marks the revision ready after both the HTTP runtime and Cloud
# SQL connection are proven healthy. This avoids granting CI token-minting power
# solely for an out-of-band smoke request.
gcloud run deploy "$SERVICE" \
  --source . \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --service-account="$RUNTIME_SA" \
  --add-cloudsql-instances="$CONNECTION_NAME" \
  --set-env-vars="PGHOST=/cloudsql/${CONNECTION_NAME},PGDATABASE=${DB_NAME},PGUSER=${DB_USER}" \
  --set-secrets="PGPASSWORD=${PASSWORD_SECRET}:latest" \
  --startup-probe="httpGet.path=/health,httpGet.port=8080,initialDelaySeconds=0,failureThreshold=12,timeoutSeconds=3,periodSeconds=5" \
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

LATEST_READY_REVISION="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format='value(status.latestReadyRevisionName)')"
LATEST_CREATED_REVISION="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format='value(status.latestCreatedRevisionName)')"

if [[ -z "$LATEST_READY_REVISION" || "$LATEST_READY_REVISION" != "$LATEST_CREATED_REVISION" ]]; then
  echo "Cloud Run latest revision is not ready" >&2
  echo "latestCreated=${LATEST_CREATED_REVISION:-<none>} latestReady=${LATEST_READY_REVISION:-<none>}" >&2
  exit 1
fi

# Prove the shadow surface is still private from an external caller. Cloud Run
# rejects an unauthenticated request before it reaches the application.
UNAUTHENTICATED_STATUS="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "${SERVICE_URL}/health")"
if [[ "$UNAUTHENTICATED_STATUS" != "403" ]]; then
  echo "Expected private Cloud Run service to reject unauthenticated /health with 403; got ${UNAUTHENTICATED_STATUS}" >&2
  exit 1
fi

printf '%s\n' \
  "Overcenter GCP shadow runtime ready" \
  "Project:          ${PROJECT_ID}" \
  "Region:           ${REGION}" \
  "Service:          ${SERVICE}" \
  "Revision:         ${LATEST_READY_REVISION}" \
  "Runtime identity: ${RUNTIME_SA}" \
  "Cloud SQL:        ${CONNECTION_NAME}" \
  "URL:              ${SERVICE_URL}" \
  "Health:           Cloud Run /health startup probe passed (Postgres SELECT 1)" \
  "Exposure:         private (unauthenticated /health returned 403)"
