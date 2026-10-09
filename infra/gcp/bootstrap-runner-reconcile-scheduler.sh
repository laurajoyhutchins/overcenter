#!/usr/bin/env bash
set -euo pipefail

# Owner-only provisioning. Ordinary runner deployment never grants IAM or creates jobs.
: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${GCP_REGION:?GCP_REGION is required}"
PROJECT_ID="$GCP_PROJECT_ID"
REGION="$GCP_REGION"
SERVICE="overcenter-github-runner-autoscaler"
JOB="overcenter-runner-reconcile"
SCHEDULER_SA="overcenter-runner-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"
JOB_JSON="$(mktemp)"
POLICY_JSON="$(mktemp)"
trap 'rm -f "$JOB_JSON" "$POLICY_JSON"' EXIT

for command in gcloud python3; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command is required" >&2; exit 2; }
done

service_url="$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"
[[ "$service_url" == https://* ]] || { echo "private autoscaler service URL missing" >&2; exit 1; }

# Enabling the service and creating the dedicated principal require owner approval.
gcloud services enable cloudscheduler.googleapis.com --project="$PROJECT_ID" --quiet
if ! gcloud iam service-accounts describe "$SCHEDULER_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create overcenter-runner-scheduler --project="$PROJECT_ID" \
    --display-name="Overcenter runner reconcile invoker"
fi

gcloud run services add-iam-policy-binding "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
  --member="serviceAccount:$SCHEDULER_SA" --role=roles/run.invoker --quiet >/dev/null
gcloud run services get-iam-policy "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format=json > "$POLICY_JSON"

python3 - "$POLICY_JSON" "$SCHEDULER_SA" <<'PY'
import json
import sys

path, service_account = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    policy = json.load(handle)
bindings = policy.get("bindings") or []
if not any(
    binding.get("role") == "roles/run.invoker"
    and "serviceAccount:" + service_account in (binding.get("members") or [])
    for binding in bindings
):
    raise SystemExit("Scheduler lacks resource-scoped Cloud Run invocation")
if any(
    member in ("allUsers", "allAuthenticatedUsers")
    for binding in bindings
    for member in (binding.get("members") or [])
):
    raise SystemExit("autoscaler service is not private")
PY

if gcloud scheduler jobs describe "$JOB" --project="$PROJECT_ID" --location="$REGION" --format=json > "$JOB_JSON" 2>/dev/null; then
  echo "Scheduler job exists; checking exact configuration without rewriting it"
else
  gcloud scheduler jobs create http "$JOB" --project="$PROJECT_ID" --location="$REGION" \
    --schedule='* * * * *' --time-zone='Etc/UTC' --http-method=POST \
    --uri="${service_url}/reconcile" \
    --oidc-service-account-email="$SCHEDULER_SA" \
    --oidc-token-audience="$service_url" --quiet
  gcloud scheduler jobs describe "$JOB" --project="$PROJECT_ID" --location="$REGION" --format=json > "$JOB_JSON"
fi

python3 - "$JOB_JSON" "$service_url" "$SCHEDULER_SA" <<'PY'
import json
import sys

path, url, service_account = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    job = json.load(handle)
target = job.get("httpTarget") or {}
oidc = target.get("oidcToken") or {}
if not (
    job.get("state") == "ENABLED"
    and job.get("schedule") == "* * * * *"
    and job.get("timeZone") == "Etc/UTC"
    and target.get("httpMethod") == "POST"
    and target.get("uri") == url + "/reconcile"
    and oidc.get("serviceAccountEmail") == service_account
    and oidc.get("audience") == url
):
    raise SystemExit("Scheduler job is not the exact authorized one-minute runner reconciler")
print("Authenticated private runner reconciliation Scheduler: PASS")
PY
