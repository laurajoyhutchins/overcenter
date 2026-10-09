#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${GCP_REGION:?GCP_REGION is required}"
: "${GCP_ZONE:?GCP_ZONE is required}"
: "${OVERCENTER_SOURCE_REVISION:?OVERCENTER_SOURCE_REVISION is required}"
: "${OVERCENTER_RUNNER_CONTROL_IMAGE:?OVERCENTER_RUNNER_CONTROL_IMAGE is required}"
: "${OVERCENTER_RUNNER_IMAGE:?OVERCENTER_RUNNER_IMAGE is required}"

PROJECT_ID="$GCP_PROJECT_ID"
REGION="$GCP_REGION"
ZONE="$GCP_ZONE"
REVISION="$OVERCENTER_SOURCE_REVISION"
CONTROL_IMAGE="$OVERCENTER_RUNNER_CONTROL_IMAGE"
RUNNER_IMAGE="$OVERCENTER_RUNNER_IMAGE"
TOPIC="overcenter-gce-runners"
SUBSCRIPTION="overcenter-gce-runners"
NETWORK="overcenter-gce-runners"
SUBNET="overcenter-gce-runners-${REGION}"
ROUTER="overcenter-gce-runners-${REGION}"
NAT="overcenter-gce-runners-${REGION}"
MIG="overcenter-gce-runners"
RUNTIME_SA="overcenter-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
LAUNCHER_SA="overcenter-runner-launcher@${PROJECT_ID}.iam.gserviceaccount.com"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ ! "$REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "OVERCENTER_SOURCE_REVISION must be an exact lowercase Git SHA" >&2
  exit 2
fi
image_prefix="${REGION}-docker.pkg.dev/${PROJECT_ID}/"
for image in "$CONTROL_IMAGE" "$RUNNER_IMAGE"; do
  if [[ "$image" != "$image_prefix"* ]] || [[ ! "$image" =~ @sha256:[0-9a-f]{64}$ ]]; then
    echo "runner warm-pool images must be immutable Artifact Registry digests in the project region" >&2
    exit 2
  fi
done

for command in gcloud python3; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "required command missing: $command" >&2
    exit 2
  }
done

gcloud config set project "$PROJECT_ID" >/dev/null
active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n1 || true)"
if [[ -z "$active_account" ]]; then
  echo "no active Google Cloud administrator account" >&2
  exit 2
fi

printf '%s\n'   "Bootstrapping warm GCE runner pool"   "Project:       $PROJECT_ID"   "Administrator: $active_account"   "Region:        $REGION"   "Zone:          $ZONE"   "Revision:      $REVISION"

gcloud services enable compute.googleapis.com pubsub.googleapis.com   --project="$PROJECT_ID" --quiet

if ! gcloud pubsub topics describe "$TOPIC" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud pubsub topics create "$TOPIC" --project="$PROJECT_ID"
fi
if ! gcloud pubsub subscriptions describe "$SUBSCRIPTION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud pubsub subscriptions create "$SUBSCRIPTION"     --project="$PROJECT_ID"     --topic="$TOPIC"     --ack-deadline=120
fi

gcloud pubsub topics add-iam-policy-binding "$TOPIC"   --project="$PROJECT_ID"   --member="serviceAccount:${LAUNCHER_SA}"   --role="roles/pubsub.publisher"   --quiet >/dev/null

gcloud pubsub subscriptions add-iam-policy-binding "$SUBSCRIPTION"   --project="$PROJECT_ID"   --member="serviceAccount:${RUNTIME_SA}"   --role="roles/pubsub.subscriber"   --quiet >/dev/null

if ! gcloud compute networks describe "$NETWORK" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute networks create "$NETWORK"     --project="$PROJECT_ID"     --subnet-mode=custom
fi
if ! gcloud compute networks subnets describe "$SUBNET"   --project="$PROJECT_ID" --region="$REGION" >/dev/null 2>&1; then
  gcloud compute networks subnets create "$SUBNET"     --project="$PROJECT_ID"     --network="$NETWORK"     --region="$REGION"     --range=10.42.0.0/24     --enable-private-ip-google-access
fi
if ! gcloud compute routers describe "$ROUTER"   --project="$PROJECT_ID" --region="$REGION" >/dev/null 2>&1; then
  gcloud compute routers create "$ROUTER"     --project="$PROJECT_ID"     --network="$NETWORK"     --region="$REGION"
fi
if ! gcloud compute routers nats describe "$NAT"   --project="$PROJECT_ID" --router="$ROUTER" --region="$REGION" >/dev/null 2>&1; then
  gcloud compute routers nats create "$NAT"     --project="$PROJECT_ID"     --router="$ROUTER"     --region="$REGION"     --nat-all-subnet-ip-ranges     --auto-allocate-nat-external-ips
fi

runner_repository="${REGION}-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy"
runner_repository_policy="$(mktemp)"
secret_policy="$(mktemp)"
startup_script="$(mktemp)"
topic_policy="$(mktemp)"
subscription_policy="$(mktemp)"
trap 'rm -f "$runner_repository_policy" "$secret_policy" "$startup_script" "$topic_policy" "$subscription_policy"' EXIT

gcloud artifacts repositories get-iam-policy cloud-run-source-deploy   --project="$PROJECT_ID"   --location="$REGION"   --format=json > "$runner_repository_policy"

