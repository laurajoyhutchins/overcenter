#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-project-6b810532-a302-48dc-b56}"
REGION="${GCP_REGION:-us-west1}"
SERVICE="${GCP_SERVICE:-overcenter-shadow}"
AUDIENCE="${SERVICE_AUDIENCE:-https://overcenter-shadow-bwcce2cokq-uw.a.run.app}"
PROJECT_REF="${PROJECT_REF:-github:laurajoyhutchins/overcenter}"
FAILED_TRANSITION="${FAILED_TRANSITION:-finish-hatchable-gcp-authoritative-state-migration}"
FAILED_OBSERVED_AT="${FAILED_OBSERVED_AT:-2026-09-09T00:27:08.894Z}"
PREFERRED_ACCEPTANCE_TRANSITION="${ACCEPTANCE_TRANSITION:-make-mechanical-changeset-coalescing-actionable}"
SOURCE_FREEZE_DIGEST='sha256:3ff040b3ebb60b89af860c1d3a140aef3be58652fdb1abca592ec45fb7c764b5'
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${EXACT_REVISION:?EXACT_REVISION is required}"
: "${ID_TOKEN:?ID_TOKEN is required}"

post() {
  local path="$1" output="$2" payload="$3"
  curl --silent --show-error -o "$output" -w '%{http_code}' \
    -H "Authorization: Bearer $ID_TOKEN" \
    -H 'content-type: application/json' \
    -X POST -d "$payload" "$AUDIENCE$path"
}

fail_json() {
  local label="$1" status="$2" file="$3"
  printf '%s\n' "$label failed (HTTP $status). Response:" >&2
  jq . "$file" >&2 2>/dev/null || cat "$file" >&2
  exit 1
}

proof_inspect() {
  local output="$1" payload="$2" status
  status="$(post /api/authoritative-state/proof-inspect "$output" "$payload")"
  test "$status" = 200 || fail_json authority-proof-inspect "$status" "$output"
  jq -e '.ok == true and .authority_mode == "authoritative" and .proof.schema == "overcenter-authority-proof-inspect-v1"' "$output" >/dev/null
  jq '.proof' "$output"
}

worker() {
  local output="$1" payload="$2" status
  status="$(post /api/worker-command "$output" "$payload")"
  test "$status" = 200 || fail_json worker-command "$status" "$output"
}

project_inspect() {
  local output="$1" status
  status="$(post /api/authoritative-state/project-inspect "$output" "$(jq -nc --arg project "$PROJECT_REF" '{project_ref:$project}')")"
  test "$status" = 200 || fail_json project-inspect "$status" "$output"
  jq -e '.ok == true and .authority_mode == "authoritative" and .inspection.ok == true' "$output" >/dev/null
}

gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format=json > "$RUNNER_TEMP/service.json"
ready="$(jq -r '.status.latestReadyRevisionName' "$RUNNER_TEMP/service.json")"
created="$(jq -r '.status.latestCreatedRevisionName' "$RUNNER_TEMP/service.json")"
mode="$(jq -r '.spec.template.spec.containers[0].env[] | select(.name == "OVERCENTER_AUTHORITY_MODE") | .value' "$RUNNER_TEMP/service.json")"
revision="$(jq -r '.spec.template.spec.containers[0].env[] | select(.name == "OVERCENTER_SOURCE_REVISION") | .value' "$RUNNER_TEMP/service.json")"
digest="$(jq -r '.spec.template.spec.containers[0].env[] | select(.name == "OVERCENTER_SOURCE_FREEZE_DIGEST") | .value' "$RUNNER_TEMP/service.json")"
url="$(jq -r '.status.url' "$RUNNER_TEMP/service.json")"
test -n "$ready" && test "$ready" = "$created"
test "$mode" = authoritative
test "$revision" = "$EXACT_REVISION"
test "$digest" = "$SOURCE_FREEZE_DIGEST"
test "$url" = "$AUDIENCE"

