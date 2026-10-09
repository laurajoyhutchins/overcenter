import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseReconcileMode } from '../src/transport/gcp-runner-autoscaler.ts';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('scheduled reconciliation is explicit and rejects unknown modes', () => {
  assert.equal(parseReconcileMode(undefined), 'polling');
  assert.equal(parseReconcileMode('polling'), 'polling');
  assert.equal(parseReconcileMode('scheduled'), 'scheduled');
  assert.throws(() => parseReconcileMode('off'), /must be polling or scheduled/);
  assert.throws(() => parseReconcileMode('disabled'), /must be polling or scheduled/);
});

test('scheduled mode awaits each authenticated request instead of relying on idle timers', () => {
  const autoscaler = source('../src/transport/gcp-runner-autoscaler.ts');
  assert.match(autoscaler, /request\.method === 'POST' &&\s+request\.url === '\/reconcile'/);
  assert.match(autoscaler, /await pollOnce\(client, config, state, launcherUrl\)/);
  assert.match(autoscaler, /response\.statusCode = state\.lastError === null \? 200 : 503/);
  assert.match(autoscaler, /if \(reconcileMode === 'polling'\)/);
  assert.match(autoscaler, /if \(reconcileMode === 'scheduled'\)/);
  assert.doesNotMatch(autoscaler, /queueMicrotask\(\(\) => void pollOnce/);
});

test('owner-only Scheduler bootstrap restricts invocation to a private Cloud Run service', () => {
  const bootstrap = source('../infra/gcp/bootstrap-runner-reconcile-scheduler.sh');
  assert.match(bootstrap, /roles\/run\.invoker/);
  assert.match(bootstrap, /overcenter-runner-scheduler/);
  assert.match(bootstrap, /--oidc-service-account-email=/);
  assert.match(bootstrap, /--oidc-token-audience=/);
  assert.match(bootstrap, /--http-method=POST/);
  assert.match(bootstrap, /--schedule='\* \* \* \* \*'/);
  assert.match(bootstrap, /allAuthenticatedUsers/);
  assert.doesNotMatch(bootstrap, /roles\/(owner|editor|compute\.admin|run\.admin)/);
  assert.doesNotMatch(bootstrap, /--allow-unauthenticated/);
});

test('project IAM viewer bootstrap explicitly selects the unconditional binding', () => {
  const bootstrap = source('../infra/gcp/bootstrap-runner-reconcile-scheduler.sh');
  assert.match(bootstrap, /gcloud projects add-iam-policy-binding/);
  assert.match(bootstrap, /--role=roles\/cloudscheduler\.viewer --condition=None --quiet/);
});

test('repeated Scheduler bootstrap observes existing GCP services and IAM before mutation', () => {
  const bootstrap = source('../infra/gcp/bootstrap-runner-reconcile-scheduler.sh');
  assert.match(bootstrap, /gcloud services list --enabled/);
  assert.ok(bootstrap.includes('if [[ "$scheduler_api" != "cloudscheduler.googleapis.com" ]]'));
  assert.match(bootstrap, /gcloud run services get-iam-policy/);
  assert.match(bootstrap, /gcloud projects get-iam-policy/);
  assert.ok(bootstrap.includes('not b.get("condition")'));
  assert.match(bootstrap, /deployer has no unconditional read-only Scheduler inspection grant/);
  assert.doesNotMatch(bootstrap, /gcloud services enable compute.googleapis.com/);
  assert.equal(bootstrap.includes('roles/owner'), false);
  assert.equal(bootstrap.includes('roles/editor'), false);
});

test('ordinary GCP deploy requires verified Scheduler before disabling idle CPU allocation', () => {
  const deploy = source('../infra/gcp/deploy-runner-autoscaler.sh');
  assert.match(deploy, /Scheduler wake path preflight mismatch/);
  assert.match(deploy, /get-iam-policy "\$AUTOSCALER_SERVICE"/);
  assert.match(deploy, /OVERCENTER_RECONCILE_MODE=scheduled/);
  assert.match(deploy, /--min=0/g);
  assert.doesNotMatch(deploy, /--min=1/);
  assert.match(deploy, /--cpu-throttling/);
  assert.doesNotMatch(deploy, /--no-cpu-throttling/);
  assert.doesNotMatch(deploy, /scheduler jobs create/);
  assert.doesNotMatch(deploy, /gcloud projects add-iam-policy-binding/);
});

test('native one-host idle scaler retains in-flight work by relying on unacknowledged Pub/Sub', () => {
  const autoscaler = source('../infra/gcp/enable-runner-idle-autoscaling.sh');
  const agent = source('../src/transport/gce-runner-agent.ts');
  assert.match(autoscaler, /--min-num-replicas=0 --max-num-replicas=1/);
  assert.match(autoscaler, /--stabilization-period=2700/);
  assert.match(autoscaler, /pubsub\.googleapis\.com\/subscription\/num_undelivered_messages/);
  assert.match(autoscaler, /--stackdriver-metric-single-instance-assignment=1/);
  assert.match(autoscaler, /refusing to replace a nonmatching warm runner autoscaler/);
  assert.ok(autoscaler.includes('gcloud compute instance-groups managed describe'));
  assert.ok(autoscaler.includes('mig.get("autoscaler")'));
  assert.ok(autoscaler.includes('attached.get("autoscalingPolicy")'));
  assert.ok(autoscaler.includes('HOLD: unexpected autoscaler representation'));
  assert.doesNotMatch(autoscaler, /gcloud compute autoscalers (?:list|describe)/);
  assert.match(autoscaler, /HOLD: warm runner autoscaler policy readback mismatch/);
  assert.match(agent, /if \(completed\) await acknowledge\(environment, pulled\.ackId\)/);
  assert.match(agent, /await processMessage\(environment, pulled\)/);
  assert.doesNotMatch(autoscaler, /gcloud projects add-iam-policy-binding/);
  assert.doesNotMatch(autoscaler, /roles\/compute\.admin/);
});

test('idle readback reuses existing authorized deployment principal without a second OIDC job', () => {
  const workflow = source('../.github/workflows/gcp-runner-autoscaler-deploy.yml');
  const script = source('../infra/gcp/readback-runner-idle.sh');
  assert.ok(workflow.includes('.overcenter/gcp-warm-idle-readback-request'));
  assert.ok(workflow.includes('git diff --name-only HEAD^ HEAD'));
  assert.ok(workflow.includes('Readback marker cannot be mixed with any other source change'));
  assert.ok(workflow.includes("if: steps.mode.outputs.readback != 'true'"));
  assert.ok(workflow.includes("if: steps.mode.outputs.readback == 'true'"));
  assert.ok(workflow.includes('bash infra/gcp/readback-runner-idle.sh'));
  assert.match(workflow, /GCP_DEPLOY_SERVICE_ACCOUNT: overcenter-deployer@/);
  assert.match(script, /managed list-instances/);
  assert.match(script, /targetSize/);
  assert.match(script, /GCP_WARM_IDLE_READBACK_PASS/);
  assert.doesNotMatch(
    script,
    /gcloud (?:run deploy|services enable|projects add-iam-policy-binding|compute instance-groups managed set-autoscaling)/,
  );
});
