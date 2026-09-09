#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
PROJECT_ID="${GCP_PROJECT_ID:-project-6b810532-a302-48dc-b56}"
REGION="${GCP_REGION:-us-west1}"
SERVICE="${GCP_SERVICE:-overcenter-shadow}"
AUDIENCE="${SERVICE_AUDIENCE:-https://overcenter-shadow-bwcce2cokq-uw.a.run.app}"
CONNECTION_NAME="${CLOUD_SQL_CONNECTION_NAME:-project-6b810532-a302-48dc-b56:us-west1:overcenter-postgres}"
RUNTIME_SA="${OVERCENTER_RUNTIME_SERVICE_ACCOUNT:-overcenter-runtime@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com}"
DB_NAME="${PGDATABASE:-overcenter}"
DB_USER="${PGUSER:-overcenter}"
PASSWORD_SECRET="${OVERCENTER_DB_PASSWORD_SECRET:-overcenter-db-password}"
PROJECT_REF="${PROJECT_REF:-github:laurajoyhutchins/overcenter}"
FAILED_TRANSITION="${FAILED_TRANSITION:-finish-hatchable-gcp-authoritative-state-migration}"
FAILED_OBSERVED_AT="${FAILED_OBSERVED_AT:-2026-09-09T00:27:08.894Z}"
PREFERRED_ACCEPTANCE_TRANSITION="${ACCEPTANCE_TRANSITION:-make-mechanical-changeset-coalescing-actionable}"
DIAGNOSTIC_JOB="${SERVICE}-authority-proof-inspect"
SOURCE_FREEZE_DIGEST='sha256:3ff040b3ebb60b89af860c1d3a140aef3be58652fdb1abca592ec45fb7c764b5'
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

post_json() {
  local output="$1"
  local payload="$2"
  curl --silent --show-error -o "$output" -w '%{http_code}' \
    -H "Authorization: Bearer ${ID_TOKEN:?ID_TOKEN is required}" \
    -H 'content-type: application/json' \
    -X POST \
    -d "$payload" \
    "$AUDIENCE/api/worker-command"
}

fail_json() {
  local label="$1" status="$2" file="$3"
  printf '%s\n' "$label failed (HTTP $status). Response:"
  jq . "$file" 2>/dev/null || cat "$file"
  exit 1
}

