import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  matchRepositoryBinding,
  parseRunnerLaunchRequest,
} from '../src/transport/gcp-runner-launcher.ts';
import { parseRunnerAutoscalerConfig } from '../src/transport/gcp-runner-autoscaler.ts';

interface JitRecoveryRequest {
  schema: 'overcenter-gcp-runner-jit-recovery/v1';
  jobs: unknown[];
}

function requireRequest(value: unknown): JitRecoveryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('JIT recovery request must be an object');
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['jobs', 'schema'])) {
    throw new TypeError('JIT recovery request keys are invalid');
  }
  if (body.schema !== 'overcenter-gcp-runner-jit-recovery/v1') {
    throw new TypeError('JIT recovery request schema is unsupported');
  }
  if (!Array.isArray(body.jobs) || body.jobs.length < 1 || body.jobs.length > 4) {
    throw new TypeError('JIT recovery request must contain between 1 and 4 jobs');
  }
  return { schema: body.schema, jobs: body.jobs };
}

function accessToken(): string {
  return execFileSync('gcloud', ['auth', 'print-access-token'], {
    encoding: 'utf8',
  }).trim();
}

const AUTHORIZE_JIT_SCRIPT = String.raw`
const crypto = require('crypto');
const fs = require('fs');

const repo = process.env.TARGET_REPOSITORY;
const expectedRepositoryId = Number(process.env.TARGET_REPOSITORY_ID);
const expectedOwnerId = Number(process.env.TARGET_OWNER_ID);
const jobId = Number(process.env.TARGET_JOB_ID);
const runnerLabel = process.env.RUNNER_LABEL;
const runnerName = process.env.RUNNER_NAME;
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
  'User-Agent': 'overcenter-gcp-jit-recovery',
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
    throw new Error('GitHub App lacks administration:write for JIT runner creation');
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

  const jit = await json(
    await fetch(
      'https://api.github.com/repos/' + repo + '/actions/runners/generate-jitconfig',
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: runnerName,
          runner_group_id: 1,
          labels: ['self-hosted', 'Linux', 'X64', runnerLabel],
          work_folder: '_work',
        }),
      },
    ),
    'JIT runner configuration',
  );
  const encoded = String(jit && jit.encoded_jit_config || '');
  if (!encoded) throw new Error('JIT runner configuration returned no encoded config');
  fs.writeFileSync('/workspace/jit-config', encoded, { mode: 0o600 });
}

main().catch(error => {
  console.error(String(error && error.message || error));
  process.exit(1);
});
`;

const OBSERVE_JIT_SCRIPT = String.raw`
const crypto = require('crypto');
const fs = require('fs');

const repo = process.env.TARGET_REPOSITORY;
const expectedRepositoryId = Number(process.env.TARGET_REPOSITORY_ID);
const jobId = Number(process.env.TARGET_JOB_ID);
const runnerPrefix = process.env.RUNNER_NAME_PREFIX;
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
  'User-Agent': 'overcenter-gcp-jit-observer',
};

async function json(response, label) {
  const text = await response.text();
  if (!response.ok) throw new Error(label + ' HTTP ' + response.status + ': ' + text.slice(0, 300));
  return text ? JSON.parse(text) : {};
}

async function main() {
  const installation = await json(
    await fetch('https://api.github.com/repos/' + repo + '/installation', {
      headers: { ...baseHeaders, Authorization: 'Bearer ' + appJwt },
    }),
    'installation lookup',
  );
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
  const snapshots = [];
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const job = await json(
      await fetch('https://api.github.com/repos/' + repo + '/actions/jobs/' + jobId, { headers }),
      'workflow job lookup',
    );
    const runners = await json(
      await fetch('https://api.github.com/repos/' + repo + '/actions/runners?per_page=100', { headers }),
      'runner list',
    );
    const matches = Array.isArray(runners.runners)
      ? runners.runners
          .filter(runner => String(runner.name || '').startsWith(runnerPrefix))
          .map(runner => ({
            id: runner.id,
            name: runner.name,
            status: runner.status,
            busy: runner.busy,
            labels: Array.isArray(runner.labels) ? runner.labels.map(label => label.name) : [],
          }))
      : [];
    snapshots.push({
      attempt,
      job: {
        id: job.id,
        status: job.status,
        conclusion: job.conclusion ?? null,
        runner_id: job.runner_id ?? null,
        runner_name: job.runner_name ?? null,
        labels: job.labels ?? [],
      },
      runners: matches,
    });
    if (String(job.status) !== 'queued') break;
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  let listenerTail = '';
  try {
    listenerTail = fs.readFileSync('/workspace/jit-runner-output.log', 'utf8').slice(-12000);
  } catch {}
  const output =
    JSON.stringify(
      { event: 'jit_observation', repo, job_id: jobId, snapshots, listener_tail: listenerTail },
      null,
      2,
    ) + '\n';
  fs.writeFileSync('/workspace/jit-observer-output.log', output);
  fs.mkdirSync('/builder/outputs', { recursive: true });
  fs.writeFileSync('/builder/outputs/output', output);
  process.stdout.write(output);
}

main().catch(error => {
  console.error(String(error && error.stack || error));
  process.exit(1);
});
`;

