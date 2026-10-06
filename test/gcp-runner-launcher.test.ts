import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createRunnerBuild,
  matchRepositoryBinding,
  parseRunnerLaunchRequest,
  type LauncherEnvironment,
} from '../src/transport/gcp-runner-launcher.ts';

const request = {
  repository: 'laurajoyhutchins/arcata',
  repository_id: 1_402_666_660,
  owner_id: 219_002_713,
  job_id: 111_891_233_183,
  runner_label: 'overcenter-gcp',
};

const repositories = [
  {
    full_name: 'laurajoyhutchins/arcata',
    repository_id: 1_402_666_660,
    owner_id: 219_002_713,
  },
];

const environment: LauncherEnvironment = {
  projectId: 'project-6b810532-a302-48dc-b56',
  region: 'us-west1',
  runtimeServiceAccount:
    'overcenter-runtime@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com',
  runnerImage:
    'us-west1-docker.pkg.dev/project-6b810532-a302-48dc-b56/cloud-run-source-deploy/overcenter-gcp-runner@sha256:' +
    'a'.repeat(64),
};

test('launcher binds repository name, numeric identity, owner, job, and label', () => {
  const parsed = parseRunnerLaunchRequest(request);
  assert.deepEqual(matchRepositoryBinding(repositories, parsed), repositories[0]);
  assert.throws(
    () => matchRepositoryBinding(repositories, { ...parsed, repository_id: 1 }),
    /repository identity mismatch/,
  );
  assert.throws(
    () => matchRepositoryBinding(repositories, parsed, 'different-runner'),
    /runner launch label mismatch/,
  );
});

test('launcher rejects stale workflow-dispatch-shaped requests', () => {
  assert.throws(
    () => parseRunnerLaunchRequest({ ...request, workflow: 'gcp-runner-launch.yml' }),
    /unexpected runner launch request key: workflow/,
  );
});

test('launcher creates a secret-backed isolated one-job Cloud Build', () => {
  const build = createRunnerBuild(environment, parseRunnerLaunchRequest(request));
  assert.equal(
    build.serviceAccount,
    'projects/project-6b810532-a302-48dc-b56/serviceAccounts/' + environment.runtimeServiceAccount,
  );

  assert.equal(build.queueTtl, '90s');

  const steps = build.steps as Array<Record<string, unknown>>;
  assert.equal(steps.length, 2);
  assert.equal(steps[0]?.id, 'authorize-job');
  assert.equal(steps[1]?.id, 'github-runner');

  const args = steps[1]?.args as string[];
  const script = args[1] ?? '';
  assert.match(script, /docker run --rm --network bridge/);
  assert.match(script, /RUNNER_LABEL=overcenter-gcp/);
  assert.match(script, /test -s \/workspace\/jit-config/);
  assert.match(script, /runner-output\.log/);
  assert.match(script, /\/builder\/outputs\/output/);
  assert.match(script, /runner-success/);
  assert.doesNotMatch(script, /registration-token/);
  assert.match(script, /@sha256:a{64}/);

  const authorization = JSON.stringify(steps[0]);
  assert.match(authorization, /generate-jitconfig/);
  assert.match(authorization, /encoded_jit_config/);
  assert.match(authorization, /RUNNER_NAME=overcenter-gcp-111891233183-\$BUILD_ID/);
  assert.match(authorization, /RUNNER_LABEL=overcenter-gcp/);
  assert.match(authorization, /labels: \['self-hosted', 'Linux', 'X64', runnerLabel\]/);
  assert.doesNotMatch(authorization, /registration-token/);

  const secrets = build.availableSecrets as {
    secretManager: Array<Record<string, unknown>>;
  };
  assert.equal(secrets.secretManager[0]?.env, 'GITHUB_APP_PRIVATE_KEY');
  assert.equal(
    secrets.secretManager[0]?.versionName,
    'projects/project-6b810532-a302-48dc-b56/secrets/' +
      'overcenter-github-app-private-key/versions/latest',
  );
  assert.equal(JSON.stringify(build).includes('registration-token='), false);
});