health_status="$(curl --silent --show-error -o "$RUNNER_TEMP/health.json" -w '%{http_code}' -H "Authorization: Bearer $ID_TOKEN" "$AUDIENCE/health")"
test "$health_status" = 200 || fail_json health "$health_status" "$RUNNER_TEMP/health.json"
jq -e '.ok == true and .database == "ready" and .authority_mode == "authoritative"' "$RUNNER_TEMP/health.json" >/dev/null

project_inspect "$RUNNER_TEMP/inspect-before.json"

failed_payload="$(jq -nc --arg project "$PROJECT_REF" --arg transition "$FAILED_TRANSITION" --arg observed "$FAILED_OBSERVED_AT" '{phase:"failed-attempt",project_ref:$project,transition_id:$transition,observed_at:$observed}')"
proof_inspect "$RUNNER_TEMP/failed-proof-response.json" "$failed_payload" > "$RUNNER_TEMP/failed-attempt.json"
jq -e '.counts.runs == 1 and .target_epoch.freeze_table == null and .target_epoch.freeze_function == null and .target_epoch.freeze_triggers == 0 and .target_epoch.source_only_migrations == 0' "$RUNNER_TEMP/failed-attempt.json" >/dev/null
failed_run="$(jq -r '.run.run_id' "$RUNNER_TEMP/failed-attempt.json")"
failed_status="$(jq -r '.run.status' "$RUNNER_TEMP/failed-attempt.json")"
failed_active="$(jq -r '.counts.active_transition_leases' "$RUNNER_TEMP/failed-attempt.json")"

if [[ "$failed_status" == active ]]; then
  if [[ "$failed_active" == 0 ]]; then
    recover_payload="$(jq -nc --arg project "$PROJECT_REF" --arg transition "$FAILED_TRANSITION" --arg resume "$failed_run" '{command:"project.advance",input:{project_ref:$project,transition_id:$transition,resume_ref:$resume}}')"
    worker "$RUNNER_TEMP/recover-acquire.json" "$recover_payload"
    jq -e --arg run "$failed_run" '.ok == true and .outcome == "AGENT_EXECUTION_REQUIRED" and .resume_ref == $run and (.lease_ref|type == "string")' "$RUNNER_TEMP/recover-acquire.json" >/dev/null
  elif [[ "$failed_active" == 1 ]]; then
    jq -e --arg run "$failed_run" '.active_transition_leases[0].run_id == $run' "$RUNNER_TEMP/failed-attempt.json" >/dev/null
  else
    echo 'Failed attempt has ambiguous active lease authority' >&2
    exit 1
  fi
  recover_settle="$(jq -nc --arg project "$PROJECT_REF" --arg transition "$FAILED_TRANSITION" --arg resume "$failed_run" --arg probe "github-actions-run:${GITHUB_RUN_ID}" '{command:"project.advance",input:{project_ref:$project,transition_id:$transition,resume_ref:$resume,execution_result:{disposition:"requeue",requeue_class:"insufficient_execution_window",reason:"Recovered failed pre-fix GCP acceptance probe; no substantive transition execution was started.",evidence:[{kind:"gcp_runtime_acceptance_probe_recovery",ref:$probe}]}}}')"
  worker "$RUNNER_TEMP/recover-settle.json" "$recover_settle"
  jq -e '.ok == true and .resume_ref == null' "$RUNNER_TEMP/recover-settle.json" >/dev/null
elif [[ "$failed_active" != 0 ]]; then
  echo 'Terminal failed run still has active transition authority' >&2
  exit 1
fi

project_inspect "$RUNNER_TEMP/inspect-recovered.json"
acceptance_transition="$(jq -r --arg preferred "$PREFERRED_ACCEPTANCE_TRANSITION" --arg excluded "$FAILED_TRANSITION" '(.inspection.frontier_details // []) as $d | (($d | map(select(.id == $preferred and .availability == "available")) | first | .id) // ($d | map(select(.id != $excluded and .availability == "available")) | first | .id) // empty)' "$RUNNER_TEMP/inspect-recovered.json")"
if [[ -z "$acceptance_transition" ]]; then
  echo 'No reversible available non-migration transition exists for the GCP acceptance probe' >&2
  jq '.inspection.frontier_details' "$RUNNER_TEMP/inspect-recovered.json" >&2
  exit 1
