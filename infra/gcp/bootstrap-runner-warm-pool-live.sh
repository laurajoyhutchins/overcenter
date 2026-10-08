#!/usr/bin/env bash
set -euo pipefail

export GCP_PROJECT_ID="project-6b810532-a302-48dc-b56"
export GCP_REGION="us-west1"
export GCP_ZONE="us-west1-a"
export OVERCENTER_SOURCE_REVISION="4ffc28597d200f99a06a48de555dd08c3eed379e"
export OVERCENTER_RUNNER_CONTROL_IMAGE="us-west1-docker.pkg.dev/project-6b810532-a302-48dc-b56/cloud-run-source-deploy/overcenter-gcp-runner-control@sha256:a7daa09f506b3677e3768c8e0adcdd3547d725657c1ed4979246f6522248a525"
export OVERCENTER_RUNNER_IMAGE="us-west1-docker.pkg.dev/project-6b810532-a302-48dc-b56/cloud-run-source-deploy/overcenter-gcp-runner@sha256:531519b387e4f557bb840f0cf10b53352cef5927e36cc4fd3b057cd3b8f6458b"

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
