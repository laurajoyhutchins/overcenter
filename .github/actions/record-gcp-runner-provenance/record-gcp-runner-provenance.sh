#!/usr/bin/env bash
set -euo pipefail

runner_name="${OC_RUNNER_NAME:?GCP_RUNNER_PROVENANCE_ENV_REQUIRED:OC_RUNNER_NAME}"
repository="${OC_REPOSITORY:?GCP_RUNNER_PROVENANCE_ENV_REQUIRED:OC_REPOSITORY}"
run_id="${OC_RUN_ID:?GCP_RUNNER_PROVENANCE_ENV_REQUIRED:OC_RUN_ID}"
run_attempt="${OC_RUN_ATTEMPT:?GCP_RUNNER_PROVENANCE_ENV_REQUIRED:OC_RUN_ATTEMPT}"
job="${OC_JOB:?GCP_RUNNER_PROVENANCE_ENV_REQUIRED:OC_JOB}"

if [[ ! "$runner_name" =~ ^overcenter-gcp-[A-Za-z0-9_.-]+$ ]]; then
  echo "GCP_RUNNER_PROVENANCE_RUNNER_INVALID:$runner_name" >&2
  exit 2
fi
if [[ ! "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "GCP_RUNNER_PROVENANCE_REPOSITORY_INVALID:$repository" >&2
  exit 2
fi
if [[ ! "$run_id" =~ ^[0-9]+$ ]]; then
  echo "GCP_RUNNER_PROVENANCE_RUN_ID_INVALID:$run_id" >&2
  exit 2
fi
if [[ ! "$run_attempt" =~ ^[1-9][0-9]*$ ]]; then
  echo "GCP_RUNNER_PROVENANCE_RUN_ATTEMPT_INVALID:$run_attempt" >&2
  exit 2
fi
if [[ ! "$job" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "GCP_RUNNER_PROVENANCE_JOB_INVALID:$job" >&2
  exit 2
fi

emit() {
  printf '%s=%s\n' "$1" "$2"
}

emit provider gcp
emit runner_name "$runner_name"
emit repository "$repository"
emit run_id "$run_id"
emit run_attempt "$run_attempt"
emit job "$job"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    emit provider gcp
    emit runner_name "$runner_name"
    emit repository "$repository"
    emit run_id "$run_id"
    emit run_attempt "$run_attempt"
    emit job "$job"
  } >> "$GITHUB_OUTPUT"
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Execution provenance"
    echo
    echo "- provider: `gcp`"
    echo "- runner: `$runner_name`"
    echo "- repository: `$repository`"
    echo "- run ID: `$run_id`"
    echo "- run attempt: `$run_attempt`"
    echo "- job: `$job`"
  } >> "$GITHUB_STEP_SUMMARY"
fi
