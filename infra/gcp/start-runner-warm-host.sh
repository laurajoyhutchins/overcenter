#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${OVERCENTER_RUNNER_CONTROL_IMAGE:?OVERCENTER_RUNNER_CONTROL_IMAGE is required}"
: "${OVERCENTER_RUNNER_IMAGE:?OVERCENTER_RUNNER_IMAGE is required}"
: "${OVERCENTER_RUNNER_SUBSCRIPTION:?OVERCENTER_RUNNER_SUBSCRIPTION is required}"

WORK_ROOT="/var/lib/overcenter-runner/jobs"
AGENT_NAME="overcenter-gce-runner-agent"

for command in docker docker-credential-gcr iptables mount mountpoint; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "required command missing: $command" >&2
    exit 2
  }
done

registry_host() {
  local image="$1"
  if [[ ! "$image" =~ ^([^/]+)/.+@sha256:[0-9a-f]{64}$ ]]; then
    echo "runner image must be an immutable Artifact Registry reference: $image" >&2
    exit 2
  fi
  local registry="${BASH_REMATCH[1]}"
  if [[ "$registry" != *-docker.pkg.dev ]]; then
    echo "runner image must use Artifact Registry: $image" >&2
    exit 2
  fi
  printf '%s\n' "$registry"
}

CONTROL_REGISTRY="$(registry_host "$OVERCENTER_RUNNER_CONTROL_IMAGE")"
RUNNER_REGISTRY="$(registry_host "$OVERCENTER_RUNNER_IMAGE")"
REGISTRIES="$CONTROL_REGISTRY"
if [[ "$RUNNER_REGISTRY" != "$CONTROL_REGISTRY" ]]; then
  REGISTRIES="$REGISTRIES,$RUNNER_REGISTRY"
fi

# COS provides executable stateful storage under /var/lib/docker.
# Keep the agent's admitted work-root path through a host bind mount.
mkdir -p /var/lib/docker/overcenter-runner /var/lib/overcenter-runner
chmod 0700 /var/lib/docker/overcenter-runner /var/lib/overcenter-runner
if ! mountpoint -q /var/lib/overcenter-runner; then
  mount --bind /var/lib/docker/overcenter-runner /var/lib/overcenter-runner
fi
export DOCKER_CONFIG="/var/lib/docker/overcenter-docker-config"
mkdir -p "$DOCKER_CONFIG"
chmod 0700 "$DOCKER_CONFIG"

docker-credential-gcr configure-docker --registries="$REGISTRIES"
docker pull "$OVERCENTER_RUNNER_CONTROL_IMAGE"
docker pull "$OVERCENTER_RUNNER_IMAGE"

mkdir -p "$WORK_ROOT"
chmod 0700 /var/lib/overcenter-runner "$WORK_ROOT"

if ! iptables -C DOCKER-USER -d 169.254.169.254/32 -j REJECT >/dev/null 2>&1; then
  iptables -I DOCKER-USER 1 -d 169.254.169.254/32 -j REJECT
fi

docker rm -f "$AGENT_NAME" >/dev/null 2>&1 || true
exec docker run   --name "$AGENT_NAME"   --restart=always   --user 0:0   --network host   --volume /var/run/docker.sock:/var/run/docker.sock   --volume /var/lib/overcenter-runner:/var/lib/overcenter-runner   --env "GCP_PROJECT_ID=$GCP_PROJECT_ID"   --env "OVERCENTER_RUNNER_SUBSCRIPTION=$OVERCENTER_RUNNER_SUBSCRIPTION"   --env "OVERCENTER_RUNNER_IMAGE=$OVERCENTER_RUNNER_IMAGE"   --env "OVERCENTER_RUNNER_WORK_ROOT=$WORK_ROOT"   "$OVERCENTER_RUNNER_CONTROL_IMAGE"   node --experimental-strip-types src/transport/gce-runner-agent.ts
