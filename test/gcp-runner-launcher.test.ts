import assert from 'node:assert/strict';
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

  const steps = build.steps as Array<Record<string, unknown>>;
  assert.equal(steps.length, 2);
  assert.equal(steps[0]?.id, 'authorize-job');
  assert.equal(steps[1]?.id, 'github-runner');

  const args = steps[1]?.args as string[];
  const script = args[1] ?? '';
  assert.match(script, /docker run --rm --network bridge --dns 8\.8\.8\.8 --dns 8\.8\.4\.4/);
  assert.match(
    script,
    /us-west1-docker\.pkg\.dev\/project-6b810532-a302-48dc-b56\/cloud-run-source-deploy\/overcenter-gcp-runner@sha256:/,
  );
  assert.match(script, /RUNNER_LABEL=overcenter-gcp/);
  assert.match(script, /TARGET_JOB_ID=111891233183/);
  assert.doesNotMatch(script, /docker login|artifact-registry-token/);

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
