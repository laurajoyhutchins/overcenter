import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('warm-pool bootstrap keeps compute mutation one-time and IAM resource-scoped', () => {
  const bootstrap = readFileSync(
    new URL('../infra/gcp/bootstrap-runner-warm-pool.sh', import.meta.url),
    'utf8',
  );
  assert.match(bootstrap, /gcloud pubsub topics add-iam-policy-binding/);
  assert.match(bootstrap, /roles\/pubsub\.publisher/);
  assert.match(bootstrap, /gcloud pubsub subscriptions add-iam-policy-binding/);
  assert.match(bootstrap, /roles\/pubsub\.subscriber/);
  assert.match(bootstrap, /gcloud compute networks create/);
  assert.match(bootstrap, /gcloud compute routers nats create/);
  assert.match(bootstrap, /--nat-all-subnet-ip-ranges/);
  assert.match(
    bootstrap,
    /--network-interface="network=\$NETWORK,subnet=https:\/\/www\.googleapis\.com\/compute\/v1\/projects\/\$PROJECT_ID\/regions\/\$REGION\/subnetworks\/\$SUBNET,no-address"/,
  );
  assert.doesNotMatch(bootstrap, /--condition=None/);
  assert.match(bootstrap, /startup_hash="\$\(python3/);
  assert.match(
    bootstrap,
    /template="overcenter-gce-runner-\$\{REVISION:0:12\}-\$\{startup_hash\}"/,
  );
  assert.match(bootstrap, /--service-account="\$RUNTIME_SA"/);
  assert.match(bootstrap, /--size=1/);
  assert.match(bootstrap, /--image-family=cos-stable/);
  assert.match(bootstrap, /start-runner-warm-host\.sh/);
  assert.doesNotMatch(bootstrap, /gcloud projects add-iam-policy-binding/);
  assert.doesNotMatch(bootstrap, /roles\/(owner|editor|compute\.admin|iam\.serviceAccountAdmin)/);
  assert.doesNotMatch(bootstrap, /gcloud compute firewall-rules create/);
});

test('recurring deployment routes only explicit warm labels and grants no compute authority', () => {
  const deploy = readFileSync(
    new URL('../infra/gcp/deploy-runner-autoscaler.sh', import.meta.url),
    'utf8',
  );
  assert.match(deploy, /OVERCENTER_GCE_RUNNER_TOPIC=overcenter-gce-runners/);
  assert.match(deploy, /OVERCENTER_GCE_RUNNER_LABEL_PREFIX=overcenter-gcp-warm/);
  assert.doesNotMatch(deploy, /gcloud compute instance-templates/);
  assert.doesNotMatch(deploy, /gcloud compute instance-groups/);
  assert.doesNotMatch(deploy, /gcloud compute networks/);
  assert.doesNotMatch(deploy, /gcloud pubsub .*add-iam-policy-binding/);
});

test('COS warm host binds executable job storage and Docker credentials to private writable storage', () => {
  const host = readFileSync(
    new URL('../infra/gcp/start-runner-warm-host.sh', import.meta.url),
    'utf8',
  );
  assert.match(
    host,
    /mount --bind \/var\/lib\/docker\/overcenter-runner \/var\/lib\/overcenter-runner/,
  );
  assert.match(host, /export DOCKER_CONFIG="\/var\/lib\/docker\/overcenter-docker-config"/);
  assert.match(host, /chmod 0700 "\$DOCKER_CONFIG"/);
  assert.match(host, /iptables -I DOCKER-USER 1 -d 169\.254\.169\.254\/32 -j REJECT/);
  assert.doesNotMatch(host, /\/root\/\.docker/);
});
