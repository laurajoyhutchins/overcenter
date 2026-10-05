#!/usr/bin/env bash
set -euo pipefail

: "${TARGET_REPOSITORY:?TARGET_REPOSITORY is required}"
: "${TARGET_JOB_ID:?TARGET_JOB_ID is required}"
: "${RUNNER_NAME:?RUNNER_NAME is required}"

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
if [[ ! -s /workspace/registration-token ]]; then
  echo "runner registration token is missing" >&2
  exit 3
fi

cd /actions-runner
rm -rf _work .runner .credentials .credentials_rsaparams

./config.sh   --url "https://github.com/${TARGET_REPOSITORY}"   --token "$(cat /workspace/registration-token)"   --name "$RUNNER_NAME"   --labels "overcenter-gcp"   --work "_work"   --unattended   --ephemeral   --disableupdate

exec ./run.sh
