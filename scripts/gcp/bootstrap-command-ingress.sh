#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-project-6b810532-a302-48dc-b56}"
REGION="${GCP_REGION:-us-west1}"
INGRESS_SA_NAME="${OVERCENTER_COMMAND_INGRESS_SERVICE_ACCOUNT_NAME:-overcenter-command-ingress}"
DEPLOYER_SA_NAME="${GCP_DEPLOYER_SERVICE_ACCOUNT_NAME:-overcenter-deployer}"
TARGET_SERVICE="${OVERCENTER_TARGET_SERVICE:-overcenter-shadow}"

for command in gcloud python3; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required" >&2
    exit 2
  fi
done

if [[ -z "$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n1)" ]]; then
  echo "gcloud must have an active administrator identity before bootstrap" >&2
  exit 2
fi

gcloud config set project "$PROJECT_ID" >/dev/null
INGRESS_SA="${INGRESS_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOYER_SA="${DEPLOYER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

if ! gcloud iam service-accounts describe "$INGRESS_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$INGRESS_SA_NAME" \
    --project="$PROJECT_ID" \
    --display-name="Overcenter stateless command ingress"
fi

# The recurring GitHub deployer may attach this one identity to the ingress
# service, but receives no permission to mint tokens as it or edit its policy.
gcloud iam service-accounts add-iam-policy-binding "$INGRESS_SA" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${DEPLOYER_SA}" \
  --role="roles/iam.serviceAccountUser" >/dev/null

# The ingress runtime may invoke only the authoritative Cloud Run service.
# Do not grant project-wide run.invoker or any database/secret role.
gcloud run services add-iam-policy-binding "$TARGET_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --member="serviceAccount:${INGRESS_SA}" \
  --role="roles/run.invoker" >/dev/null

PROJECT_POLICY="${TMPDIR:-/tmp}/overcenter-command-ingress-project-policy.json"
gcloud projects get-iam-policy "$PROJECT_ID" --format=json > "$PROJECT_POLICY"
python3 - "$PROJECT_POLICY" "serviceAccount:${INGRESS_SA}" <<'PY'
import json,sys
path,member=sys.argv[1:]
with open(path, encoding='utf-8') as f: policy=json.load(f)
roles=[]
for binding in policy.get('bindings') or []:
    if member in (binding.get('members') or []):
        roles.append(str(binding.get('role') or ''))
if roles:
    raise SystemExit(f'ingress identity unexpectedly has project-level IAM roles: {sorted(roles)}')
PY

TARGET_POLICY="${TMPDIR:-/tmp}/overcenter-command-ingress-target-policy.json"
gcloud run services get-iam-policy "$TARGET_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format=json > "$TARGET_POLICY"
python3 - "$TARGET_POLICY" "serviceAccount:${INGRESS_SA}" <<'PY'
import json,sys
path,member=sys.argv[1:]
with open(path, encoding='utf-8') as f: policy=json.load(f)
roles=sorted(str(binding.get('role') or '') for binding in (policy.get('bindings') or []) if member in (binding.get('members') or []))
if roles != ['roles/run.invoker']:
    raise SystemExit(f'ingress target IAM must be exactly roles/run.invoker; observed {roles}')
PY

printf '%s\n' \
  "Overcenter command ingress identity bootstrap complete" \
  "Ingress identity: ${INGRESS_SA}" \
  "Deployer actAs:   ${DEPLOYER_SA}" \
  "Target service:   ${TARGET_SERVICE}" \
  "Project roles:    none" \
  "Target role:      roles/run.invoker"
