#!/usr/bin/env bash
set -euo pipefail

# Owner-authorized, one-time migration. Never part of ordinary deployment.
: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${GCP_ZONE:?GCP_ZONE is required}"

PROJECT_ID="$GCP_PROJECT_ID"
ZONE="$GCP_ZONE"
MIG="overcenter-gce-runners"
SUBSCRIPTION="overcenter-gce-runners"
MIG_JSON="$(mktemp)"
SUBSCRIPTION_JSON="$(mktemp)"
trap 'rm -f "$MIG_JSON" "$SUBSCRIPTION_JSON"' EXIT

for command in gcloud python3; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command is required" >&2; exit 2; }
done

gcloud compute instance-groups managed describe "$MIG" --project="$PROJECT_ID" --zone="$ZONE" --format=json > "$MIG_JSON"
gcloud pubsub subscriptions describe "$SUBSCRIPTION" --project="$PROJECT_ID" --format=json > "$SUBSCRIPTION_JSON"
# "gcloud compute autoscalers" is not a supported CLI command. The managed
# instance group describe response embeds the attached autoscaling policy.

# Refuse to overwrite an independently managed autoscaler or a foreign subscription.
autoscaler_state="$(python3 - "$MIG_JSON" "$SUBSCRIPTION_JSON" "$PROJECT_ID" "$ZONE" "$MIG" "$SUBSCRIPTION" <<'PY'
import json
import sys

mig_path, subscription_path, project, zone, name, subscription = sys.argv[1:]
def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)

mig, sub = load(mig_path), load(subscription_path)
if int(mig.get("targetSize", -1)) not in (0, 1):
    raise SystemExit("warm runner MIG is not bounded to one host")
if not str(mig.get("instanceTemplate") or "").rsplit("/", 1)[-1].startswith("overcenter-gce-runner-"):
    raise SystemExit("warm runner MIG instance template does not match the admitted family")
if str(sub.get("topic") or "") != f"projects/{project}/topics/{subscription}":
    raise SystemExit("warm runner subscription has an unexpected source")
attached = mig.get("autoscaler")
if attached is None:
    # Underlying MIG REST may expose a link before CLI embeds the policy.
    # Unresolved attached autoscalers must not be mistaken for no autoscaler.
    if (mig.get("status") or {}).get("autoscaler"):
        raise SystemExit("HOLD: attached autoscaler exists but policy is not readable")
    print("new")
    raise SystemExit(0)
if not isinstance(attached, dict):
    raise SystemExit("HOLD: unexpected autoscaler representation")
policy = attached.get("autoscalingPolicy") or {}
metrics = policy.get("customMetricUtilizations") or []
metric_filter = f'resource.type="pubsub_subscription" AND resource.labels.subscription_id="{subscription}"'
if not (
    policy.get("minNumReplicas") == 0
    and policy.get("maxNumReplicas") == 1
    and policy.get("stabilizationPeriodSec") == 2700
    and policy.get("mode", "ON") == "ON"
    and len(metrics) == 1
    and metrics[0].get("metric") == "pubsub.googleapis.com/subscription/num_undelivered_messages"
    and metrics[0].get("filter") == metric_filter
    and float(metrics[0].get("singleInstanceAssignment", 0)) == 1
    and "cpuUtilization" not in policy
    and "loadBalancingUtilization" not in policy
    and not policy.get("scalingSchedules")
):
    raise SystemExit("refusing to replace a nonmatching warm runner autoscaler")
print("already")
PY
)"
if [[ "$autoscaler_state" == "already" ]]; then
  echo "Exact warm runner autoscaling policy already verified; nothing to mutate"
  exit 0
fi
if [[ "$autoscaler_state" != "new" ]]; then
  echo "warm runner autoscaling preflight returned an unexpected state" >&2
  exit 1
fi

# A subscription's unacknowledged count includes in-flight runner messages. The
# agent acknowledges only after runner completion and cleanup. No VM IAM expansion.
gcloud compute instance-groups managed set-autoscaling "$MIG" \
  --project="$PROJECT_ID" --zone="$ZONE" \
  --min-num-replicas=0 --max-num-replicas=1 \
  --stabilization-period=2700 \
  --update-stackdriver-metric=pubsub.googleapis.com/subscription/num_undelivered_messages \
  --stackdriver-metric-filter="resource.type=\"pubsub_subscription\" AND resource.labels.subscription_id=\"$SUBSCRIPTION\"" \
  --stackdriver-metric-single-instance-assignment=1

# Wait for the attached autoscaler policy to become visible on the managed group.
for readback_attempt in $(seq 1 12); do
  gcloud compute instance-groups managed describe "$MIG" \
    --project="$PROJECT_ID" --zone="$ZONE" --format=json > "$MIG_JSON"
  if python3 - "$MIG_JSON" "$ZONE" "$MIG" "$SUBSCRIPTION" <<'PY'
import json
import sys

path, zone, name, subscription = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    mig = json.load(handle)
if mig.get("name") != name or str(mig.get("zone") or "").rsplit("/", 1)[-1] != zone:
    raise SystemExit(1)
attached = mig.get("autoscaler")
if not isinstance(attached, dict):
    raise SystemExit(1)
policy = attached.get("autoscalingPolicy") or {}
metrics = policy.get("customMetricUtilizations") or []
if not (
    policy.get("minNumReplicas") == 0
    and policy.get("maxNumReplicas") == 1
    and policy.get("stabilizationPeriodSec") == 2700
    and policy.get("mode", "ON") == "ON"
    and len(metrics) == 1
    and metrics[0].get("metric") == "pubsub.googleapis.com/subscription/num_undelivered_messages"
    and metrics[0].get("filter") == f'resource.type="pubsub_subscription" AND resource.labels.subscription_id="{subscription}"'
    and float(metrics[0].get("singleInstanceAssignment", 0)) == 1
    and "cpuUtilization" not in policy
    and "loadBalancingUtilization" not in policy
    and not policy.get("scalingSchedules")
):
    raise SystemExit(1)
print("Warm runner autoscaler readback PASS: zero-to-one, 2700-second stabilization, exact Pub/Sub backlog")
PY
  then
    exit 0
  fi
  if [[ "$readback_attempt" != 12 ]]; then sleep 10; fi
done
echo "HOLD: warm runner autoscaler policy readback mismatch; inspect the managed group before retry" >&2
exit 1