const PREFETCH_RUNNER_SCRIPT = String.raw`
const crypto = require('crypto');
const fs = require('fs');

async function main() {
  const url =
    'https://github.com/actions/runner/releases/download/v2.337.0/' +
    'actions-runner-linux-x64-2.337.0.tar.gz';
  const expected =
    '70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613';
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error('runner download HTTP ' + response.status);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== expected) {
    throw new Error('runner download digest mismatch');
  }
  fs.writeFileSync('/workspace/actions-runner.tar.gz', bytes, { mode: 0o644 });
}

main().catch(error => {
  console.error(String(error && error.message || error));
  process.exit(97);
});
`;

function createJitBuild(job: ReturnType<typeof parseRunnerLaunchRequest>): Record<string, unknown> {
  const runnerName = 'overcenter-gcp-' + String(job.job_id) + '-$BUILD_ID';
  const runnerImage =
    'us-west1-docker.pkg.dev/project-6b810532-a302-48dc-b56/' +
    'cloud-run-source-deploy/overcenter-gcp-runner@' +
    'sha256:2f43d35387b7fb2a25b41bc09cafcfb396be375c8e3f9d921eeabd4a30098391';
  const dockerScript = [
    'set +e',
    'docker run --rm --network bridge' +
      ' --volume /workspace:/workspace' +
      ' --env TARGET_REPOSITORY=' + job.repository +
      ' --env TARGET_JOB_ID=' + String(job.job_id) +
      ' --env RUNNER_LABEL=' + job.runner_label +
      ' ' + runnerImage +
      ' > /workspace/jit-runner-output.log 2>&1',
    'status=$?',
    'set -e',
    'printf "%s\\n" "$status" > /workspace/jit-runner-exit-code',
    'exit 0',
  ].join('\n');

  return {
    serviceAccount:
      'projects/project-6b810532-a302-48dc-b56/serviceAccounts/' +
      'overcenter-runtime@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com',
    timeout: '1200s',
    steps: [
      {
        id: 'authorize-jit-job',
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
          'RUNNER_NAME=' + runnerName,
        ],
        args: ['-e', AUTHORIZE_JIT_SCRIPT],
      },
      {
        id: 'github-runner',
        name: 'gcr.io/cloud-builders/docker',
        entrypoint: 'bash',
        waitFor: ['authorize-jit-job'],
        args: ['-ceu', dockerScript],
      },
      {
        id: 'observe-jit-registration',
        name: 'node:22-bookworm',
        entrypoint: 'node',
        waitFor: ['authorize-jit-job'],
        secretEnv: ['GITHUB_APP_PRIVATE_KEY'],
        env: [
          'GITHUB_APP_ID=4616688',
          'TARGET_REPOSITORY=' + job.repository,
          'TARGET_REPOSITORY_ID=' + String(job.repository_id),
          'TARGET_JOB_ID=' + String(job.job_id),
          'RUNNER_NAME_PREFIX=overcenter-gcp-' + String(job.job_id) + '-',
        ],
        args: ['-e', OBSERVE_JIT_SCRIPT],
      },
      {
        id: 'capture-runner-output',
        name: 'ubuntu:24.04',
        entrypoint: 'bash',
        args: [
          '-ceu',
          [
            'mkdir -p /builder/outputs',
            'if [ -f /workspace/jit-runner-output.log ]; then',
            '  tail -c 48000 /workspace/jit-runner-output.log > /builder/outputs/output',
            'else',
            '  { echo "JIT runner output missing"; ls -la /workspace; } > /builder/outputs/output',
            'fi',
            'cat /builder/outputs/output',
          ].join('\\n'),
        ],
      },
      {
        id: 'require-runner-success',
        name: 'ubuntu:24.04',
        entrypoint: 'bash',
        args: [
          '-ceu',
          [
            'test -s /workspace/jit-runner-exit-code',
            'status="$(cat /workspace/jit-runner-exit-code)"',
            'if [ "$status" != "0" ]; then',
            '  cat /workspace/jit-runner-output.log >&2 || true',
            '  echo "JIT runner process failed with exit $status" >&2',
            '  exit "$status"',
            'fi',
          ].join('\\n'),
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
    throw new Error('JIT recovery build submission HTTP ' + response.status + ': ' + text.slice(0, 500));
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
  if (!id) throw new Error('JIT recovery build response contained no build id');
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
    if (terminal.has(status)) throw new Error('JIT recovery build terminated as ' + status);
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error('JIT recovery build did not start within bounded observation window');
}

async function main(): Promise<void> {
  const requestPath = process.argv[2];
  if (!requestPath) throw new Error('JIT recovery request path is required');
  const request = requireRequest(JSON.parse(readFileSync(requestPath, 'utf8')) as unknown);
  const config = parseRunnerAutoscalerConfig(
    JSON.parse(readFileSync('config/gcp-runner-autoscaler.json', 'utf8')) as unknown,
  );

  for (const raw of request.jobs) {
    const job = parseRunnerLaunchRequest(raw);
    matchRepositoryBinding(config.repositories, job, config.runner_label);
    const buildId = await submit(createJitBuild(job));
    console.log(JSON.stringify({
      event: 'jit_recovery_build_submitted',
      repository: job.repository,
      job_id: job.job_id,
      build_id: buildId,
    }));
    await proveStarted(buildId);
    console.log(JSON.stringify({
      event: 'jit_recovery_build_started',
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