collect_inspector_json() {
  local phase="$1" since="$2" output="$3"
  local logs="$RUNNER_TEMP/${phase}-logs.json"
  local payload=''
  for _ in 1 2 3 4 5; do
    gcloud logging read \
      "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$DIAGNOSTIC_JOB\" AND timestamp>=\"$since\"" \
      --project="$PROJECT_ID" \
      --limit=100 \
      --order=desc \
      --format=json > "$logs"
    payload="$(jq -rc --arg phase "$phase" '
      .[]
      | (.textPayload // .jsonPayload.message // empty)
      | select(type == "string" and startswith("OVERCENTER_AUTHORITY_PROOF_INSPECT="))
      | sub("^OVERCENTER_AUTHORITY_PROOF_INSPECT="; "")
      | fromjson
      | select(.phase == $phase)
    ' "$logs" | head -n1)"
    if [[ -n "$payload" ]]; then break; fi
    sleep 2
  done
  if [[ -z "$payload" ]]; then
    echo "No authority proof inspector payload was readable for phase $phase" >&2
    jq . "$logs" >&2 || true
    exit 1
  fi
  printf '%s\n' "$payload" | jq . | tee "$output"
}

run_inspector_deploy() {
  local phase="$1" transition="$2" observed_at="$3"
  local since
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  gcloud run jobs delete "$DIAGNOSTIC_JOB" --project="$PROJECT_ID" --region="$REGION" --quiet >/dev/null 2>&1 || true
  gcloud run jobs deploy "$DIAGNOSTIC_JOB" \
    --source . \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --service-account="$RUNTIME_SA" \
    --set-cloudsql-instances="$CONNECTION_NAME" \
    --set-env-vars="PGHOST=/cloudsql/${CONNECTION_NAME},PGDATABASE=${DB_NAME},PGUSER=${DB_USER},OVERCENTER_AUTHORITY_MODE=authoritative,PROOF_INSPECT_PHASE=${phase},PROOF_PROJECT_REF=${PROJECT_REF},PROOF_TRANSITION_ID=${transition},PROOF_OBSERVED_AT=${observed_at}" \
    --set-secrets="PGPASSWORD=${PASSWORD_SECRET}:latest" \
    --command=/cnb/lifecycle/launcher \
    --args="--,node,scripts/cloud-run-authority-proof-inspect.mjs" \
    --tasks=1 \
    --parallelism=1 \
    --max-retries=0 \
    --task-timeout=5m \
    --execute-now \
    --wait \
    --quiet
  collect_inspector_json "$phase" "$since" "$RUNNER_TEMP/${phase}.json"
}

run_inspector_existing() {
  local phase="$1" transition="$2" run_id="$3"
  local since
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  gcloud run jobs execute "$DIAGNOSTIC_JOB" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --update-env-vars="PROOF_INSPECT_PHASE=${phase},PROOF_PROJECT_REF=${PROJECT_REF},PROOF_TRANSITION_ID=${transition},PROOF_RUN_ID=${run_id}" \
    --wait \
    --quiet
  collect_inspector_json "$phase" "$since" "$RUNNER_TEMP/${phase}.json"
}

inspect_failed_attempt() {
  run_inspector_deploy failed-attempt "$FAILED_TRANSITION" "$FAILED_OBSERVED_AT"
  local file="$RUNNER_TEMP/failed-attempt.json"
  jq -e '.schema == "overcenter-authority-proof-inspect-v1" and .counts.runs == 1' "$file" >/dev/null
  jq -e '.target_epoch.freeze_table == null and .target_epoch.freeze_function == null and .target_epoch.freeze_triggers == 0 and .target_epoch.source_only_migrations == 0' "$file" >/dev/null
  local run_id status leases execution slots active
  run_id="$(jq -r '.run.run_id' "$file")"
  status="$(jq -r '.run.status' "$file")"
  leases="$(jq -r '.counts.leases' "$file")"
  execution="$(jq -r '.counts.execution_state' "$file")"
  slots="$(jq -r '.counts.slots' "$file")"
  active="$(jq -r '.counts.active_transition_leases' "$file")"
  printf '%s\n' \
    "Failed GCP acceptance run: $run_id" \
    "Persisted run status: $status" \
    "Persisted work_leases rows: $leases" \
    "Persisted execution_state rows: $execution" \
    "Persisted work_lease_slots rows: $slots" \
    "Active transition leases now: $active"
}

prove_runtime() {
  : "${EXACT_REVISION:?EXACT_REVISION is required}"
  : "${ID_TOKEN:?ID_TOKEN is required}"
  local prior="$RUNNER_TEMP/failed-attempt.json"
  test -s "$prior"

  gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format=json > "$RUNNER_TEMP/service.json"
  local ready created mode revision digest url
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

  local health_status inspect_status
  health_status="$(curl --silent --show-error -o "$RUNNER_TEMP/health.json" -w '%{http_code}' -H "Authorization: Bearer $ID_TOKEN" "$AUDIENCE/health")"
  test "$health_status" = 200 || fail_json health "$health_status" "$RUNNER_TEMP/health.json"
  jq -e '.ok == true and .database == "ready" and .authority_mode == "authoritative"' "$RUNNER_TEMP/health.json" >/dev/null

  inspect_status="$(curl --silent --show-error -o "$RUNNER_TEMP/inspect-before.json" -w '%{http_code}' \
    -H "Authorization: Bearer $ID_TOKEN" -H 'content-type: application/json' -X POST \
    -d "{\"project_ref\":\"$PROJECT_REF\"}" "$AUDIENCE/api/authoritative-state/project-inspect")"
  test "$inspect_status" = 200 || fail_json project-inspect-before "$inspect_status" "$RUNNER_TEMP/inspect-before.json"
  jq -e '.ok == true and .authority_mode == "authoritative" and .inspection.ok == true' "$RUNNER_TEMP/inspect-before.json" >/dev/null

  local failed_run failed_status failed_active failed_leases
  failed_run="$(jq -r '.run.run_id' "$prior")"
  failed_status="$(jq -r '.run.status' "$prior")"
  failed_active="$(jq -r '.counts.active_transition_leases' "$prior")"
  failed_leases="$(jq -r '.counts.leases' "$prior")"
  echo "Reconciling failed GCP acceptance run $failed_run (status=$failed_status leases=$failed_leases active_leases=$failed_active)"

  if [[ "$failed_status" == "active" ]]; then
    if [[ "$failed_active" == "0" ]]; then
      local recover_acquire_payload recover_acquire_status
      recover_acquire_payload="$(jq -nc --arg project "$PROJECT_REF" --arg transition "$FAILED_TRANSITION" --arg resume "$failed_run" \
        '{command:"project.advance",input:{project_ref:$project,transition_id:$transition,resume_ref:$resume}}')"
      recover_acquire_status="$(post_json "$RUNNER_TEMP/recover-acquire.json" "$recover_acquire_payload")"
      test "$recover_acquire_status" = 200 || fail_json failed-run-reacquire "$recover_acquire_status" "$RUNNER_TEMP/recover-acquire.json"
      jq -e --arg run "$failed_run" '.ok == true and .outcome == "AGENT_EXECUTION_REQUIRED" and .resume_ref == $run and (.lease_ref|type == "string")' "$RUNNER_TEMP/recover-acquire.json" >/dev/null
    elif [[ "$failed_active" == "1" ]]; then
      jq -e --arg run "$failed_run" '.active_transition_leases[0].run_id == $run' "$prior" >/dev/null
    else
      echo "Failed attempt has ambiguous active lease authority" >&2
      exit 1
    fi

    local recover_settle_payload recover_settle_status
    recover_settle_payload="$(jq -nc \
      --arg project "$PROJECT_REF" --arg transition "$FAILED_TRANSITION" --arg resume "$failed_run" \
      --arg probe "github-actions-run:${GITHUB_RUN_ID}" \
      '{command:"project.advance",input:{project_ref:$project,transition_id:$transition,resume_ref:$resume,execution_result:{disposition:"requeue",requeue_class:"insufficient_execution_window",reason:"Recovered failed pre-fix GCP acceptance probe; no substantive transition execution was started.",evidence:[{kind:"gcp_runtime_acceptance_probe_recovery",ref:$probe}]}}}')"
    recover_settle_status="$(post_json "$RUNNER_TEMP/recover-settle.json" "$recover_settle_payload")"
    test "$recover_settle_status" = 200 || fail_json failed-run-requeue "$recover_settle_status" "$RUNNER_TEMP/recover-settle.json"
    jq -e '.ok == true and .resume_ref == null' "$RUNNER_TEMP/recover-settle.json" >/dev/null
  elif [[ "$failed_active" != "0" ]]; then
    echo "Terminal failed run still has active transition authority" >&2
    exit 1
  fi

  inspect_status="$(curl --silent --show-error -o "$RUNNER_TEMP/inspect-recovered.json" -w '%{http_code}' \
    -H "Authorization: Bearer $ID_TOKEN" -H 'content-type: application/json' -X POST \
    -d "{\"project_ref\":\"$PROJECT_REF\"}" "$AUDIENCE/api/authoritative-state/project-inspect")"
  test "$inspect_status" = 200 || fail_json project-inspect-recovered "$inspect_status" "$RUNNER_TEMP/inspect-recovered.json"
  jq -e '.ok == true and .inspection.ok == true' "$RUNNER_TEMP/inspect-recovered.json" >/dev/null

  local acceptance_transition
  acceptance_transition="$(jq -r --arg preferred "$PREFERRED_ACCEPTANCE_TRANSITION" --arg excluded "$FAILED_TRANSITION" '
    (.inspection.frontier_details // []) as $d
    | (($d | map(select(.id == $preferred and .availability == "available")) | first | .id)
      // ($d | map(select(.id != $excluded and .availability == "available")) | first | .id)
      // empty)
  ' "$RUNNER_TEMP/inspect-recovered.json")"
  if [[ -z "$acceptance_transition" ]]; then
    echo "No reversible available transition exists for the GCP acceptance probe" >&2
    jq '.inspection.frontier_details' "$RUNNER_TEMP/inspect-recovered.json" >&2
    exit 1
  fi
  echo "Fresh GCP acceptance transition: $acceptance_transition"

  local initial_payload advance_status probe_run lease_ref
  initial_payload="$(jq -nc --arg project "$PROJECT_REF" --arg transition "$acceptance_transition" \
    '{command:"project.advance",input:{project_ref:$project,transition_id:$transition}}')"
  advance_status="$(post_json "$RUNNER_TEMP/acceptance-advance.json" "$initial_payload")"
  test "$advance_status" = 200 || fail_json acceptance-advance "$advance_status" "$RUNNER_TEMP/acceptance-advance.json"
  jq -e '.ok == true and .outcome == "AGENT_EXECUTION_REQUIRED" and (.resume_ref|type == "string") and (.lease_ref|type == "string")' "$RUNNER_TEMP/acceptance-advance.json" >/dev/null
  probe_run="$(jq -r '.resume_ref' "$RUNNER_TEMP/acceptance-advance.json")"
  lease_ref="$(jq -r '.lease_ref' "$RUNNER_TEMP/acceptance-advance.json")"

  inspect_status="$(curl --silent --show-error -o "$RUNNER_TEMP/inspect-occupied.json" -w '%{http_code}' \
    -H "Authorization: Bearer $ID_TOKEN" -H 'content-type: application/json' -X POST \
    -d "{\"project_ref\":\"$PROJECT_REF\"}" "$AUDIENCE/api/authoritative-state/project-inspect")"
  test "$inspect_status" = 200 || fail_json project-inspect-occupied "$inspect_status" "$RUNNER_TEMP/inspect-occupied.json"
  jq -e --arg id "$acceptance_transition" '.inspection.frontier_details[] | select(.id == $id) | .availability == "occupied" and .occupied == true' "$RUNNER_TEMP/inspect-occupied.json" >/dev/null

  local settle_payload settle_status
  settle_payload="$(jq -nc \
    --arg project "$PROJECT_REF" --arg transition "$acceptance_transition" --arg resume "$probe_run" \
    --arg deploy_run "github-actions-run:${GITHUB_RUN_ID}" --arg revision_ref "git-revision:${EXACT_REVISION}" \
    '{command:"project.advance",input:{project_ref:$project,transition_id:$transition,resume_ref:$resume,execution_result:{disposition:"requeue",requeue_class:"insufficient_execution_window",reason:"Post-migration GCP acceptance probe only; substantive transition execution was intentionally not started.",evidence:[{kind:"gcp_runtime_acceptance_probe",ref:$deploy_run},{kind:"gcp_authority_revision",ref:$revision_ref}]}}}')"
  settle_status="$(post_json "$RUNNER_TEMP/acceptance-settle.json" "$settle_payload")"
  test "$settle_status" = 200 || fail_json acceptance-requeue "$settle_status" "$RUNNER_TEMP/acceptance-settle.json"
  jq -e '.ok == true and .resume_ref == null' "$RUNNER_TEMP/acceptance-settle.json" >/dev/null

  inspect_status="$(curl --silent --show-error -o "$RUNNER_TEMP/inspect-after.json" -w '%{http_code}' \
    -H "Authorization: Bearer $ID_TOKEN" -H 'content-type: application/json' -X POST \
    -d "{\"project_ref\":\"$PROJECT_REF\"}" "$AUDIENCE/api/authoritative-state/project-inspect")"
  test "$inspect_status" = 200 || fail_json project-inspect-after "$inspect_status" "$RUNNER_TEMP/inspect-after.json"
  jq -e --arg id "$acceptance_transition" '.ok == true and .inspection.ok == true and (.inspection.frontier_details[] | select(.id == $id) | .availability == "available" and .occupied == false)' "$RUNNER_TEMP/inspect-after.json" >/dev/null

  run_inspector_existing acceptance-cycle "$acceptance_transition" "$probe_run"
  local durable="$RUNNER_TEMP/acceptance-cycle.json"
  jq -e --arg run "$probe_run" --arg lease "$lease_ref" '
    .run.run_id == $run
    and .run.status != "active"
    and .run.finished_at != null
    and (.leases | map(select(.lease_id == $lease and .status == "settled" and .settle_plan.disposition == "requeue" and .settle_receipt != null)) | length == 1)
    and .counts.slots == 0
    and .counts.active_transition_leases == 0
    and .target_epoch.freeze_table == null
    and .target_epoch.freeze_function == null
    and .target_epoch.freeze_triggers == 0
    and .target_epoch.source_only_migrations == 0
  ' "$durable" >/dev/null

  printf '%s\n' \
    "GCP migration proof complete" \
    "Cloud Run revision: $ready" \
    "Source revision: $revision" \
    "Source freeze digest: $digest" \
    "Recovered failed run: $failed_run" \
    "Acceptance transition: $acceptance_transition" \
    "Acceptance run: $probe_run" \
    "Acceptance lease: $lease_ref" \
    "Acceptance settlement: requeue" \
    "Final transition availability: available" \
    "Durable lease status: settled" \
    "Stranded active leases: 0"
}

case "$MODE" in
  inspect-failed) inspect_failed_attempt ;;
  prove) prove_runtime ;;
  *) echo "usage: $0 {inspect-failed|prove}" >&2; exit 2 ;;
esac
