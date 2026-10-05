#!/usr/bin/env bash
set -euo pipefail

# One-time IAM bootstrap for the GCP GitHub runner launcher.
#
# Run this as a Google Cloud project administrator. Recurring runner deployment
# intentionally does not create service accounts or grant project/service-account IAM.

PROJECT_ID="${GCP_PROJECT_ID:-project-6b810532-a302-48dc-b56}"
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
  echo "ERROR: no active gcloud administrator account" >&2
  exit 2
fi

printf '%s\n' \
  "Bootstrapping GCP runner launcher IAM" \
  "Project:          $PROJECT_ID" \
  "Administrator:    $active_account" \
  "Launcher identity: $LAUNCHER_SA" \
  "Build identity:    $RUNTIME_SA" \
  "Recurring deployer: $DEPLOYER_SA"

if ! gcloud iam service-accounts describe "$LAUNCHER_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$LAUNCHER_SA_NAME" \
    --project="$PROJECT_ID" \
    --display-name="Overcenter GCP runner launcher"
fi

# The private launcher may create/read/cancel only Cloud Build executions.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${LAUNCHER_SA}" \
  --role="roles/cloudbuild.builds.editor" \
  --condition=None \
  --quiet >/dev/null

# Cloud Build callers may need serviceusage.services.use on the project.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${LAUNCHER_SA}" \
  --role="roles/serviceusage.serviceUsageConsumer" \
  --condition=None \
  --quiet >/dev/null

# Builds run as the existing runtime identity, which already owns the bounded
# build-time GitHub App secret access. The launcher itself receives no secret.
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${LAUNCHER_SA}" \
  --role="roles/iam.serviceAccountUser" \
  --condition=None \
  --quiet >/dev/null

# The recurring deployer may attach only the dedicated launcher identity to the
# private Cloud Run service. It does not gain service-account administration.
gcloud iam service-accounts add-iam-policy-binding "$LAUNCHER_SA" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${DEPLOYER_SA}" \
  --role="roles/iam.serviceAccountUser" \
  --condition=None \
  --quiet >/dev/null

project_policy="$(mktemp)"
runtime_policy="$(mktemp)"
launcher_policy="$(mktemp)"
trap 'rm -f "$project_policy" "$runtime_policy" "$launcher_policy"' EXIT

gcloud projects get-iam-policy "$PROJECT_ID" --format=json > "$project_policy"
gcloud iam service-accounts get-iam-policy "$RUNTIME_SA" \
  --project="$PROJECT_ID" --format=json > "$runtime_policy"
gcloud iam service-accounts get-iam-policy "$LAUNCHER_SA" \
  --project="$PROJECT_ID" --format=json > "$launcher_policy"

python3 - "$project_policy" "$runtime_policy" "$launcher_policy" \
  "$LAUNCHER_SA" "$RUNTIME_SA" "$DEPLOYER_SA" <<'PY'
import json
import sys

project_path, runtime_path, launcher_path, launcher_sa, runtime_sa, deployer_sa = sys.argv[1:]

with open(project_path, encoding="utf-8") as handle:
    project = json.load(handle)
with open(runtime_path, encoding="utf-8") as handle:
    runtime = json.load(handle)
with open(launcher_path, encoding="utf-8") as handle:
    launcher = json.load(handle)

def has_binding(policy, role, member):
    return any(
        binding.get("role") == role and member in (binding.get("members") or [])
        for binding in policy.get("bindings") or []
    )

launcher_member = "serviceAccount:" + launcher_sa
deployer_member = "serviceAccount:" + deployer_sa

required_project_roles = (
    "roles/cloudbuild.builds.editor",
    "roles/serviceusage.serviceUsageConsumer",
)
for role in required_project_roles:
    if not has_binding(project, role, launcher_member):
        raise SystemExit(f"launcher missing project role: {role}")

if not has_binding(runtime, "roles/iam.serviceAccountUser", launcher_member):
    raise SystemExit("launcher cannot act as bounded Cloud Build runtime identity")

if not has_binding(launcher, "roles/iam.serviceAccountUser", deployer_member):
    raise SystemExit("recurring deployer cannot attach dedicated launcher identity")

print("Runner launcher IAM bootstrap readback: PASS")
print(f"Launcher identity: {launcher_sa}")
print(f"Build identity:    {runtime_sa}")
PY
