#!/usr/bin/env bash
set -euo pipefail

# One-time administrator bootstrap for the private GCP runner launcher.
# Recurring deployment intentionally does not create service accounts or mutate IAM.

PROJECT_ID="${GCP_PROJECT_ID:-project-6b810532-a302-48dc-b56}"
REGION="${GCP_REGION:-us-west1}"
LAUNCHER_SERVICE="${GCP_LAUNCHER_SERVICE:-overcenter-gcp-runner-launcher}"
LAUNCHER_SA_NAME="overcenter-runner-launcher"
LAUNCHER_SA="${LAUNCHER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_SA="overcenter-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOYER_SA="overcenter-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

for command in gcloud python3; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $command" >&2
    exit 2
  }
done

gcloud config set project "$PROJECT_ID" >/dev/null
active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n1 || true)"
if [[ -z "$active_account" ]]; then
  echo "ERROR: no active Google Cloud administrator account" >&2
  exit 2
fi

printf '%s\n' \
  "Bootstrapping GCP runner launcher IAM" \
  "Project:           $PROJECT_ID" \
  "Administrator:     $active_account" \
  "Launcher identity: $LAUNCHER_SA" \
  "Runtime observer:  $RUNTIME_SA" \
  "Recurring deployer:$DEPLOYER_SA"

if ! gcloud iam service-accounts describe "$LAUNCHER_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$LAUNCHER_SA_NAME" \
    --project="$PROJECT_ID" \
    --display-name="Overcenter GCP runner launcher"
fi

# The launcher may submit/read/cancel builds, but it receives no GitHub secret.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${LAUNCHER_SA}" \
  --role="roles/cloudbuild.builds.editor" \
  --condition=None \
  --quiet >/dev/null

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${LAUNCHER_SA}" \
  --role="roles/serviceusage.serviceUsageConsumer" \
  --condition=None \
  --quiet >/dev/null

# Each runner Cloud Build executes as the existing bounded runtime identity.
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${LAUNCHER_SA}" \
  --role="roles/iam.serviceAccountUser" \
  --condition=None \
  --quiet >/dev/null

# Recurring deployment may attach the dedicated launcher identity to Cloud Run.
gcloud iam service-accounts add-iam-policy-binding "$LAUNCHER_SA" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${DEPLOYER_SA}" \
  --role="roles/iam.serviceAccountUser" \
  --condition=None \
  --quiet >/dev/null

# The launcher service already exists from the bootstrap experiments. This
# service-specific binding is the only caller edge: runtime observer -> launcher.
if ! gcloud run services describe "$LAUNCHER_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" >/dev/null 2>&1; then
  echo "ERROR: launcher service does not exist yet: $LAUNCHER_SERVICE" >&2
  echo "Deploy the private service revision once, then rerun this bootstrap." >&2
  exit 2
fi

gcloud run services add-iam-policy-binding "$LAUNCHER_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/run.invoker" \
  --condition=None \
  --quiet >/dev/null

project_policy="$(mktemp)"
runtime_policy="$(mktemp)"
launcher_sa_policy="$(mktemp)"
launcher_service_policy="$(mktemp)"
trap 'rm -f "$project_policy" "$runtime_policy" "$launcher_sa_policy" "$launcher_service_policy"' EXIT

gcloud projects get-iam-policy "$PROJECT_ID" --format=json > "$project_policy"
gcloud iam service-accounts get-iam-policy "$RUNTIME_SA" \
  --project="$PROJECT_ID" --format=json > "$runtime_policy"
gcloud iam service-accounts get-iam-policy "$LAUNCHER_SA" \
  --project="$PROJECT_ID" --format=json > "$launcher_sa_policy"
gcloud run services get-iam-policy "$LAUNCHER_SERVICE" \
  --project="$PROJECT_ID" --region="$REGION" --format=json > "$launcher_service_policy"

python3 - "$project_policy" "$runtime_policy" "$launcher_sa_policy" "$launcher_service_policy" \
  "$LAUNCHER_SA" "$RUNTIME_SA" "$DEPLOYER_SA" <<'PY'
import json
import sys

(
    project_path,
    runtime_path,
    launcher_sa_path,
    launcher_service_path,
    launcher_sa,
    runtime_sa,
    deployer_sa,
) = sys.argv[1:]

def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)

def has_binding(policy, role, member):
    return any(
        binding.get("role") == role and member in (binding.get("members") or [])
        for binding in policy.get("bindings") or []
    )

project = load(project_path)
runtime = load(runtime_path)
launcher_sa_policy = load(launcher_sa_path)
launcher_service = load(launcher_service_path)

launcher_member = "serviceAccount:" + launcher_sa
runtime_member = "serviceAccount:" + runtime_sa
deployer_member = "serviceAccount:" + deployer_sa

for role in ("roles/cloudbuild.builds.editor", "roles/serviceusage.serviceUsageConsumer"):
    if not has_binding(project, role, launcher_member):
        raise SystemExit(f"launcher missing project role: {role}")

if not has_binding(runtime, "roles/iam.serviceAccountUser", launcher_member):
    raise SystemExit("launcher cannot act as bounded Cloud Build runtime identity")

if not has_binding(launcher_sa_policy, "roles/iam.serviceAccountUser", deployer_member):
    raise SystemExit("recurring deployer cannot attach dedicated launcher identity")

if not has_binding(launcher_service, "roles/run.invoker", runtime_member):
    raise SystemExit("runtime observer cannot invoke private launcher")

print("Runner launcher IAM bootstrap readback: PASS")
PY
