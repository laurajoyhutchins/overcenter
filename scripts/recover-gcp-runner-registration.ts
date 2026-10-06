import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  matchRepositoryBinding,
  parseRunnerLaunchRequest,
} from '../src/transport/gcp-runner-launcher.ts';
import { parseRunnerAutoscalerConfig } from '../src/transport/gcp-runner-autoscaler.ts';

interface RecoveryRequest {
  schema: 'overcenter-gcp-runner-registration-recovery/v1';
  runner_image: string;
  jobs: unknown[];
}

function requireRequest(value: unknown): RecoveryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('registration recovery request must be an object');
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['jobs', 'runner_image', 'schema'])) {
    throw new TypeError('registration recovery request keys are invalid');
  }
  if (body.schema !== 'overcenter-gcp-runner-registration-recovery/v1') {
    throw new TypeError('registration recovery request schema is unsupported');
  }
  const privateRunnerImage =
    typeof body.runner_image === 'string' &&
    body.runner_image.startsWith(
      'us-west1-docker.pkg.dev/project-6b810532-a302-48dc-b56/',
    ) &&
    /@sha256:[0-9a-f]{64}$/.test(body.runner_image);
  const boundedPublicRecoveryImage = body.runner_image === 'ubuntu:24.04';
  if (!privateRunnerImage && !boundedPublicRecoveryImage) {
    throw new TypeError(
      'runner image must be an immutable project digest or the bounded ubuntu:24.04 recovery image',
    );
  }
  if (!Array.isArray(body.jobs) || body.jobs.length < 1 || body.jobs.length > 4) {
    throw new TypeError('registration recovery request must contain between 1 and 4 jobs');
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

const AUTHORIZE_REGISTRATION_SCRIPT = String.raw`
const crypto = require('crypto');
const fs = require('fs');

const repo = process.env.TARGET_REPOSITORY;
const expectedRepositoryId = Number(process.env.TARGET_REPOSITORY_ID);
const expectedOwnerId = Number(process.env.TARGET_OWNER_ID);
const jobId = Number(process.env.TARGET_JOB_ID);
const runnerLabel = process.env.RUNNER_LABEL;
const appId = process.env.GITHUB_APP_ID;

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned =
  b64({ alg: 'RS256', typ: 'JWT' }) + '.' +
  b64({ iat: now - 60, exp: now + 540, iss: appId });
const signature = crypto
  .sign('RSA-SHA256', Buffer.from(unsigned), process.env.GITHUB_APP_PRIVATE_KEY)
  .toString('base64url');
const appJwt = unsigned + '.' + signature;

const baseHeaders = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2026-03-10',
  'User-Agent': 'overcenter-gcp-registration-recovery',
};

async function json(response, label) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    throw new Error(label + ' HTTP ' + response.status + ': ' + text.slice(0, 300));
  }
  return body;
}

async function main() {
  const installation = await json(
    await fetch('https://api.github.com/repos/' + repo + '/installation', {
      headers: { ...baseHeaders, Authorization: 'Bearer ' + appJwt },
    }),
    'installation lookup',
  );
  const permissions =
    installation && typeof installation.permissions === 'object'
      ? installation.permissions
      : {};
  if (String(permissions.administration || '') !== 'write') {
    throw new Error('GitHub App lacks administration:write for runner registration');
  }
  if (!['read', 'write'].includes(String(permissions.actions || ''))) {
    throw new Error('GitHub App lacks actions:read for queued-job validation');
  }

  const access = await json(
    await fetch(
      'https://api.github.com/app/installations/' + installation.id + '/access_tokens',
      {
        method: 'POST',
        headers: {
          ...baseHeaders,
          Authorization: 'Bearer ' + appJwt,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repository_ids: [expectedRepositoryId],
          permissions: { administration: 'write', actions: 'read' },
        }),
      },
    ),
    'installation token',
  );
  const headers = { ...baseHeaders, Authorization: 'Bearer ' + access.token };

  const identity = await json(
    await fetch('https://api.github.com/repos/' + repo, { headers }),
    'repository identity',
  );
  if (
    Number(identity && identity.id) !== expectedRepositoryId ||
    Number(identity && identity.owner && identity.owner.id) !== expectedOwnerId ||
    String(identity && identity.full_name || '').toLowerCase() !== repo.toLowerCase()
  ) {
    throw new Error('repository identity mismatch');
  }

  const job = await json(
    await fetch('https://api.github.com/repos/' + repo + '/actions/jobs/' + jobId, {
      headers,
    }),
    'workflow job lookup',
  );
  const labels = new Set(
    Array.isArray(job && job.labels) ? job.labels.map(value => String(value)) : [],
  );
  if (
    Number(job && job.id) !== jobId ||
    String(job && job.status) !== 'queued' ||
    !labels.has('self-hosted') ||
    !labels.has(runnerLabel)
  ) {
    fs.writeFileSync('/workspace/skip-runner', 'job is no longer eligible\n');
    return;
  }

  const registration = await json(
    await fetch(
      'https://api.github.com/repos/' + repo + '/actions/runners/registration-token',
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
      },
    ),
    'runner registration token',
  );
  const token = String(registration && registration.token || '').trim();
  if (!token) throw new Error('runner registration token response was incomplete');
  fs.writeFileSync('/workspace/runner-registration-token', token, { mode: 0o600 });
}

main().catch(error => {
  console.error(String(error && error.message || error));
  process.exit(1);
});
`;

function createBuild(
  runnerImage: string,
  job: ReturnType<typeof parseRunnerLaunchRequest>,
): Record<string, unknown> {
  const runnerName = 'overcenter-gcp-' + String(job.job_id) + '-recovery';
  const publicRecovery = runnerImage === 'ubuntu:24.04';
  const publicRecoveryBootstrap = publicRecovery
    ? [
        'export DEBIAN_FRONTEND=noninteractive',
        'apt-get update -qq',
        'apt-get install -y --no-install-recommends ca-certificates curl git iproute2 tar gzip',
        'mkdir -p /actions-runner',
        'cd /actions-runner',
        'curl --fail --silent --show-error --location --retry 3 --output runner.tar.gz ' +
          '"https://github.com/actions/runner/releases/download/v2.337.0/' +
          'actions-runner-linux-x64-2.337.0.tar.gz"',
        'printf "%s  %s\\n" ' +
          '"70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613" ' +
          '"runner.tar.gz" | sha256sum -c -',
        'tar -xzf runner.tar.gz',
        'rm runner.tar.gz',
        './bin/installdependencies.sh',
        'ip route replace blackhole 169.254.169.254/32',
      ]
    : ['cd /actions-runner'];

  const containerScript = [
    'set -euo pipefail',
    ...publicRecoveryBootstrap,
    'export RUNNER_ALLOW_RUNASROOT=1',
    'for variable in GOOGLE_APPLICATION_CREDENTIALS CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE GOOGLE_GHA_CREDS_PATH; do',
    '  printenv "$$variable" >/dev/null 2>&1 && exit 70 || true',
    'done',
    'if curl --silent --fail --connect-timeout 1 --max-time 2 -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token >/dev/null 2>&1; then exit 71; fi',
    'if curl --silent --fail --connect-timeout 1 --max-time 2 -H "Metadata-Flavor: Google" http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token >/dev/null 2>&1; then exit 71; fi',
    'cd /actions-runner',
    'rm -rf _work .runner .credentials .credentials_rsaparams',
    './config.sh --unattended --url "https://github.com/' + job.repository + '" --token "$$(cat /workspace/runner-registration-token)" --name "' + runnerName + '" --labels "' + job.runner_label + '" --work _work --ephemeral --disableupdate',
    'rm -f /workspace/runner-registration-token',
    'exec ./run.sh',
  ].join('\n');

  const encodedContainerScript = Buffer.from(containerScript, 'utf8').toString('base64');
  const runnerCommand =
    'printf %s ' + encodedContainerScript +
    ' | base64 -d > /tmp/overcenter-runner.sh; exec bash /tmp/overcenter-runner.sh';

  const dockerParts = [
    'docker run --rm --network bridge',
    publicRecovery ? '--cap-add=NET_ADMIN' : '',
    '--volume /workspace:/workspace',
    '--env TARGET_REPOSITORY=' + job.repository,
    '--env TARGET_JOB_ID=' + String(job.job_id),
    '--env RUNNER_LABEL=' + job.runner_label,
    '--entrypoint bash',
    runnerImage,
    '-c',
    JSON.stringify(runnerCommand),
    '> /workspace/runner-registration-output.log 2>&1',
  ].filter(Boolean);

  const dockerScript = [
    'if [ -f /workspace/skip-runner ]; then',
    '  echo "GitHub job is no longer queued; skipping worker launch."',
    '  printf "0\\n" > /workspace/runner-registration-exit-code',
    '  exit 0',
    'fi',
    'if [ ! -s /workspace/runner-registration-token ]; then',
    '  echo "runner registration token is missing" > /workspace/runner-registration-output.log',
    '  printf "72\\n" > /workspace/runner-registration-exit-code',
    '  exit 0',
    'fi',
    'set +e',
    dockerParts.join(' '),
    'status=$?',
    'set -e',
    'printf "%s\\n" "$status" > /workspace/runner-registration-exit-code',
    'exit 0',
  ].join('\n');

  return {
    serviceAccount:
      'projects/project-6b810532-a302-48dc-b56/serviceAccounts/' +
      'overcenter-runtime@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com',
    timeout: '1200s',
    steps: [
      {
        id: 'authorize-registration',
        name: 'node:22-bookworm',
        entrypoint: 'node',
        secretEnv: ['GITHUB_APP_PRIVATE_KEY'],
        env: [
          'GITHUB_APP_ID=4616688',
          'TARGET_REPOSITORY=' + job.repository,
          'TARGET_REPOSITORY_ID=' + String(job.repository_id),
          'TARGET_OWNER_ID=' + String(job.owner_id),
          'TARGET_JOB_ID=' + String(job.job_id),
          'RUNNER_LABEL=' + job.runner_label,
        ],
        args: ['-e', AUTHORIZE_REGISTRATION_SCRIPT],
      },
      {
        id: 'github-runner-registration',
        name: 'gcr.io/cloud-builders/docker',
        entrypoint: 'bash',
        args: ['-ceu', dockerScript],
        allowFailure: false,
      },
      {
        id: 'capture-runner-output',
        name: 'ubuntu:24.04',
        entrypoint: 'bash',
        args: [
          '-ceu',
          [
            'mkdir -p "/builder/outputs"',
            'if [ -f /workspace/runner-registration-output.log ]; then',
            '  tail -c 48000 /workspace/runner-registration-output.log > "/builder/outputs/output"',
            'else',
            '  { echo "runner registration output missing"; ls -la /workspace; } > "/builder/outputs/output"',
            'fi',
          ].join('\n'),
        ],
      },
      {
        id: 'require-runner-success',
        name: 'ubuntu:24.04',
        entrypoint: 'bash',
        args: [
          '-ceu',
          [
            'test -s /workspace/runner-registration-exit-code',
            'status="$(cat /workspace/runner-registration-exit-code)"',
            'if [ "$status" != "0" ]; then',
            '  cat /workspace/runner-registration-output.log >&2 || true',
            '  echo "runner process failed with exit $status" >&2',
            '  exit "$status"',
            'fi',
          ].join('\n'),
        ],
      },
    ],
    availableSecrets: {
      secretManager: [
        {
          versionName:
            'projects/project-6b810532-a302-48dc-b56/secrets/' +
            'overcenter-github-app-private-key/versions/latest',
          env: 'GITHUB_APP_PRIVATE_KEY',
        },
      ],
    },
    options: { logging: 'CLOUD_LOGGING_ONLY' },
  };
}

async function submit(build: Record<string, unknown>): Promise<string> {
  const response = await fetch(
    'https://cloudbuild.googleapis.com/v1/projects/' +
      'project-6b810532-a302-48dc-b56/locations/us-west1/builds',
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
      'registration recovery build submission HTTP ' +
        response.status +
        ': ' +
        text.slice(0, 500),
    );
  }
  const body = JSON.parse(text) as Record<string, unknown>;
  const metadata =
    body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata as Record<string, unknown>
      : {};
  const buildValue =
    metadata.build && typeof metadata.build === 'object' && !Array.isArray(metadata.build)
      ? metadata.build as Record<string, unknown>
      : {};
  const id = String(buildValue.id ?? '').trim();
  if (!id) throw new Error('registration recovery build response contained no build id');
  return id;
}

