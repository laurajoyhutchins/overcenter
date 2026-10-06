#!/usr/bin/env bash
set -euo pipefail

: "${TARGET_REPOSITORY:?TARGET_REPOSITORY is required}"
: "${TARGET_JOB_ID:?TARGET_JOB_ID is required}"
: "${RUNNER_LABEL:?RUNNER_LABEL is required}"

if [[ -f /workspace/skip-runner ]]; then
  echo "GitHub job is no longer queued; no runner required."
  exit 0
fi

if [[ ! "$TARGET_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "TARGET_REPOSITORY must be owner/repository" >&2
  exit 2
fi
if [[ ! "$TARGET_JOB_ID" =~ ^[0-9]+$ ]]; then
  echo "TARGET_JOB_ID must be numeric" >&2
  exit 2
fi
if [[ ! "$RUNNER_LABEL" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "RUNNER_LABEL must be a canonical GitHub runner label" >&2
  exit 2
fi
if [[ ! -s /workspace/jit-config ]]; then
  echo "runner JIT configuration is missing" >&2
  exit 3
fi

for variable in GOOGLE_APPLICATION_CREDENTIALS CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE GOOGLE_GHA_CREDS_PATH; do
  if [[ -n "${!variable:-}" ]]; then
    echo "ambient GCP credential variable reached runner: $variable" >&2
    exit 70
  fi
done

metadata_endpoints=(
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
  "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token"
)
metadata_status_dir="$(mktemp -d)"
trap 'rm -rf "$metadata_status_dir"' EXIT
for index in "${!metadata_endpoints[@]}"; do
  endpoint="${metadata_endpoints[$index]}"
  (
    curl --silent --output /dev/null --write-out '%{http_code}' \
      --connect-timeout 1 --max-time 2 \
      -H 'Metadata-Flavor: Google' \
      "$endpoint" > "$metadata_status_dir/$index" || true
  ) &
done
wait
for status_file in "$metadata_status_dir"/*; do
  if [[ "$(cat "$status_file")" = "200" ]]; then
    echo "GCP metadata credentials are reachable from runner network" >&2
    exit 71
  fi
done
rm -rf "$metadata_status_dir"
trap - EXIT

jit_config="$(cat /workspace/jit-config)"
rm -f /workspace/jit-config

cd /actions-runner
rm -rf _work .runner .credentials .credentials_rsaparams

exec ./run.sh --jitconfig "$jit_config"
