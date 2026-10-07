#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${GCP_REGION:?GCP_REGION is required}"
: "${EXACT_REVISION:?EXACT_REVISION is required}"

PROJECT_ID="$GCP_PROJECT_ID"
REGION="$GCP_REGION"
AUTOSCALER_SERVICE="overcenter-github-runner-autoscaler"
LAUNCHER_SERVICE="overcenter-gcp-runner-launcher"
RUNTIME_SA="overcenter-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOYER_SA="overcenter-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
LAUNCHER_SA="overcenter-runner-launcher@${PROJECT_ID}.iam.gserviceaccount.com"
RUNNER_IMAGE_REPO="${REGION}-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/overcenter-gcp-runner"
CONTROL_IMAGE_REPO="${REGION}-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/overcenter-gcp-runner-control"
CONTROL_IMAGE="${CONTROL_IMAGE_REPO}:git-${EXACT_REVISION}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ ! "$EXACT_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "EXACT_REVISION must be a lowercase 40-character Git SHA" >&2
  exit 2
fi

for command in curl gcloud python3; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required" >&2
    exit 2
  fi
done

cd "$ROOT"
test "$(git rev-parse HEAD)" = "$EXACT_REVISION"

runner_tree="$(git rev-parse "${EXACT_REVISION}:infra/gcp-runner-image")"
if [[ ! "$runner_tree" =~ ^[0-9a-f]{40,64}$ ]]; then
  echo "runner image source tree did not resolve to a Git object id" >&2
  exit 1
fi
RUNNER_IMAGE="${RUNNER_IMAGE_REPO}:tree-${runner_tree}"

runner_digest="$(
  gcloud artifacts docker images describe "$RUNNER_IMAGE" \
    --project="$PROJECT_ID" \
    --format='value(image_summary.digest)' 2>/dev/null || true
)"
if [[ "$runner_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Reusing immutable runner image for source tree ${runner_tree}"
else
  echo "Building immutable runner image for source tree ${runner_tree}"
  build_id="$(
    gcloud builds submit infra/gcp-runner-image \
      --async \
      --project="$PROJECT_ID" \
      --region="$REGION" \
      --tag="$RUNNER_IMAGE" \
      --format='value(id)'
  )"
  test -n "$build_id"

  build_status=""
  for _ in $(seq 1 300); do
    build_status="$(
      gcloud builds describe "$build_id" \
        --project="$PROJECT_ID" \
        --region="$REGION" \
        --format='value(status)'
    )"
    case "$build_status" in
      SUCCESS|FAILURE|INTERNAL_ERROR|TIMEOUT|CANCELLED|EXPIRED)
        break
        ;;
    esac
    sleep 2
  done
  if [[ "$build_status" != "SUCCESS" ]]; then
    echo "runner image build failed: $build_status" >&2
    gcloud builds describe "$build_id" \
      --project="$PROJECT_ID" \
      --region="$REGION" \
      --format='value(failureInfo.detail)' >&2 || true
    exit 1
  fi

  runner_digest="$(
    gcloud builds describe "$build_id" \
      --project="$PROJECT_ID" \
      --region="$REGION" \
      --format='value(results.images[0].digest)' | tail -n1
  )"
fi
if [[ ! "$runner_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "runner image resolution returned no immutable digest" >&2
  exit 1
fi
RUNNER_IMAGE_IMMUTABLE="${RUNNER_IMAGE_REPO}@${runner_digest}"
printf 'Runner image source tree: %s\n' "$runner_tree"
printf 'Runner image: %s\n' "$RUNNER_IMAGE_IMMUTABLE"

echo "Building immutable runner control image for ${EXACT_REVISION}"
control_build_id="$(
  gcloud builds submit . \
    --async \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --config=infra/gcp-runner-control/cloudbuild.yaml \
    --substitutions="_IMAGE=$CONTROL_IMAGE" \
    --format='value(id)'
)"
test -n "$control_build_id"

control_build_status=""
for _ in $(seq 1 300); do
  control_build_status="$(
    gcloud builds describe "$control_build_id" \
      --project="$PROJECT_ID" \
      --region="$REGION" \
      --format='value(status)'
  )"
  case "$control_build_status" in
    SUCCESS|FAILURE|INTERNAL_ERROR|TIMEOUT|CANCELLED|EXPIRED)
      break
      ;;
  esac
  sleep 2
done
if [[ "$control_build_status" != "SUCCESS" ]]; then
  echo "runner control image build failed: $control_build_status" >&2
  gcloud builds describe "$control_build_id" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --format='value(failureInfo.detail)' >&2 || true
  exit 1
fi

