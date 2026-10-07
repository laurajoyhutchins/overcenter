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
  assert.match(bootstrap, /--network-interface="network=\$NETWORK,subnet=\$SUBNET,no-address"/);
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
