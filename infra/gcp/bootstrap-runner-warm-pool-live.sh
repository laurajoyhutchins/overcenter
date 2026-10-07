#!/usr/bin/env bash
set -euo pipefail

export GCP_PROJECT_ID="project-6b810532-a302-48dc-b56"
export GCP_REGION="us-west1"
export GCP_ZONE="us-west1-a"
export OVERCENTER_SOURCE_REVISION="d81c7234ffcf96dec70f28d593ca8cb7270b7772"
export OVERCENTER_RUNNER_CONTROL_IMAGE="us-west1-docker.pkg.dev/project-6b810532-a302-48dc-b56/cloud-run-source-deploy/overcenter-gcp-runner-control@sha256:198369dd0e2d422e58b6cf6be10e3fd51b0bf462a8a58e484604f187ff98b466"
export OVERCENTER_RUNNER_IMAGE="us-west1-docker.pkg.dev/project-6b810532-a302-48dc-b56/cloud-run-source-deploy/overcenter-gcp-runner@sha256:2f9b801f5177edadef6411e2ae6dc9c2a0e6afa556f1dac0a3daa76cbce1d85c"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

gcloud run services describe overcenter-gcp-runner-launcher \
  --project="$GCP_PROJECT_ID" \
  --region="$GCP_REGION" \
  --format=json > "$tmp"

python3 - "$tmp" "$OVERCENTER_SOURCE_REVISION" "$OVERCENTER_RUNNER_CONTROL_IMAGE" "$OVERCENTER_RUNNER_IMAGE" <<'PY'
import json
import sys

path, expected_revision, expected_control, expected_runner = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    body = json.load(handle)

containers = (((body.get("spec") or {}).get("template") or {}).get("spec") or {}).get("containers") or []
if len(containers) != 1:
    raise SystemExit("launcher must have exactly one container")
container = containers[0]
if str(container.get("image") or "") != expected_control:
    raise SystemExit("live launcher control image does not match the pinned bootstrap image")
env = {
    str(entry.get("name") or ""): str(entry.get("value") or "")
    for entry in (container.get("env") or [])
    if isinstance(entry, dict)
}
if env.get("OVERCENTER_SOURCE_REVISION") != expected_revision:
    raise SystemExit("live launcher source revision does not match the pinned bootstrap revision")
if env.get("OVERCENTER_RUNNER_IMAGE") != expected_runner:
    raise SystemExit("live launcher runner image does not match the pinned bootstrap image")
PY

exec bash "$ROOT/infra/gcp/bootstrap-runner-warm-pool.sh"