control_digest="$(
  gcloud builds describe "$control_build_id" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --format='value(results.images[0].digest)' | tail -n1
)"
if [[ ! "$control_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "runner control image build returned no immutable digest" >&2
  exit 1
fi
CONTROL_IMAGE_IMMUTABLE="${CONTROL_IMAGE_REPO}@${control_digest}"
printf 'Runner control image: %s\n' "$CONTROL_IMAGE_IMMUTABLE"

echo "Deploying private build launcher"
gcloud run deploy "$LAUNCHER_SERVICE" \
  --image="$CONTROL_IMAGE_IMMUTABLE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --service-account="$LAUNCHER_SA" \
  --set-env-vars="GCP_PROJECT_ID=${PROJECT_ID},GCP_REGION=${REGION},GCP_RUNNER_SERVICE_ACCOUNT=${RUNTIME_SA},OVERCENTER_RUNNER_IMAGE=${RUNNER_IMAGE_IMMUTABLE},OVERCENTER_RUNNER_CONFIG_PATH=config/gcp-runner-autoscaler.json,OVERCENTER_SOURCE_REVISION=${EXACT_REVISION}" \
  --command=node \
  --args="--experimental-strip-types,src/transport/gcp-runner-launcher.ts" \
  --startup-probe="httpGet.path=/health,httpGet.port=8080,initialDelaySeconds=0,failureThreshold=12,timeoutSeconds=3,periodSeconds=5" \
  --min=1 \
  --max=1 \
  --cpu-boost \
  --cpu=1 \
  --memory=256Mi \
  --quiet

launcher_json="${RUNNER_TEMP:-/tmp}/overcenter-gcp-runner-launcher.json"
gcloud run services describe "$LAUNCHER_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format=json > "$launcher_json"

launcher_url="$(
  python3 - "$launcher_json" "$LAUNCHER_SA" "$RUNTIME_SA" "$RUNNER_IMAGE_IMMUTABLE" "$CONTROL_IMAGE_IMMUTABLE" "$EXACT_REVISION" <<'PY'
import json
import sys

path, expected_sa, runner_sa, runner_image, control_image, expected_revision = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    body = json.load(handle)

service_annotations = (body.get("metadata") or {}).get("annotations") or {}
if str(service_annotations.get("run.googleapis.com/minScale") or "") != "1":
    raise SystemExit("runner launcher service minimum instances readback mismatch")
if str(service_annotations.get("run.googleapis.com/maxScale") or "") != "1":
    raise SystemExit("runner launcher service maximum instances readback mismatch")

template = ((body.get("spec") or {}).get("template") or {})
spec = template.get("spec") or {}
if spec.get("serviceAccountName") != expected_sa:
    raise SystemExit("runner launcher service account readback mismatch")

containers = spec.get("containers") or [{}]
if str(containers[0].get("image") or "") != control_image:
    raise SystemExit("runner launcher control image readback mismatch")
env = {
    str(item.get("name")): item
    for item in (containers[0].get("env") or [])
    if item.get("name")
}
expected = {
    "GCP_RUNNER_SERVICE_ACCOUNT": runner_sa,
    "OVERCENTER_RUNNER_IMAGE": runner_image,
    "OVERCENTER_SOURCE_REVISION": expected_revision,
}
for name, value in expected.items():
    if str((env.get(name) or {}).get("value") or "") != value:
        raise SystemExit(f"runner launcher {name} readback mismatch")

if any("valueFrom" in item for item in env.values()):
    raise SystemExit("runner launcher must not receive secret-backed environment variables")
if any("cloudsql" in json.dumps(value).lower() for value in (spec.get("volumes") or [])):
    raise SystemExit("runner launcher must not have a Cloud SQL attachment")

status = body.get("status") or {}
ready = str(status.get("latestReadyRevisionName") or "")
created = str(status.get("latestCreatedRevisionName") or "")
if not ready or ready != created:
    raise SystemExit("runner launcher deployment did not become ready")
url = str(status.get("url") or "")
if not url.startswith("https://"):
    raise SystemExit("runner launcher deployment returned no HTTPS URL")

print(url)
PY
)"

echo "Verifying pre-provisioned watcher invocation of the private launcher"
launcher_policy="${RUNNER_TEMP:-/tmp}/overcenter-gcp-runner-launcher-policy.json"
gcloud run services get-iam-policy "$LAUNCHER_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format=json > "$launcher_policy"
python3 - "$launcher_policy" "$RUNTIME_SA" <<'PY'
import json
import sys

path, runtime_sa = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    body = json.load(handle)
member = "serviceAccount:" + runtime_sa
if not any(
    binding.get("role") == "roles/run.invoker"
    and member in (binding.get("members") or [])
    for binding in body.get("bindings") or []
):
    raise SystemExit("runner launcher invoker binding readback mismatch")
PY

echo "Deploying private autoscaler service"
gcloud run deploy "$AUTOSCALER_SERVICE" \
  --image="$CONTROL_IMAGE_IMMUTABLE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --service-account="$RUNTIME_SA" \
  --set-env-vars="GITHUB_APP_ID=4616688,OVERCENTER_RUNNER_CONFIG_PATH=config/gcp-runner-autoscaler.json,OVERCENTER_RUNNER_LAUNCHER_URL=${launcher_url},OVERCENTER_SOURCE_REVISION=${EXACT_REVISION}" \
  --set-secrets="GITHUB_APP_PRIVATE_KEY=overcenter-github-app-private-key:latest" \
  --command=node \
  --args="--experimental-strip-types,src/transport/gcp-runner-autoscaler.ts" \
  --startup-probe="httpGet.path=/health,httpGet.port=8080,initialDelaySeconds=0,failureThreshold=12,timeoutSeconds=3,periodSeconds=5" \
  --min=1 \
  --max=1 \
  --no-cpu-throttling \
  --cpu=1 \
  --memory=512Mi \
  --quiet

service_json="${RUNNER_TEMP:-/tmp}/overcenter-gcp-runner-autoscaler.json"
gcloud run services describe "$AUTOSCALER_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format=json > "$service_json"

python3 - "$service_json" "$RUNTIME_SA" "$CONTROL_IMAGE_IMMUTABLE" "$EXACT_REVISION" "$launcher_url" <<'PY'
import json
import sys

path, expected_sa, control_image, expected_revision, launcher_url = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    body = json.load(handle)

template = ((body.get("spec") or {}).get("template") or {})
spec = template.get("spec") or {}
if spec.get("serviceAccountName") != expected_sa:
    raise SystemExit("autoscaler service account readback mismatch")

containers = spec.get("containers") or [{}]
if str(containers[0].get("image") or "") != control_image:
    raise SystemExit("autoscaler control image readback mismatch")
env = {
    str(item.get("name")): item
    for item in (containers[0].get("env") or [])
    if item.get("name")
}
if str((env.get("GITHUB_APP_ID") or {}).get("value") or "") != "4616688":
    raise SystemExit("autoscaler GitHub App id readback mismatch")
if str((env.get("OVERCENTER_SOURCE_REVISION") or {}).get("value") or "") != expected_revision:
    raise SystemExit("autoscaler source revision readback mismatch")
if str((env.get("OVERCENTER_RUNNER_LAUNCHER_URL") or {}).get("value") or "") != launcher_url:
    raise SystemExit("autoscaler launcher URL readback mismatch")

private_key = env.get("GITHUB_APP_PRIVATE_KEY") or {}
if "valueFrom" not in private_key:
    raise SystemExit("autoscaler GitHub App key is not secret-backed")

service_annotations = (body.get("metadata") or {}).get("annotations") or {}
max_scale = str(service_annotations.get("run.googleapis.com/maxScale") or "")
min_scale = str(service_annotations.get("run.googleapis.com/minScale") or "")
if max_scale != "1" or min_scale != "1":
    raise SystemExit(
        f"autoscaler service instance bounds mismatch: min={min_scale!r} max={max_scale!r}"
    )

if any("cloudsql" in json.dumps(value).lower() for value in (spec.get("volumes") or [])):
    raise SystemExit("autoscaler must not have a Cloud SQL attachment")

status = body.get("status") or {}
ready = str(status.get("latestReadyRevisionName") or "")
created = str(status.get("latestCreatedRevisionName") or "")
if not ready or ready != created:
    raise SystemExit("autoscaler deployment did not become ready")

print(f"Autoscaler revision: {ready}")
print(f"Autoscaler URL: {status.get('url') or ''}")
PY

service_url="$(
  python3 - "$service_json" <<'PY'
import json,sys
with open(sys.argv[1], encoding="utf-8") as handle:
    body=json.load(handle)
print(str((body.get("status") or {}).get("url") or ""))
PY
)"
if [[ ! "$service_url" =~ ^https:// ]]; then
  echo "autoscaler deployment returned no HTTPS URL" >&2
  exit 1
fi

for private_url in "$launcher_url" "$service_url"; do
  unauth_status="$(
    curl --silent --show-error --output /dev/null --write-out '%{http_code}' "${private_url}/health"
  )"
  if [[ "$unauth_status" != "403" ]]; then
    echo "runner service must remain private; unauthenticated /health returned $unauth_status for $private_url" >&2
    exit 1
  fi
done

printf '%s\n' \
  "GCP runner substrate deployed" \
  "Source revision: ${EXACT_REVISION}" \
  "Runner digest:   ${runner_digest}" \
  "Control digest:  ${control_digest}" \
  "Launcher:        private Cloud Run; Cloud Build submission only" \
  "Autoscaler:      private Cloud Run; GitHub observation only" \
  "Hosted Actions:  deployment only, never per verification job"
