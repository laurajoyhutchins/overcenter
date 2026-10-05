import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  createRunnerBuild,
  matchRepositoryBinding,
  parseRunnerLaunchRequest,
  type LauncherEnvironment,
} from '../src/transport/gcp-runner-launcher.ts';
import { parseRunnerAutoscalerConfig } from '../src/transport/gcp-runner-autoscaler.ts';

interface RecoveryRequest {
  schema: 'overcenter-gcp-runner-recovery/v1';
  runner_image: string;
  jobs: unknown[];
}

function validateRecoveryRequest(value: unknown): RecoveryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('recovery request must be an object');
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['jobs', 'runner_image', 'schema'])) {
    throw new TypeError('recovery request keys are invalid');
  }
  if (body.schema !== 'overcenter-gcp-runner-recovery/v1') {
    throw new TypeError('recovery request schema is unsupported');
  }
  if (
    typeof body.runner_image !== 'string' ||
    !body.runner_image.startsWith(
      'us-west1-docker.pkg.dev/project-6b810532-a302-48dc-b56/',
    ) ||
    !/@sha256:[0-9a-f]{64}$/.test(body.runner_image)
  ) {
    throw new TypeError('recovery runner image must be an immutable project digest');
  }
  if (!Array.isArray(body.jobs) || body.jobs.length < 1 || body.jobs.length > 10) {
    throw new TypeError('recovery request must contain between 1 and 10 jobs');
  }
  return {
    schema: body.schema,
    runner_image: body.runner_image,
    jobs: body.jobs,
  };
}

function accessToken(): string {
  return execFileSync('gcloud', ['auth', 'print-access-token'], {
    encoding: 'utf8',
  }).trim();
}

async function submitBuild(
  environment: LauncherEnvironment,
  build: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(
    'https://cloudbuild.googleapis.com/v1/projects/' +
      encodeURIComponent(environment.projectId) +
      '/locations/' +
      encodeURIComponent(environment.region) +
      '/builds',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(build),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      'Cloud Build recovery submission failed with HTTP ' +
        response.status +
        ': ' +
        text.slice(0, 500),
    );
  }
  const body = JSON.parse(text) as Record<string, unknown>;
  const metadata =
    body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? (body.metadata as Record<string, unknown>)
      : {};
  const buildValue =
    metadata.build && typeof metadata.build === 'object' && !Array.isArray(metadata.build)
      ? (metadata.build as Record<string, unknown>)
      : {};
  const id = String(buildValue.id ?? '').trim();
  if (!id) throw new Error('Cloud Build recovery response did not include a build id');
  return id;
}

function describeBuild(buildId: string, format: string): string {
  return execFileSync(
    'gcloud',
    [
      'builds',
      'describe',
      buildId,
      '--project=project-6b810532-a302-48dc-b56',
      '--region=us-west1',
      '--format=' + format,
    ],
    { encoding: 'utf8' },
  ).trim();
}

async function proveBuildStarted(buildId: string): Promise<string> {
  const terminal = new Set([
    'FAILURE',
    'INTERNAL_ERROR',
    'TIMEOUT',
    'CANCELLED',
    'EXPIRED',
  ]);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = describeBuild(buildId, 'value(status)');
    if (status === 'WORKING' || status === 'SUCCESS') return status;
    if (terminal.has(status)) {
      const detail = describeBuild(buildId, 'value(failureInfo.detail)');
      throw new Error(
        'recovery Cloud Build ' +
          buildId +
          ' terminated as ' +
          status +
          (detail ? ': ' + detail : ''),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('recovery Cloud Build ' + buildId + ' did not start within 60 seconds');
}

async function main(): Promise<void> {
  const requestPath = process.argv[2];
  if (!requestPath) throw new Error('recovery request path is required');

  const request = validateRecoveryRequest(
    JSON.parse(readFileSync(requestPath, 'utf8')) as unknown,
  );
  const config = parseRunnerAutoscalerConfig(
    JSON.parse(readFileSync('config/gcp-runner-autoscaler.json', 'utf8')) as unknown,
  );
  const environment: LauncherEnvironment = {
    projectId: 'project-6b810532-a302-48dc-b56',
    region: 'us-west1',
    runtimeServiceAccount:
      'overcenter-runtime@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com',
    runnerImage: request.runner_image,
  };

  for (const raw of request.jobs) {
    const job = parseRunnerLaunchRequest(raw);
    matchRepositoryBinding(config.repositories, job, config.runner_label);
    const buildId = await submitBuild(environment, createRunnerBuild(environment, job));
    console.log(
      JSON.stringify({
        event: 'recovery_runner_build_submitted',
        repository: job.repository,
        repository_id: job.repository_id,
        job_id: job.job_id,
        build_id: buildId,
      }),
    );
    const status = await proveBuildStarted(buildId);
    console.log(
      JSON.stringify({
        event: 'recovery_runner_build_started',
        repository: job.repository,
        job_id: job.job_id,
        build_id: buildId,
        status,
      }),
    );
  }
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.stack ?? error.message : error));
  process.exit(1);
});
