import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  isEligibleRunnerJob,
  parseRunnerAutoscalerConfig,
  runnerSchedulingLabel,
} from '../src/transport/gcp-runner-autoscaler.ts';

const validConfig = {
  schema: 'overcenter-gcp-runner-autoscaler/v1',
  poll_interval_ms: 10_000,
  redispatch_after_ms: 600_000,
  runner_label: 'overcenter-gcp',
  repositories: [
    {
      full_name: 'laurajoyhutchins/arcata',
      repository_id: 1_402_666_660,
      owner_id: 219_002_713,
    },
    {
      full_name: 'laurajoyhutchins/azelficoast',
      repository_id: 1_384_608_118,
      owner_id: 219_002_713,
    },
    {
      full_name: 'laurajoyhutchins/laura-dev-tools',
      repository_id: 1_383_875_536,
      owner_id: 219_002_713,
    },
    {
      full_name: 'laurajoyhutchins/overcenter',
      repository_id: 1_354_872_053,
      owner_id: 219_002_713,
    },
  ],
};

test('autoscaler config preserves immutable repository identities', () => {
  const parsed = parseRunnerAutoscalerConfig(validConfig);
  assert.equal(parsed.repositories[0]?.repository_id, 1_402_666_660);
  assert.equal(parsed.repositories[0]?.owner_id, 219_002_713);
  assert.equal(parsed.repositories[1]?.repository_id, 1_384_608_118);
  assert.equal(parsed.repositories[1]?.owner_id, 219_002_713);
  assert.equal(parsed.repositories[2]?.repository_id, 1_383_875_536);
  assert.equal(parsed.repositories[2]?.owner_id, 219_002_713);
  assert.equal(parsed.repositories[3]?.repository_id, 1_354_872_053);
  assert.equal(parsed.repositories[3]?.owner_id, 219_002_713);
});

test('autoscaler config rejects the retired GitHub-hosted dispatch layer', () => {
  assert.throws(
    () =>
      parseRunnerAutoscalerConfig({
        ...validConfig,
        dispatch: {
          repository: 'laurajoyhutchins/overcenter',
          workflow: 'gcp-runner-launch.yml',
        },
      }),
    /unexpected runner autoscaler config key: dispatch/,
  );
});

test('autoscaler config rejects duplicate repository authorities', () => {
  const duplicate = {
    ...validConfig,
    repositories: [...validConfig.repositories, validConfig.repositories[0]],
  };
  assert.throws(() => parseRunnerAutoscalerConfig(duplicate), /duplicate repository binding/);
});

test('queued jobs resolve exactly one GCP scheduling label', () => {
  const exact = {
    id: 1,
    status: 'queued',
    labels: ['self-hosted', 'overcenter-gcp-123456-check'],
  };
  assert.equal(runnerSchedulingLabel(exact, 'overcenter-gcp'), 'overcenter-gcp-123456-check');
  assert.equal(isEligibleRunnerJob(exact, 'overcenter-gcp'), true);

  assert.equal(
    runnerSchedulingLabel(
      {
        id: 2,
        status: 'queued',
        labels: ['self-hosted', 'overcenter-gcp'],
      },
      'overcenter-gcp',
    ),
    'overcenter-gcp',
  );
  assert.equal(
    isEligibleRunnerJob(
      {
        id: 3,
        status: 'in_progress',
        labels: ['self-hosted', 'overcenter-gcp-123456-check'],
      },
      'overcenter-gcp',
    ),
    false,
  );
  assert.equal(
    isEligibleRunnerJob(
      {
        id: 4,
        status: 'queued',
        labels: ['self-hosted', 'overcenter-gcp', 'overcenter-gcp-123456-check'],
      },
      'overcenter-gcp',
    ),
    false,
  );
  assert.equal(
    isEligibleRunnerJob(
      {
        id: 5,
        status: 'queued',
        labels: ['self-hosted', 'overcenter-gcpish'],
      },
      'overcenter-gcp',
    ),
    false,
  );
  assert.equal(
    isEligibleRunnerJob(
      {
        id: 6,
        status: 'queued',
        labels: ['ubuntu-latest'],
      },
      'overcenter-gcp',
    ),
    false,
  );
});

test('runner image pins rustup bootstrap for repository verification', () => {
  const dockerfile = readFileSync(
    new URL('../infra/gcp-runner-image/Dockerfile', import.meta.url),
    'utf8',
  );
  assert.match(dockerfile, /ARG RUSTUP_VERSION=1\.28\.2/);
  assert.match(
    dockerfile,
    /ARG RUSTUP_SHA256=20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c/,
  );
  assert.match(dockerfile, /--default-toolchain none/);
  assert.doesNotMatch(dockerfile, /docker\.sock|--privileged/);
});

test('deployment lane keeps only the latest exact substrate revision', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/gcp-runner-autoscaler-deploy.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /group: deploy-gcp-runner-autoscaler/);
  assert.match(workflow, /cancel-in-progress: true/);
});

