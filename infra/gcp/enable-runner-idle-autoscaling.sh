#!/usr/bin/env bash
set -euo pipefail

# Owner-authorized, one-time migration. Never part of ordinary deployment.
: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${GCP_ZONE:?GCP_ZONE is required}"

PROJECT_ID="$GCP_PROJECT_ID"
ZONE="$GCP_ZONE"
MIG="overcenter-gce-runners"
SUBSCRIPTION="overcenter-gce-runners"
AUTOSCALER_JSON="$(mktemp)"
MIG_JSON="$(mktemp)"
SUBSCRIPTION_JSON="$(mktemp)"
trap 'rm -f "$AUTOSCALER_JSON" "$MIG_JSON" "$SUBSCRIPTION_JSON"' EXIT

for command in gcloud python3; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command is required" >&2; exit 2; }
done

gcloud compute instance-groups managed describe "$MIG" --project="$PROJECT_ID" --zone="$ZONE" --format=json > "$MIG_JSON"
gcloud pubsub subscriptions describe "$SUBSCRIPTION" --project="$PROJECT_ID" --format=json > "$SUBSCRIPTION_JSON"
gcloud compute autoscalers list --project="$PROJECT_ID" --format=json > "$AUTOSCALER_JSON"

# Refuse to overwrite an independently managed autoscaler or a foreign subscription.
python3 - "$MIG_JSON" "$SUBSCRIPTION_JSON" "$AUTOSCALER_JSON" "$PROJECT_ID" "$ZONE" "$MIG" "$SUBSCRIPTION" <<'PY'
import json
import sys

mig_path, subscription_path, autoscalers_path, project, zone, name, subscription = sys.argv[1:]
def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)

mig, sub, autoscalers = load(mig_path), load(subscription_path), load(autoscalers_path)
if int(mig.get("targetSize", -1)) not in (0, 1):
    raise SystemExit("warm runner MIG is not bounded to one host")
if not str(mig.get("instanceTemplate") or "").rsplit("/", 1)[-1].startswith("overcenter-gce-runner-"):
    raise SystemExit("warm runner MIG instance template does not match the admitted family")
if str(sub.get("topic") or "").rsplit("/", 1)[-1] != subscription:
    raise SystemExit("warm runner subscription has an unexpected source")
target = f"/projects/{project}/zones/{zone}/instanceGroupManagers/{name}"
metric_filter = f'resource.type="pubsub_subscription" AND resource.labels.subscription_id="{subscription}"'
for autoscaler in autoscalers:
    if not str(autoscaler.get("target") or "").endswith(target):
        continue
    policy = autoscaler.get("autoscalingPolicy") or {}
    metrics = policy.get("customMetricUtilizations") or []
    if not (
        policy.get("minNumReplicas") == 0
        and policy.get("maxNumReplicas") == 1
        and policy.get("stabilizationPeriodSec") == 2700
        and len(metrics) == 1
        and metrics[0].get("metric") == "pubsub.googleapis.com/subscription/num_undelivered_messages"
        and metrics[0].get("filter") == metric_filter
        and float(metrics[0].get("singleInstanceAssignment", 0)) == 1
        and "cpuUtilization" not in policy
        and "loadBalancingUtilization" not in policy
    ):
        raise SystemExit("refusing to replace a nonmatching warm runner autoscaler")
    print("Warm runner autoscaler already configured; no mutation required")
    raise SystemExit(0)
print("Warm runner autoscaler not yet configured; owner bootstrap may proceed")
PY

# A subscription's unacknowledged count includes in-flight runner messages. The
# agent acknowledges only after runner completion and cleanup. No VM IAM expansion.
gcloud compute instance-groups managed set-autoscaling "$MIG" \
  --project="$PROJECT_ID" --zone="$ZONE" \
  --min-num-replicas=0 --max-num-replicas=1 \
  --stabilization-period=2700 \
  --update-stackdriver-metric=pubsub.googleapis.com/subscription/num_undelivered_messages \
  --stackdriver-metric-filter="resource.type=\"pubsub_subscription\" AND resource.labels.subscription_id=\"$SUBSCRIPTION\"" \
  --stackdriver-metric-single-instance-assignment=1

gcloud compute autoscalers list --project="$PROJECT_ID" --format=json > "$AUTOSCALER_JSON"
python3 - "$AUTOSCALER_JSON" "$PROJECT_ID" "$ZONE" "$MIG" "$SUBSCRIPTION" <<'PY'
import json
import sys

path, project, zone, name, subscription = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    autoscalers = json.load(handle)
target = f"/projects/{project}/zones/{zone}/instanceGroupManagers/{name}"
matches = [a for a in autoscalers if str(a.get("target") or "").endswith(target)]
if len(matches) != 1:
    raise SystemExit("warm runner autoscaler readback must identify exactly one target")
policy = matches[0].get("autoscalingPolicy") or {}
metrics = policy.get("customMetricUtilizations") or []
if not (
    policy.get("minNumReplicas") == 0
    and policy.get("maxNumReplicas") == 1
    and policy.get("stabilizationPeriodSec") == 2700
    and len(metrics) == 1
    and metrics[0].get("metric") == "pubsub.googleapis.com/subscription/num_undelivered_messages"
    and metrics[0].get("filter") == f'resource.type="pubsub_subscription" AND resource.labels.subscription_id="{subscription}"'
    and float(metrics[0].get("singleInstanceAssignment", 0)) == 1
    and "cpuUtilization" not in policy
    and "loadBalancingUtilization" not in policy
):
    raise SystemExit("warm runner autoscaler policy readback mismatch")
print("Warm runner autoscaler readback PASS: zero-to-one, 2700-second stabilization, exact Pub/Sub backlog")
PY
