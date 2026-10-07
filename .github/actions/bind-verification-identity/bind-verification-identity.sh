#!/usr/bin/env bash
set -euo pipefail

event_name="${OC_EVENT_NAME:?VERIFICATION_IDENTITY_ENV_REQUIRED:OC_EVENT_NAME}"
event_sha="${OC_EVENT_SHA:?VERIFICATION_IDENTITY_ENV_REQUIRED:OC_EVENT_SHA}"

tested_sha="$(git rev-parse HEAD)"
tested_tree="$(git rev-parse 'HEAD^{tree}')"

if [[ "$tested_sha" != "$event_sha" ]]; then
  echo "VERIFICATION_IDENTITY_EVENT_SHA_MISMATCH:$tested_sha:$event_sha" >&2
  exit 2
fi

if [[ "$event_name" == "pull_request" ]]; then
  head_sha="${OC_PR_HEAD_SHA:?VERIFICATION_IDENTITY_ENV_REQUIRED:OC_PR_HEAD_SHA}"
  base_sha="${OC_PR_BASE_SHA:?VERIFICATION_IDENTITY_ENV_REQUIRED:OC_PR_BASE_SHA}"
  if [[ ! "$head_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "VERIFICATION_IDENTITY_HEAD_SHA_INVALID" >&2
    exit 2
  fi
  if [[ ! "$base_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "VERIFICATION_IDENTITY_BASE_SHA_INVALID" >&2
    exit 2
  fi

  read -r -a parents <<<"$(git show --no-patch --format=%P HEAD)"
  if [[ "${#parents[@]}" -ne 2 ]]; then
    echo "VERIFICATION_IDENTITY_MERGE_PARENT_COUNT:${#parents[@]}" >&2
    exit 2
  fi
  if [[ "${parents[0]}" != "$base_sha" ]]; then
    echo "VERIFICATION_IDENTITY_BASE_MISMATCH:${parents[0]}:$base_sha" >&2
    exit 2
  fi
  if [[ "${parents[1]}" != "$head_sha" ]]; then
    echo "VERIFICATION_IDENTITY_HEAD_MISMATCH:${parents[1]}:$head_sha" >&2
    exit 2
  fi

  candidate_sha="$head_sha"
  candidate_tree="$(git rev-parse "${candidate_sha}^{tree}")"
else
  candidate_sha="$event_sha"
  candidate_tree="$tested_tree"
  base_sha=""
fi

emit() {
  printf '%s=%s\n' "$1" "$2"
}

emit verification_event "$event_name"
emit candidate_sha "$candidate_sha"
emit candidate_tree "$candidate_tree"
emit base_sha "$base_sha"
emit tested_sha "$tested_sha"
emit tested_tree "$tested_tree"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    emit verification_event "$event_name"
    emit candidate_sha "$candidate_sha"
    emit candidate_tree "$candidate_tree"
    emit base_sha "$base_sha"
    emit tested_sha "$tested_sha"
    emit tested_tree "$tested_tree"
  } >> "$GITHUB_OUTPUT"
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    printf '%s\n' '### Verification identity' ''
    printf -- '- event: `%s`\n' "$event_name"
    printf -- '- candidate SHA: `%s`\n' "$candidate_sha"
    printf -- '- candidate tree: `%s`\n' "$candidate_tree"
    if [[ -n "$base_sha" ]]; then
      printf -- '- base SHA: `%s`\n' "$base_sha"
    fi
    printf -- '- tested SHA: `%s`\n' "$tested_sha"
    printf -- '- tested tree: `%s`\n' "$tested_tree"
  } >> "$GITHUB_STEP_SUMMARY"
fi
