#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${GCP_REGION:?GCP_REGION is required}"
: "${EXACT_REVISION:?EXACT_REVISION is required}"

PROJECT_ID="$GCP_PROJECT_ID"
REGION="$GCP_REGION"
SERVICE="overcenter-github-runner-autoscaler"
RUNTIME_SA="overcenter-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
RUNNER_IMAGE_REPO="${REGION}-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/overcenter-gcp-runner"
RUNNER_IMAGE="${RUNNER_IMAGE_REPO}:git-${EXACT_REVISION}"
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

echo "Building immutable runner image for ${EXACT_REVISION}"
build_id="$(
  gcloud builds submit scripts/gcp-runner-image     --async     --project="$PROJECT_ID"     --region="$REGION"     --tag="$RUNNER_IMAGE"     --format='value(id)'
)"
test -n "$build_id"

build_status=""
for _ in $(seq 1 300); do
  build_status="$(
    gcloud builds describe "$build_id"       --project="$PROJECT_ID"       --region="$REGION"       --format='value(status)'
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
  gcloud builds describe "$build_id"     --project="$PROJECT_ID"     --region="$REGION"     --format='value(failureInfo.detail)' >&2 || true
  exit 1
fi

runner_digest="$(
  gcloud builds describe "$build_id"     --project="$PROJECT_ID"     --region="$REGION"     --format='value(results.images[0].digest)' | tail -n1
)"
if [[ ! "$runner_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "runner image build returned no immutable digest" >&2
  exit 1
fi
printf 'Runner image: %s@%s\n' "$RUNNER_IMAGE_REPO" "$runner_digest"

echo "Deploying private autoscaler service"
gcloud run deploy "$SERVICE"   --source .   --project="$PROJECT_ID"   --region="$REGION"   --service-account="$RUNTIME_SA"   --set-env-vars="GITHUB_APP_ID=4616688,OVERCENTER_RUNNER_CONFIG_PATH=config/gcp-runner-autoscaler.json,OVERCENTER_SOURCE_REVISION=${EXACT_REVISION}"   --set-secrets="GITHUB_APP_PRIVATE_KEY=overcenter-github-app-private-key:latest"   --command=/cnb/lifecycle/launcher   --args="--,node,--experimental-strip-types,src/transport/gcp-runner-autoscaler.ts"   --startup-probe="httpGet.path=/health,httpGet.port=8080,initialDelaySeconds=0,failureThreshold=12,timeoutSeconds=3,periodSeconds=5"   --no-allow-unauthenticated   --min-instances=1   --max-instances=1   --no-cpu-throttling   --cpu=1   --memory=256Mi   --quiet

service_json="${RUNNER_TEMP:-/tmp}/overcenter-gcp-runner-autoscaler.json"
gcloud run services describe "$SERVICE"   --project="$PROJECT_ID"   --region="$REGION"   --format=json > "$service_json"

python3 - "$service_json" "$RUNTIME_SA" "$EXACT_REVISION" <<'PY'
import json
import sys

path, expected_sa, expected_revision = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    body = json.load(handle)

template = ((body.get("spec") or {}).get("template") or {})
spec = template.get("spec") or {}
if spec.get("serviceAccountName") != expected_sa:
    raise SystemExit("autoscaler service account readback mismatch")

containers = spec.get("containers") or [{}]
env = {
    str(item.get("name")): item
    for item in (containers[0].get("env") or [])
    if item.get("name")
}
if str((env.get("GITHUB_APP_ID") or {}).get("value") or "") != "4616688":
    raise SystemExit("autoscaler GitHub App id readback mismatch")
if str((env.get("OVERCENTER_SOURCE_REVISION") or {}).get("value") or "") != expected_revision:
    raise SystemExit("autoscaler source revision readback mismatch")

private_key = env.get("GITHUB_APP_PRIVATE_KEY") or {}
if "valueFrom" not in private_key:
    raise SystemExit("autoscaler GitHub App key is not secret-backed")

annotations = (template.get("metadata") or {}).get("annotations") or {}
max_scale = str(annotations.get("autoscaling.knative.dev/maxScale") or "")
min_scale = str(annotations.get("autoscaling.knative.dev/minScale") or "")
if max_scale != "1" or min_scale != "1":
    raise SystemExit(f"autoscaler instance bounds mismatch: min={min_scale!r} max={max_scale!r}")

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

unauth_status="$(
  curl --silent --show-error --output /dev/null --write-out '%{http_code}' "${service_url}/health"
)"
if [[ "$unauth_status" != "403" ]]; then
  echo "autoscaler must remain private; unauthenticated /health returned $unauth_status" >&2
  exit 1
fi

printf '%s\n'   "GCP runner autoscaler deployed"   "Source revision: ${EXACT_REVISION}"   "Runner digest:   ${runner_digest}"   "Exposure:        private"   "Instances:       exactly one warm poller"