async function proveStarted(buildId: string): Promise<void> {
  const terminal = new Set(['FAILURE', 'INTERNAL_ERROR', 'TIMEOUT', 'CANCELLED', 'EXPIRED']);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = execFileSync(
      'gcloud',
      [
        'builds', 'describe', buildId,
        '--project=project-6b810532-a302-48dc-b56',
        '--region=us-west1',
        '--format=value(status)',
      ],
      { encoding: 'utf8' },
    ).trim();
    if (status === 'WORKING' || status === 'SUCCESS') return;
    if (terminal.has(status)) throw new Error('registration recovery build terminated as ' + status);
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error('registration recovery build did not start within bounded observation window');
}

async function main(): Promise<void> {
  const requestPath = process.argv[2];
  if (!requestPath) throw new Error('registration recovery request path is required');
  const request = requireRequest(JSON.parse(readFileSync(requestPath, 'utf8')) as unknown);
  const config = parseRunnerAutoscalerConfig(
    JSON.parse(readFileSync('config/gcp-runner-autoscaler.json', 'utf8')) as unknown,
  );

  for (const raw of request.jobs) {
    const job = parseRunnerLaunchRequest(raw);
    matchRepositoryBinding(config.repositories, job, config.runner_label);
    const buildId = await submit(createBuild(request.runner_image, job));
    console.log(JSON.stringify({
      event: 'registration_recovery_build_submitted',
      repository: job.repository,
      job_id: job.job_id,
      build_id: buildId,
    }));
    await proveStarted(buildId);
    console.log(JSON.stringify({
      event: 'registration_recovery_build_started',
      repository: job.repository,
      job_id: job.job_id,
      build_id: buildId,
    }));
  }
}

main().catch(error => {
  console.error(String(error instanceof Error ? error.stack ?? error.message : error));
  process.exit(1);
});
