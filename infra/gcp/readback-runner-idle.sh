#!/usr/bin/env bash
set -euo pipefail

# Read-only proof. Intended for the existing admitted deployment principal,
# never owner admin and never called by a verification job for regular CI.
: "${GCP_PROJECT_ID:?required}"
: "${GCP_REGION:?required}"
: "${GCP_ZONE:?required}"
[[ "$GCP_ZONE" == "us-west1-a" ]] || { echo "HOLD: unexpected GCE zone" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if ! gcloud compute instance-groups managed describe overcenter-gce-runners \
  --project="$GCP_PROJECT_ID" --zone="$GCP_ZONE" --format=json > "$tmp/mig.json"; then
  echo "HOLD: admitted deployer cannot read the managed instance group; do not expand IAM automatically" >&2
  exit 1
fi
if ! gcloud compute instance-groups managed list-instances overcenter-gce-runners \
  --project="$GCP_PROJECT_ID" --zone="$GCP_ZONE" --format=json > "$tmp/instances.json"; then
  echo "HOLD: admitted deployer cannot list actual managed instances; do not expand IAM automatically" >&2
  exit 1
fi
if ! gcloud scheduler jobs describe overcenter-runner-reconcile \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" --format=json > "$tmp/scheduler.json"; then
  echo "HOLD: Scheduler observation unavailable" >&2
  exit 1
fi

python3 - "$tmp/mig.json" "$tmp/instances.json" "$tmp/scheduler.json" <<'PY'
import datetime as dt
import json
import sys

def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)

mig, instances, scheduler = map(load, sys.argv[1:])
policy = ((mig.get("autoscaler") or {}).get("autoscalingPolicy") or {})
metrics = policy.get("customMetricUtilizations") or []
expected_filter = 'resource.type="pubsub_subscription" AND resource.labels.subscription_id="overcenter-gce-runners"'
if not (
    mig.get("name") == "overcenter-gce-runners"
    and str(mig.get("zone") or "").endswith("/us-west1-a")
    and policy.get("minNumReplicas") == 0
    and policy.get("maxNumReplicas") == 1
    and policy.get("stabilizationPeriodSec") == 2700
    and policy.get("mode", "ON") == "ON"
    and len(metrics) == 1
    and metrics[0].get("metric") == "pubsub.googleapis.com/subscription/num_undelivered_messages"
    and metrics[0].get("filter") == expected_filter
    and float(metrics[0].get("singleInstanceAssignment", 0)) == 1.0
    and "cpuUtilization" not in policy
    and "loadBalancingUtilization" not in policy
    and not policy.get("scalingSchedules")
):
    raise SystemExit("HOLD: warm runner autoscaler policy differs from approved 0..1 Pub/Sub policy")
if scheduler.get("state") != "ENABLED":
    raise SystemExit("HOLD: one-minute runner reconciler is not enabled")
status = scheduler.get("status")
if not (
    isinstance(status, dict)
    and "lastAttemptTime" in scheduler
    and status.get("code", 0) == 0
    and not status.get("message")
    and not status.get("details")
):
    raise SystemExit("HOLD: Scheduler has no successful invocation receipt")
if not isinstance(instances, list):
    raise SystemExit("HOLD: managed-instance listing is not an array")
group_status = mig.get("status") or {}
actions = group_status.get("currentActions") or {}
if not isinstance(actions, dict):
    raise SystemExit("HOLD: current instance actions missing")
active_actions = {key: value for key, value in actions.items() if isinstance(value, int) and value != 0}
print("Observed UTC:", dt.datetime.now(dt.timezone.utc).isoformat())
print("Group:", mig.get("name"))
print("Target VMs:", mig.get("targetSize"))
print("Managed VMs:", len(instances))
print("Pending instance actions:", active_actions)
print("Scheduler:", scheduler.get("state"), scheduler.get("lastAttemptTime"))
if mig.get("targetSize") != 0 or instances or active_actions:
    raise SystemExit("NOT_IDLE_YET: VM group has nonzero target, instances or ongoing actions")
print("GCP_WARM_IDLE_READBACK_PASS: zero target, zero managed instances, no current actions")
PY
