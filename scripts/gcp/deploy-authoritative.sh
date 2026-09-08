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
GITHUB_APP_ID_VALUE="${OVERCENTER_GITHUB_APP_ID:-4616688}"
GITHUB_APP_PRIVATE_KEY_SECRET="${OVERCENTER_GITHUB_APP_PRIVATE_KEY_SECRET:-overcenter-github-app-private-key}"
EXACT_REVISION="${EXACT_REVISION:?EXACT_REVISION is required}"

if [[ ! "$EXACT_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "EXACT_REVISION must be a lowercase 40-character Git SHA" >&2
  exit 2
fi
if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
gcloud config set project "$PROJECT_ID" >/dev/null
TMP="${RUNNER_TEMP:-/tmp}/overcenter-authoritative-deploy.json"

describe() {
  gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format=json > "$TMP"
}

env_value() {
  python3 - "$TMP" "$1" <<'PY'
import json,sys
name=sys.argv[2]
with open(sys.argv[1], encoding='utf-8') as f: body=json.load(f)
env=((body.get('spec') or {}).get('template') or {}).get('spec',{}).get('containers',[{}])[0].get('env',[])
for item in env:
    if item.get('name') == name:
        print(item.get('value',''))
        break
else:
    print('')
PY
}

field() {
  python3 - "$TMP" "$1" <<'PY'
import json,sys
path=sys.argv[2]
with open(sys.argv[1], encoding='utf-8') as f: value=json.load(f)
for part in path.split('.'):
    value=value.get(part) if isinstance(value, dict) else None
print('' if value is None else value)
PY
}

emit_startup_failure_diagnostics() {
  local failed_revision="$1"
  echo "Authoritative Cloud Run deployment failed before readiness." >&2
  if [[ -z "$failed_revision" ]]; then
    echo "No failed revision identity could be read back from Cloud Run." >&2
    return 0
  fi

  echo "Failed revision: $failed_revision" >&2
  echo "=== Cloud Run revision conditions ===" >&2
  gcloud run revisions describe "$failed_revision" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --format='yaml(status.conditions,status.logUrl)' >&2 || true

  echo "=== Cloud Run revision startup logs ===" >&2
  gcloud logging read \
    "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\" AND resource.labels.revision_name=\"$failed_revision\"" \
    --project="$PROJECT_ID" \
    --limit=100 \
    --freshness=30m \
    --order=asc \
    --format='value(timestamp,severity,textPayload,jsonPayload.message)' >&2 || true
}

describe
BEFORE_READY="$(field status.latestReadyRevisionName)"
BEFORE_CREATED="$(field status.latestCreatedRevisionName)"
BEFORE_MODE="$(env_value OVERCENTER_AUTHORITY_MODE)"
BEFORE_SOURCE="$(env_value OVERCENTER_SOURCE_REVISION)"
BEFORE_FREEZE="$(env_value OVERCENTER_SOURCE_FREEZE_DIGEST)"

if [[ -z "$BEFORE_READY" || "$BEFORE_READY" != "$BEFORE_CREATED" ]]; then
  echo "Cloud Run has no single ready latest revision before deployment" >&2
  exit 1
fi
if [[ "$BEFORE_MODE" != "authoritative" ]]; then
  echo "refusing deployment because current GCP runtime is not authoritative: ${BEFORE_MODE:-<none>}" >&2
  exit 1
fi
if [[ ! "$BEFORE_SOURCE" =~ ^[0-9a-f]{40}$ ]]; then
  echo "current GCP runtime has no exact source revision" >&2
  exit 1
fi
if [[ ! "$BEFORE_FREEZE" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "current GCP runtime has no sealed source-freeze digest" >&2
  exit 1
fi

# The current authoritative epoch is a precondition, not an input to choose.
# Preserve that epoch while replacing only the source artifact/revision.
set +e
gcloud run deploy "$SERVICE" \
  --source . \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --service-account="$RUNTIME_SA" \
  --add-cloudsql-instances="$CONNECTION_NAME" \
  --set-env-vars="PGHOST=/cloudsql/${CONNECTION_NAME},PGDATABASE=${DB_NAME},PGUSER=${DB_USER},GITHUB_APP_ID=${GITHUB_APP_ID_VALUE},OVERCENTER_AUTHORITY_MODE=authoritative,OVERCENTER_SOURCE_REVISION=${EXACT_REVISION},OVERCENTER_SOURCE_FREEZE_DIGEST=${BEFORE_FREEZE}" \
  --set-secrets="PGPASSWORD=${PASSWORD_SECRET}:latest,GITHUB_APP_PRIVATE_KEY=${GITHUB_APP_PRIVATE_KEY_SECRET}:latest" \
  --startup-probe="httpGet.path=/health,httpGet.port=8080,initialDelaySeconds=0,failureThreshold=12,timeoutSeconds=3,periodSeconds=5" \
  --no-allow-unauthenticated \
  --min-instances=0 \
  --max-instances=1 \
  --quiet
DEPLOY_STATUS=$?
set -e

if [[ "$DEPLOY_STATUS" -ne 0 ]]; then
  FAILED_CREATED=""
  if describe; then
    FAILED_CREATED="$(field status.latestCreatedRevisionName)"
  fi
  emit_startup_failure_diagnostics "$FAILED_CREATED"
  exit "$DEPLOY_STATUS"
fi

describe
AFTER_READY="$(field status.latestReadyRevisionName)"
AFTER_CREATED="$(field status.latestCreatedRevisionName)"
AFTER_MODE="$(env_value OVERCENTER_AUTHORITY_MODE)"
AFTER_SOURCE="$(env_value OVERCENTER_SOURCE_REVISION)"
AFTER_FREEZE="$(env_value OVERCENTER_SOURCE_FREEZE_DIGEST)"
SERVICE_URL="$(field status.url)"

if [[ -z "$AFTER_READY" || "$AFTER_READY" != "$AFTER_CREATED" ]]; then
  echo "authoritative Cloud Run deployment did not become ready" >&2
  exit 1
fi
if [[ "$AFTER_MODE" != "authoritative" || "$AFTER_SOURCE" != "$EXACT_REVISION" || "$AFTER_FREEZE" != "$BEFORE_FREEZE" ]]; then
  echo "authoritative deployment readback mismatch" >&2
  exit 1
fi
if [[ -z "$SERVICE_URL" ]]; then
  echo "Cloud Run deployment returned no service URL" >&2
  exit 1
fi

UNAUTHENTICATED_STATUS="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "${SERVICE_URL}/health")"
if [[ "$UNAUTHENTICATED_STATUS" != "403" ]]; then
  echo "Expected private Cloud Run service to reject unauthenticated /health with 403; got ${UNAUTHENTICATED_STATUS}" >&2
  exit 1
fi

printf '%s\n' \
  "Overcenter GCP authoritative runtime deployed" \
  "Source revision:  ${AFTER_SOURCE}" \
  "Source freeze:    ${AFTER_FREEZE}" \
  "Before revision:  ${BEFORE_READY}" \
  "After revision:   ${AFTER_READY}" \
  "Authority mode:   ${AFTER_MODE}" \
  "Exposure:         private (unauthenticated /health returned 403)"