gcloud secrets get-iam-policy overcenter-github-app-private-key   --project="$PROJECT_ID"   --format=json > "$secret_policy"

python3 - "$runner_repository_policy" "$secret_policy" "$RUNTIME_SA" <<'PY'
import json
import sys

repository_path, secret_path, runtime_sa = sys.argv[1:]
member = "serviceAccount:" + runtime_sa

def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)

def has(policy, role):
    return any(
        binding.get("role") == role and member in (binding.get("members") or [])
        for binding in policy.get("bindings") or []
    )

if not has(load(repository_path), "roles/artifactregistry.reader"):
    raise SystemExit("runtime identity lacks Artifact Registry reader on runner repository")
if not has(load(secret_path), "roles/secretmanager.secretAccessor"):
    raise SystemExit("runtime identity lacks existing GitHub App secret accessor authority")
PY

{
  printf '#!/usr/bin/env bash\n'
  printf 'export GCP_PROJECT_ID=%q\n' "$PROJECT_ID"
  printf 'export OVERCENTER_RUNNER_CONTROL_IMAGE=%q\n' "$CONTROL_IMAGE"
  printf 'export OVERCENTER_RUNNER_IMAGE=%q\n' "$RUNNER_IMAGE"
  printf 'export OVERCENTER_RUNNER_SUBSCRIPTION=%q\n' "$SUBSCRIPTION"
  tail -n +2 "$ROOT/infra/gcp/start-runner-warm-host.sh"
} > "$startup_script"

startup_hash="$(python3 - "$startup_script" <<'PY'
import hashlib, pathlib, sys
print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest()[:12])
PY
)"
template="overcenter-gce-runner-${REVISION:0:12}-${startup_hash}"
if ! gcloud compute instance-templates describe "$template" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute instance-templates create "$template"     --project="$PROJECT_ID"     --machine-type=e2-standard-4     --image-family=cos-stable     --image-project=cos-cloud     --boot-disk-size=30GB     --boot-disk-type=pd-balanced     --service-account="$RUNTIME_SA"     --scopes=https://www.googleapis.com/auth/cloud-platform     --metadata-from-file="startup-script=$startup_script"     --network-interface="network=$NETWORK,subnet=https://www.googleapis.com/compute/v1/projects/$PROJECT_ID/regions/$REGION/subnetworks/$SUBNET,no-address"     --shielded-secure-boot
fi

if ! gcloud compute instance-groups managed describe "$MIG"   --project="$PROJECT_ID" --zone="$ZONE" >/dev/null 2>&1; then
  gcloud compute instance-groups managed create "$MIG"     --project="$PROJECT_ID"     --zone="$ZONE"     --base-instance-name=overcenter-gce-runner     --size=1     --template="$template"
else
  gcloud compute instance-groups managed rolling-action start-update "$MIG"     --project="$PROJECT_ID"     --zone="$ZONE"     --version="template=$template"     --max-surge=1     --max-unavailable=0
fi

gcloud compute instance-groups managed wait-until "$MIG"   --project="$PROJECT_ID"   --zone="$ZONE"   --stable   --timeout=600

gcloud pubsub topics get-iam-policy "$TOPIC"   --project="$PROJECT_ID" --format=json > "$topic_policy"
gcloud pubsub subscriptions get-iam-policy "$SUBSCRIPTION"   --project="$PROJECT_ID" --format=json > "$subscription_policy"

python3 - "$topic_policy" "$subscription_policy" "$LAUNCHER_SA" "$RUNTIME_SA" <<'PY'
import json
import sys

topic_path, subscription_path, launcher_sa, runtime_sa = sys.argv[1:]

def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)

def has(policy, role, member):
    return any(
        binding.get("role") == role and member in (binding.get("members") or [])
        for binding in policy.get("bindings") or []
    )

if not has(load(topic_path), "roles/pubsub.publisher", "serviceAccount:" + launcher_sa):
    raise SystemExit("launcher is not the warm-runner topic publisher")
if not has(
    load(subscription_path),
    "roles/pubsub.subscriber",
    "serviceAccount:" + runtime_sa,
):
    raise SystemExit("runtime identity is not the warm-runner subscription consumer")
PY

mig_json="$(mktemp)"
trap 'rm -f "$runner_repository_policy" "$secret_policy" "$startup_script" "$topic_policy" "$subscription_policy" "$mig_json"' EXIT
gcloud compute instance-groups managed describe "$MIG"   --project="$PROJECT_ID"   --zone="$ZONE"   --format=json > "$mig_json"

python3 - "$mig_json" "$template" <<'PY'
import json
import sys

path, template = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    body = json.load(handle)
if int(body.get("targetSize") or 0) != 1:
    raise SystemExit("warm runner MIG target size is not exactly one")
instance_template = str(body.get("instanceTemplate") or "")
if not instance_template.endswith("/" + template):
    raise SystemExit("warm runner MIG template readback mismatch")
PY

printf '%s\n'   "Warm GCE runner pool bootstrap: PASS"   "Network:      $NETWORK (no ingress rules)"   "Egress:       Cloud NAT $NAT"   "Topic:        $TOPIC"   "Subscription: $SUBSCRIPTION"   "MIG:          $MIG target=1"   "Template:     $template"   "Runtime:      $RUNTIME_SA"
