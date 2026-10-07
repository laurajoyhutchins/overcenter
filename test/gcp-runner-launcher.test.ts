import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  createRunnerBuild,
  findReusableRunnerBuild,
  matchRepositoryBinding,
  parseRunnerLaunchRequest,
  runnerBuildTags,
  type LauncherEnvironment,
} from '../src/transport/gcp-runner-launcher.ts';

const request = {
  repository: 'laurajoyhutchins/arcata',
  repository_id: 1_402_666_660,
  owner_id: 219_002_713,
  job_id: 111_891_233_183,
  runner_label: 'overcenter-gcp-123456-check',
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
  assert.deepEqual(matchRepositoryBinding(repositories, parsed, 'overcenter-gcp'), repositories[0]);
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

test('JIT registration preserves every requested job label so specific jobs can be scheduled', async () => {
  const build = createRunnerBuild(environment, request);
  const step = (build.steps as Array<{ id?: string; args: string[]; env?: string[] }>).find(
    (candidate) => candidate.id === 'authorize-job',
  );
  assert.ok(step);
  assert.ok(step.env);
  const env = Object.fromEntries(
    step.env.map((entry) => [
      entry.slice(0, entry.indexOf('=')),
      entry.slice(entry.indexOf('=') + 1),
    ]),
  );
  env.RUNNER_NAME = `overcenter-gcp-${request.job_id}-test-build`;
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  env.GITHUB_APP_PRIVATE_KEY = key.export({ type: 'pkcs8', format: 'pem' }).toString();
  const require = createRequire(import.meta.url);
  let registration: Record<string, unknown> | undefined;
  await runInNewContext(step.args[1] ?? '', {
    Buffer,
    console,
    process: {
      env,
      exit: (code: number) => {
        throw new Error(`authorization exited ${code}`);
      },
    },
    require: (name: string) => (name === 'fs' ? { writeFileSync: () => {} } : require(name)),
    fetch: async (url: string, options: { body?: string }) => {
      let body: unknown;
      if (url.endsWith('/installation'))
        body = { id: 1, permissions: { administration: 'write', actions: 'read' } };
      else if (url.endsWith('/access_tokens')) body = { token: 'test-installation-token' };
      else if (url.endsWith(`/actions/jobs/${request.job_id}`))
        body = {
          id: request.job_id,
          status: 'queued',
          labels: ['self-hosted', 'overcenter-gcp-123456-check', 'exact-canary'],
        };
      else if (url.endsWith('/generate-jitconfig')) {
        registration = JSON.parse(options.body ?? '{}') as Record<string, unknown>;
        body = { encoded_jit_config: 'test-jit-config' };
      } else if (url === `https://api.github.com/repos/${request.repository}`)
        body = {
          id: request.repository_id,
          owner: { id: request.owner_id },
          full_name: request.repository,
        };
      else throw new Error(`unexpected GitHub request ${url}`);
      return { ok: true, text: async () => JSON.stringify(body) };
    },
  });
  assert.ok(registration);
  assert.deepEqual(registration.labels, [
    'Linux',
    'X64',
    'exact-canary',
    'overcenter-gcp-123456-check',
    'self-hosted',
  ]);
});

test('launcher creates a secret-backed isolated one-job Cloud Build', () => {
  const build = createRunnerBuild(environment, parseRunnerLaunchRequest(request));
  assert.equal(
    build.serviceAccount,
    'projects/project-6b810532-a302-48dc-b56/serviceAccounts/' + environment.runtimeServiceAccount,
  );
  assert.equal(build.timeout, '3600s');
  assert.equal(build.queueTtl, '540s');
  assert.deepEqual(build.tags, ['overcenter-runner', 'repository-1402666660', 'job-111891233183']);
  assert.deepEqual(build.options, { logging: 'CLOUD_LOGGING_ONLY' });

  const steps = build.steps as Array<Record<string, unknown>>;
  assert.equal(steps.length, 3);
  assert.equal(steps[0]?.id, 'prefetch-runner-image');
  assert.deepEqual(steps[0]?.waitFor, ['-']);
  assert.deepEqual(steps[0]?.args, ['pull', environment.runnerImage]);
  assert.equal(steps[1]?.id, 'authorize-job');
  assert.equal(steps[1]?.name, 'node:22.16.0-bookworm-slim');
  assert.deepEqual(steps[1]?.waitFor, ['-']);
  assert.equal(steps[2]?.id, 'github-runner');
  assert.deepEqual(steps[2]?.waitFor, ['authorize-job', 'prefetch-runner-image']);

  const args = steps[2]?.args as string[];
  const script = args[1] ?? '';
  assert.match(script, /docker run --rm --network bridge --dns 8\.8\.8\.8 --dns 8\.8\.4\.4/);
  assert.match(script, /RUNNER_LABEL=overcenter-gcp-123456-check/);
  assert.match(script, /test -s \/workspace\/jit-config/);
  assert.match(script, /runner-output\.log/);
  assert.match(script, /\/builder\/outputs\/output/);
  assert.match(script, /runner-success/);
  assert.doesNotMatch(script, /registration-token/);
  assert.match(script, /@sha256:a{64}/);

  const authorization = JSON.stringify(steps[1]);
  assert.match(authorization, /generate-jitconfig/);
  assert.match(authorization, /encoded_jit_config/);
  assert.match(authorization, /RUNNER_NAME=overcenter-gcp-111891233183-\$BUILD_ID/);
  assert.match(authorization, /RUNNER_LABEL=overcenter-gcp-123456-check/);
  assert.match(authorization, /const \[identity, job\] = await Promise\.all/);
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

test('Cloud Build history durably suppresses duplicate live or successful runner builds', () => {
  const tags = runnerBuildTags(parseRunnerLaunchRequest(request));
  assert.equal(
    findReusableRunnerBuild(
      {
        builds: [
          { id: 'failed', status: 'FAILURE', tags },
          { id: 'working', status: 'WORKING', tags },
        ],
      },
      tags,
    ),
    'working',
  );
  assert.equal(
    findReusableRunnerBuild({ builds: [{ id: 'success', status: 'SUCCESS', tags }] }, tags),
    'success',
  );
  assert.equal(
    findReusableRunnerBuild({ builds: [{ id: 'failed', status: 'FAILURE', tags }] }, tags),
    null,
  );
  assert.equal(
    findReusableRunnerBuild(
      {
        builds: [
          {
            id: 'wrong-job',
            status: 'WORKING',
            tags: ['overcenter-runner', 'repository-1402666660', 'job-999'],
          },
        ],
      },
      tags,
    ),
    null,
  );
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
  assert.match(deploy, /git rev-parse .*infra\/gcp-runner-image/);
  assert.match(deploy, /gcloud artifacts docker images describe/);
  assert.match(deploy, /tree-\$\{runner_tree\}/);
  assert.doesNotMatch(deploy, /RUNNER_IMAGE=.*git-\$\{EXACT_REVISION\}/);
  assert.doesNotMatch(deploy, /--no-allow-unauthenticated/);
  assert.match(deploy, /unauth_status/);
  assert.match(deploy, /"403"/);
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
