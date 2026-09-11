#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-project-6b810532-a302-48dc-b56}"
REGION="${GCP_REGION:-us-west1}"
INGRESS_SERVICE="${OVERCENTER_COMMAND_INGRESS_SERVICE:-overcenter-command-ingress}"
INGRESS_SA_NAME="${OVERCENTER_COMMAND_INGRESS_SERVICE_ACCOUNT_NAME:-overcenter-command-ingress}"
TARGET_SERVICE="${OVERCENTER_TARGET_SERVICE:-overcenter-shadow}"
EXPECTED_GITHUB_APP_ID="${OVERCENTER_GITHUB_APP_ID:-4616688}"

for command in gcloud python3 curl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required" >&2
    exit 2
  fi
done

if [[ ! "$EXPECTED_GITHUB_APP_ID" =~ ^[0-9]+$ ]]; then
  echo "OVERCENTER_GITHUB_APP_ID must be numeric" >&2
  exit 2
fi

gcloud config set project "$PROJECT_ID" >/dev/null
ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n1)"
if [[ -z "$ACTIVE_ACCOUNT" ]]; then
  echo "an authenticated GCP deploy identity is required" >&2
  exit 2
fi

TARGET_URL="$(gcloud run services describe "$TARGET_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format='value(status.url)')"
if [[ ! "$TARGET_URL" =~ ^https:// ]]; then
  echo "authoritative target service returned no HTTPS URL" >&2
  exit 1
fi

INGRESS_SA="${INGRESS_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$INGRESS_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
  cat >&2 <<EOF
COMMAND_INGRESS_IDENTITY_BOOTSTRAP_REQUIRED
Dedicated ingress identity is not available to the deployer:
  ${INGRESS_SA}
Run scripts/gcp/bootstrap-command-ingress.sh once with a GCP administrator identity.
Recurring GitHub Actions deployment intentionally cannot create service accounts or edit IAM.
EOF
  exit 3
fi

gcloud run deploy "$INGRESS_SERVICE" \
  --source . \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --service-account="$INGRESS_SA" \
  --set-env-vars="OVERCENTER_TARGET_AUDIENCE=${TARGET_URL},OVERCENTER_GITHUB_APP_ID=${EXPECTED_GITHUB_APP_ID}" \
  --command=/cnb/lifecycle/launcher \
  --args="--,node,scripts/cloud-run-command-ingress.mjs" \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=2 \
  --quiet

INGRESS_JSON="${RUNNER_TEMP:-/tmp}/overcenter-command-ingress.json"
gcloud run services describe "$INGRESS_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format=json > "$INGRESS_JSON"

INGRESS_URL="$(python3 - "$INGRESS_JSON" <<'PY'
import json,sys
with open(sys.argv[1], encoding='utf-8') as f: body=json.load(f)
print(((body.get('status') or {}).get('url') or '').strip())
PY
)"
if [[ ! "$INGRESS_URL" =~ ^https:// ]]; then
  echo "command ingress deployment returned no HTTPS URL" >&2
  exit 1
fi

python3 - "$INGRESS_JSON" "$INGRESS_SA" "$TARGET_URL" "$EXPECTED_GITHUB_APP_ID" <<'PY'
import json,sys
path,expected_sa,target_url,app_id=sys.argv[1:]
with open(path, encoding='utf-8') as f: body=json.load(f)
template=((body.get('spec') or {}).get('template') or {}).get('spec') or {}
actual_sa=str(template.get('serviceAccountName') or '')
if actual_sa != expected_sa:
    raise SystemExit(f'ingress service account mismatch: {actual_sa!r}')
containers=template.get('containers') or [{}]
env={str(item.get('name')): item for item in (containers[0].get('env') or []) if item.get('name')}
for forbidden in ('PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','DATABASE_URL','GITHUB_APP_PRIVATE_KEY'):
    if forbidden in env:
        raise SystemExit(f'forbidden authoritative credential/config present on ingress: {forbidden}')
if (env.get('OVERCENTER_TARGET_AUDIENCE') or {}).get('value') != target_url:
    raise SystemExit('ingress target audience mismatch')
if str((env.get('OVERCENTER_GITHUB_APP_ID') or {}).get('value') or '') != app_id:
    raise SystemExit('ingress GitHub App identity mismatch')
annotations=(((body.get('spec') or {}).get('template') or {}).get('metadata') or {}).get('annotations') or {}
if any('cloudsql' in str(k).lower() or 'cloudsql' in str(v).lower() for k,v in annotations.items()):
    raise SystemExit('ingress must not have a Cloud SQL attachment')
volumes=template.get('volumes') or []
if any('cloudsql' in json.dumps(volume).lower() for volume in volumes):
    raise SystemExit('ingress must not have a Cloud SQL volume')
PY

TARGET_UNAUTH_STATUS="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "${TARGET_URL}/health")"
if [[ "$TARGET_UNAUTH_STATUS" != "403" ]]; then
  echo "authoritative target must remain private; unauthenticated /health returned $TARGET_UNAUTH_STATUS" >&2
  exit 1
fi

INGRESS_UNAUTH_STATUS="$(curl --silent --show-error --output "$RUNNER_TEMP/ingress-unauth.json" --write-out '%{http_code}' \
  -H 'content-type: application/json' \
  -X POST \
  -d '{"command":"project.inspect","input":{"project_ref":"github:laurajoyhutchins/overcenter"}}' \
  "${INGRESS_URL}/")"
if [[ "$INGRESS_UNAUTH_STATUS" != "401" ]]; then
  cat "$RUNNER_TEMP/ingress-unauth.json" >&2 || true
  echo "command ingress must reject missing GitHub App identity before dispatch; got $INGRESS_UNAUTH_STATUS" >&2
  exit 1
fi

printf '%s\n' \
  "Overcenter stateless command ingress deployed" \
  "Source revision:  ${GITHUB_SHA:-unknown}" \
  "Ingress URL:      ${INGRESS_URL}" \
  "Ingress identity: ${INGRESS_SA}" \
  "Target URL:       ${TARGET_URL}" \
  "Target exposure:  private (unauthenticated /health returned 403)" \
  "Ingress DB access: none configured"
