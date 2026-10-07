#!/usr/bin/env bash
set -euo pipefail

runner_name="${OC_RUNNER_NAME:?GCP_RUNNER_PROVENANCE_ENV_REQUIRED:OC_RUNNER_NAME}"
repository="${OC_REPOSITORY:?GCP_RUNNER_PROVENANCE_ENV_REQUIRED:OC_REPOSITORY}"
run_id="${OC_RUN_ID:?GCP_RUNNER_PROVENANCE_ENV_REQUIRED:OC_RUN_ID}"
run_attempt="${OC_RUN_ATTEMPT:?GCP_RUNNER_PROVENANCE_ENV_REQUIRED:OC_RUN_ATTEMPT}"
job="${OC_JOB:?GCP_RUNNER_PROVENANCE_ENV_REQUIRED:OC_JOB}"
target_repository="${TARGET_REPOSITORY:?GCP_RUNNER_PROVENANCE_ENV_REQUIRED:TARGET_REPOSITORY}"
job_id="${TARGET_JOB_ID:?GCP_RUNNER_PROVENANCE_ENV_REQUIRED:TARGET_JOB_ID}"
scheduling_label="${RUNNER_LABEL:?GCP_RUNNER_PROVENANCE_ENV_REQUIRED:RUNNER_LABEL}"

if [[ ! "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "GCP_RUNNER_PROVENANCE_REPOSITORY_INVALID:$repository" >&2
  exit 2
fi
if [[ "$target_repository" != "$repository" ]]; then
  echo "GCP_RUNNER_PROVENANCE_REPOSITORY_MISMATCH:$target_repository:$repository" >&2
  exit 2
fi
if [[ ! "$job_id" =~ ^[1-9][0-9]*$ ]]; then
  echo "GCP_RUNNER_PROVENANCE_JOB_ID_INVALID:$job_id" >&2
  exit 2
fi
if [[ ! "$runner_name" =~ ^overcenter-gcp-$job_id-[A-Za-z0-9_.-]+$ ]]; then
  echo "GCP_RUNNER_PROVENANCE_RUNNER_JOB_MISMATCH:$runner_name:$job_id" >&2
  exit 2
fi
if [[ ! "$scheduling_label" =~ ^overcenter-gcp(-[A-Za-z0-9_.-]+)?$ ]]; then
  echo "GCP_RUNNER_PROVENANCE_SCHEDULING_LABEL_INVALID:$scheduling_label" >&2
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
emit job_id "$job_id"
emit scheduling_label "$scheduling_label"
emit run_id "$run_id"
emit run_attempt "$run_attempt"
emit job "$job"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    emit provider gcp
    emit runner_name "$runner_name"
    emit repository "$repository"
    emit job_id "$job_id"
    emit scheduling_label "$scheduling_label"
    emit run_id "$run_id"
    emit run_attempt "$run_attempt"
    emit job "$job"
  } >> "$GITHUB_OUTPUT"
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    printf '%s\n' '### Execution provenance' ''
    printf -- '- provider: `%s`\n' 'gcp'
    printf -- '- runner: `%s`\n' "$runner_name"
    printf -- '- repository: `%s`\n' "$repository"
    printf -- '- job ID: `%s`\n' "$job_id"
    printf -- '- scheduling label: `%s`\n' "$scheduling_label"
    printf -- '- run ID: `%s`\n' "$run_id"
    printf -- '- run attempt: `%s`\n' "$run_attempt"
    printf -- '- job: `%s`\n' "$job"
  } >> "$GITHUB_STEP_SUMMARY"
fi