test('autoscaler deployment uses a unique exact-job GCP runner', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/gcp-runner-autoscaler-deploy.yml', import.meta.url),
    'utf8',
  );
  assert.match(
    workflow,
    /runs-on: \[self-hosted, "overcenter-gcp-\$\{\{ github\.run_id \}\}-deploy-\$\{\{ github\.run_attempt \}\}"\]/,
  );
  assert.doesNotMatch(workflow, /runs-on: ubuntu-/);
  assert.match(workflow, /cancel-in-progress: true/);
});
test('substrate recovery is owner-only, manual, and bound to the selected infrastructure revision', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/gcp-runner-autoscaler-recovery.yml', import.meta.url),
    'utf8',
  );

  assert.ok(workflow.includes('on:\n  workflow_dispatch:\n'));
  assert.doesNotMatch(workflow, /^\s{2}(?:push|pull_request|schedule|workflow_run):/m);
  assert.ok(workflow.includes('test "$GITHUB_REPOSITORY" = "laurajoyhutchins/overcenter"'));
  assert.ok(workflow.includes('test "$GITHUB_ACTOR" = "$GITHUB_REPOSITORY_OWNER"'));
  assert.ok(
    workflow.includes('test "$GITHUB_REF" = "refs/heads/work/gcp-cloud-run-cloud-sql-bootstrap"'),
  );
  const shaExpression = '$' + '{{ github.sha }}';
  assert.ok(workflow.includes('EXACT_REVISION: ' + shaExpression));
  assert.ok(workflow.includes('ref: ' + shaExpression));
  assert.ok(workflow.includes('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"'));
  assert.ok(workflow.includes('test "$EXACT_REVISION" = "$GITHUB_SHA"'));
  assert.doesNotMatch(workflow, /inputs:|inputs\./);

  const authorizationIndex = workflow.indexOf('name: Prove recovery authorization');
  const authenticationIndex = workflow.indexOf('name: Authenticate to Google Cloud');
  assert.ok(authorizationIndex >= 0 && authorizationIndex < authenticationIndex);
});

test('substrate recovery reuses the ordinary deployer identity, WIF provider, and script', () => {
  const ordinary = readFileSync(
    new URL('../.github/workflows/gcp-runner-autoscaler-deploy.yml', import.meta.url),
    'utf8',
  );
  const recovery = readFileSync(
    new URL('../.github/workflows/gcp-runner-autoscaler-recovery.yml', import.meta.url),
    'utf8',
  );

  for (const value of [
    'overcenter-deployer@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com',
    'projects/380435294892/locations/global/workloadIdentityPools/github/providers/overcenter',
    'google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093',
    'google-github-actions/setup-gcloud@aa5489c8933f4cc7a4f7d45035b3b1440c9c10db',
    'bash infra/gcp/deploy-runner-autoscaler.sh',
  ]) {
    assert.ok(ordinary.includes(value), 'ordinary deployment must contain ' + value);
    assert.ok(recovery.includes(value), 'recovery must reuse ' + value);
  }
});

test('recovery binds the deployed services to the exact checked-out revision', () => {
  const deploy = readFileSync(
    new URL('../infra/gcp/deploy-runner-autoscaler.sh', import.meta.url),
    'utf8',
  );

  assert.ok(deploy.includes('test "$(git rev-parse HEAD)" = "$EXACT_REVISION"'));
  const sourceRevisionAssignment =
    'OVERCENTER_SOURCE_REVISION=' + String.fromCharCode(36) + '{EXACT_REVISION}';
  assert.ok(deploy.includes(sourceRevisionAssignment));
  assert.ok(deploy.includes('autoscaler source revision readback mismatch'));
});

test('recovery authorization executes hostile invocation and revision cases', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/gcp-runner-autoscaler-recovery.yml', import.meta.url),
    'utf8',
  );
  const guard = workflow.match(
    /name: Prove recovery authorization\n        shell: bash\n        run: \|\n((?:          .+\n)+)/,
  )?.[1];
  assert.ok(guard, 'the deployed authorization guard must be executable');
  const sha = 'a'.repeat(40);
  const authorized = {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: 'laurajoyhutchins/overcenter',
    GITHUB_REPOSITORY_OWNER: 'laurajoyhutchins',
    GITHUB_ACTOR: 'laurajoyhutchins',
    GITHUB_TRIGGERING_ACTOR: 'laurajoyhutchins',
    GITHUB_REF: 'refs/heads/work/gcp-cloud-run-cloud-sql-bootstrap',
    GITHUB_SHA: sha,
    EXACT_REVISION: sha,
    CHECKED_OUT_SHA: sha,
  };
  const run = (overrides: Record<string, string>) =>
    spawnSync('bash', ['-c', 'git() { echo "$CHECKED_OUT_SHA"; }\n' + guard], {
      env: { ...process.env, ...authorized, ...overrides },
      encoding: 'utf8',
    });
  assert.equal(run({}).status, 0, 'owner dispatch of the exact infra revision is allowed');
  const hostileCases: Record<string, string>[] = [
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REPOSITORY: 'attacker/overcenter' },
    { GITHUB_ACTOR: 'collaborator' },
    { GITHUB_TRIGGERING_ACTOR: 'collaborator' },
    { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_REF: 'refs/tags/recovery' },
    { GITHUB_SHA: 'not-a-sha' },
    { EXACT_REVISION: 'b'.repeat(40) },
    { CHECKED_OUT_SHA: 'b'.repeat(40) },
  ];
  for (const overrides of hostileCases) {
    assert.notEqual(run(overrides).status, 0, JSON.stringify(overrides));
  }
});

