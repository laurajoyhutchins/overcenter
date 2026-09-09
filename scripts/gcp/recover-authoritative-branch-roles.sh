#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-project-6b810532-a302-48dc-b56}"
REGION="${GCP_REGION:-us-west1}"
SERVICE="${GCP_SERVICE:-overcenter-shadow}"
JOB="${OVERCENTER_BRANCH_ROLE_RECOVERY_JOB:-${SERVICE}-branch-role-recovery}"
CONNECTION_NAME="${CLOUD_SQL_CONNECTION_NAME:-project-6b810532-a302-48dc-b56:us-west1:overcenter-postgres}"
RUNTIME_SA="${OVERCENTER_RUNTIME_SERVICE_ACCOUNT:-overcenter-runtime@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com}"
DB_NAME="${PGDATABASE:-overcenter}"
DB_USER="${PGUSER:-overcenter}"
PASSWORD_SECRET="${OVERCENTER_DB_PASSWORD_SECRET:-overcenter-db-password}"
EXACT_REVISION="${EXACT_REVISION:?EXACT_REVISION is required}"

[[ "$EXACT_REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo 'EXACT_REVISION must be a lowercase 40-character Git SHA' >&2; exit 2; }
command -v gcloud >/dev/null 2>&1 || { echo 'gcloud is required' >&2; exit 2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
gcloud config set project "$PROJECT_ID" >/dev/null
SERVICE_JSON="${RUNNER_TEMP:-/tmp}/overcenter-recovery-service.json"
REVISION_JSON="${RUNNER_TEMP:-/tmp}/overcenter-recovery-revision.json"

gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format=json > "$SERVICE_JSON"
READY_REVISION="$(python3 - "$SERVICE_JSON" <<'PY'
import json,sys
with open(sys.argv[1], encoding='utf-8') as f: body=json.load(f)
print((body.get('status') or {}).get('latestReadyRevisionName') or '')
PY
)"
[[ -n "$READY_REVISION" ]] || { echo 'authoritative service has no ready revision' >&2; exit 1; }
gcloud run revisions describe "$READY_REVISION" --project="$PROJECT_ID" --region="$REGION" --format=json > "$REVISION_JSON"
readarray -t IDENTITY < <(python3 - "$REVISION_JSON" <<'PY'
import json,sys
with open(sys.argv[1], encoding='utf-8') as f: body=json.load(f)
env={item.get('name'):item.get('value','') for item in (body.get('spec') or {}).get('containers',[{}])[0].get('env',[])}
print(env.get('OVERCENTER_AUTHORITY_MODE',''))
print(env.get('OVERCENTER_SOURCE_REVISION',''))
print(env.get('OVERCENTER_SOURCE_FREEZE_DIGEST',''))
PY
)
MODE="${IDENTITY[0]:-}"
CURRENT_SOURCE="${IDENTITY[1]:-}"
FREEZE_DIGEST="${IDENTITY[2]:-}"
[[ "$MODE" == authoritative ]] || { echo "current ready GCP runtime is not authoritative: ${MODE:-<none>}" >&2; exit 1; }
[[ "$CURRENT_SOURCE" =~ ^[0-9a-f]{40}$ ]] || { echo 'current ready GCP runtime has no exact source revision' >&2; exit 1; }
[[ "$FREEZE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'current ready GCP runtime has no sealed source-freeze digest' >&2; exit 1; }

gcloud run jobs delete "$JOB" --project="$PROJECT_ID" --region="$REGION" --quiet >/dev/null 2>&1 || true
cleanup() { gcloud run jobs delete "$JOB" --project="$PROJECT_ID" --region="$REGION" --quiet >/dev/null 2>&1 || true; }
trap cleanup EXIT

gcloud run jobs deploy "$JOB" \
  --source . \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --service-account="$RUNTIME_SA" \
  --set-cloudsql-instances="$CONNECTION_NAME" \
  --set-env-vars="PGHOST=/cloudsql/${CONNECTION_NAME},PGDATABASE=${DB_NAME},PGUSER=${DB_USER},OVERCENTER_AUTHORITY_MODE=authoritative,OVERCENTER_SOURCE_REVISION=${EXACT_REVISION},OVERCENTER_SOURCE_FREEZE_DIGEST=${FREEZE_DIGEST}" \
  --set-secrets="PGPASSWORD=${PASSWORD_SECRET}:latest" \
  --command=/cnb/lifecycle/launcher \
  --args="--,node,scripts/cloud-run-recover-branch-roles.mjs" \
  --tasks=1 \
  --parallelism=1 \
  --max-retries=0 \
  --task-timeout=5m \
  --execute-now \
  --wait \
  --quiet

printf '%s\n' \
  'Overcenter GCP sealed branch-role recovery completed' \
  "Recovery source revision: $EXACT_REVISION" \
  "Authority revision before recovery: $CURRENT_SOURCE" \
  "Source freeze: $FREEZE_DIGEST"
