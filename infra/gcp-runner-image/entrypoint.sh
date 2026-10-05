#!/usr/bin/env bash
set -euo pipefail

: "${TARGET_REPOSITORY:?TARGET_REPOSITORY is required}"
: "${TARGET_JOB_ID:?TARGET_JOB_ID is required}"
: "${RUNNER_NAME:?RUNNER_NAME is required}"
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
if [[ ! -s /workspace/registration-token ]]; then
  echo "runner registration token is missing" >&2
  exit 3
fi

for variable in GOOGLE_APPLICATION_CREDENTIALS CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE GOOGLE_GHA_CREDS_PATH; do
  if [[ -n "${!variable:-}" ]]; then
    echo "ambient GCP credential variable reached runner: $variable" >&2
    exit 70
  fi
done

for endpoint in \
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
  "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token"
do
  status="$(
    curl --silent --output /dev/null --write-out '%{http_code}' \
      --connect-timeout 1 --max-time 2 \
      -H 'Metadata-Flavor: Google' \
      "$endpoint" || true
  )"
  if [[ "$status" = "200" ]]; then
    echo "GCP metadata credentials are reachable from runner network" >&2
    exit 71
  fi
done

registration_token="$(cat /workspace/registration-token)"
rm -f /workspace/registration-token

cd /actions-runner
rm -rf _work .runner .credentials .credentials_rsaparams

./config.sh \
  --url "https://github.com/${TARGET_REPOSITORY}" \
  --token "$registration_token" \
  --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABEL" \
  --work "_work" \
  --unattended \
  --ephemeral \
  --disableupdate

unset registration_token
exec ./run.sh