test('runner image consumes one-time JIT configuration without persistent registration', () => {
  const entrypoint = readFileSync(
    new URL('../infra/gcp-runner-image/entrypoint.sh', import.meta.url),
    'utf8',
  );
  assert.match(entrypoint, /\[\[ ! -s \/workspace\/jit-config \]\]/);
  assert.match(entrypoint, /rm -f \/workspace\/jit-config/);
  assert.match(entrypoint, /exec \.\/run\.sh --jitconfig "\$jit_config"/);
  assert.doesNotMatch(entrypoint, /\.\/config\.sh/);
  assert.doesNotMatch(entrypoint, /registration-token/);
});

test('dedicated launcher identity preserves the deployment authority split', () => {
  const deploy = readFileSync(
    new URL('../infra/gcp/deploy-runner-autoscaler.sh', import.meta.url),
    'utf8',
  );
  const bootstrap = readFileSync(
    new URL('../infra/gcp/bootstrap-runner-launcher-iam.sh', import.meta.url),
    'utf8',
  );
  const controlImage = readFileSync(
    new URL('../infra/gcp-runner-control/Dockerfile', import.meta.url),
    'utf8',
  );

  assert.match(
    deploy,
    /LAUNCHER_SA="overcenter-runner-launcher@\$\{PROJECT_ID\}\.iam\.gserviceaccount\.com"/,
  );
  assert.match(deploy, /--service-account="\$LAUNCHER_SA"/);
  assert.match(deploy, /--service-account="\$RUNTIME_SA"/);
  assert.match(deploy, /--image="\$CONTROL_IMAGE_IMMUTABLE"/);
  assert.match(deploy, /gcloud run worker-pools deploy "\$AUTOSCALER_WORKER_POOL"/);
  assert.match(deploy, /--instances=0/);
  assert.match(deploy, /gcloud run services delete "\$LEGACY_AUTOSCALER_SERVICE"/);
  assert.match(deploy, /gcloud run worker-pools update "\$AUTOSCALER_WORKER_POOL"/);
  assert.match(deploy, /--instances=1/);
  assert.match(deploy, /Launcher:\s+private warm Cloud Run service/);
  assert.doesNotMatch(deploy, /gcloud run deploy "\$AUTOSCALER_SERVICE"/);
  assert.doesNotMatch(deploy, /gcloud projects add-iam-policy-binding/);
  assert.doesNotMatch(deploy, /gcloud iam service-accounts add-iam-policy-binding/);
  assert.doesNotMatch(deploy, /gcloud run services add-iam-policy-binding/);

  assert.match(bootstrap, /roles\/cloudbuild\.builds\.editor/);
  assert.match(bootstrap, /roles\/serviceusage\.serviceUsageConsumer/);
  assert.match(bootstrap, /roles\/artifactregistry\.reader/);
  assert.match(bootstrap, /gcloud artifacts repositories add-iam-policy-binding/);
  assert.match(bootstrap, /roles\/iam\.serviceAccountUser/);
  assert.match(bootstrap, /roles\/run\.invoker/);
  assert.match(bootstrap, /serviceAccount:\$\{LAUNCHER_SA\}/);
  assert.match(bootstrap, /serviceAccount:\$\{RUNTIME_SA\}/);
  assert.match(bootstrap, /serviceAccount:\$\{DEPLOYER_SA\}/);

  for (const forbidden of [
    'roles/owner',
    'roles/editor',
    'roles/iam.serviceAccountAdmin',
    'roles/secretmanager.secretAccessor',
    'roles/run.admin',
    'roles/artifactregistry.writer',
    'roles/artifactregistry.admin',
  ]) {
    assert.equal(bootstrap.includes(forbidden), false, `bootstrap must not grant ${forbidden}`);
  }

  assert.match(controlImage, /^FROM node:22\.16\.0-bookworm-slim/m);
  assert.match(controlImage, /^USER node$/m);
});