fi

advance_payload="$(jq -nc --arg project "$PROJECT_REF" --arg transition "$acceptance_transition" '{command:"project.advance",input:{project_ref:$project,transition_id:$transition}}')"
worker "$RUNNER_TEMP/acceptance-advance.json" "$advance_payload"
jq -e '.ok == true and .outcome == "AGENT_EXECUTION_REQUIRED" and (.resume_ref|type == "string") and (.lease_ref|type == "string")' "$RUNNER_TEMP/acceptance-advance.json" >/dev/null
probe_run="$(jq -r '.resume_ref' "$RUNNER_TEMP/acceptance-advance.json")"
lease_ref="$(jq -r '.lease_ref' "$RUNNER_TEMP/acceptance-advance.json")"

project_inspect "$RUNNER_TEMP/inspect-occupied.json"
jq -e --arg id "$acceptance_transition" '.inspection.frontier_details[] | select(.id == $id) | .availability == "occupied" and .occupied == true' "$RUNNER_TEMP/inspect-occupied.json" >/dev/null

settle_payload="$(jq -nc --arg project "$PROJECT_REF" --arg transition "$acceptance_transition" --arg resume "$probe_run" --arg deploy_run "github-actions-run:${GITHUB_RUN_ID}" --arg revision_ref "git-revision:${EXACT_REVISION}" '{command:"project.advance",input:{project_ref:$project,transition_id:$transition,resume_ref:$resume,execution_result:{disposition:"requeue",requeue_class:"insufficient_execution_window",reason:"Post-migration GCP acceptance probe only; substantive transition execution was intentionally not started.",evidence:[{kind:"gcp_runtime_acceptance_probe",ref:$deploy_run},{kind:"gcp_authority_revision",ref:$revision_ref}]}}}')"
worker "$RUNNER_TEMP/acceptance-settle.json" "$settle_payload"
jq -e '.ok == true and .resume_ref == null' "$RUNNER_TEMP/acceptance-settle.json" >/dev/null

project_inspect "$RUNNER_TEMP/inspect-after.json"
jq -e --arg id "$acceptance_transition" '.inspection.frontier_details[] | select(.id == $id) | .availability == "available" and .occupied == false' "$RUNNER_TEMP/inspect-after.json" >/dev/null

durable_payload="$(jq -nc --arg project "$PROJECT_REF" --arg transition "$acceptance_transition" --arg run "$probe_run" '{phase:"acceptance-cycle",project_ref:$project,transition_id:$transition,run_id:$run}')"
proof_inspect "$RUNNER_TEMP/durable-proof-response.json" "$durable_payload" > "$RUNNER_TEMP/acceptance-cycle.json"
jq -e --arg run "$probe_run" --arg lease "$lease_ref" '.run.run_id == $run and .run.status != "active" and .run.finished_at != null and (.leases | map(select(.lease_id == $lease and .status == "settled" and .settle_plan.disposition == "requeue" and .settle_receipt != null)) | length == 1) and .counts.slots == 0 and .counts.active_transition_leases == 0 and .target_epoch.freeze_table == null and .target_epoch.freeze_function == null and .target_epoch.freeze_triggers == 0 and .target_epoch.source_only_migrations == 0' "$RUNNER_TEMP/acceptance-cycle.json" >/dev/null

printf '%s\n' \
  'GCP migration proof complete' \
  "Cloud Run revision: $ready" \
  "Source revision: $revision" \
  "Source freeze digest: $digest" \
  "Recovered failed run: $failed_run" \
  "Acceptance transition: $acceptance_transition" \
  "Acceptance run: $probe_run" \
  "Acceptance lease: $lease_ref" \
  'Acceptance settlement: requeue' \
  'Final transition availability: available' \
  'Durable lease status: settled' \
  'Stranded active leases: 0'
