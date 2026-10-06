import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

import { parseRunnerAutoscalerConfig, type RepositoryBinding } from './gcp-runner-autoscaler.ts';

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const CLOUD_BUILD_API = 'https://cloudbuild.googleapis.com/v1';
const GITHUB_APP_ID = '4616688';
const GITHUB_APP_SECRET_VERSION = 'overcenter-github-app-private-key/versions/latest';

export type RunnerLaunchRequest = Readonly<{
  repository: string;
  repository_id: number;
  owner_id: number;
  job_id: number;
  runner_label: string;
}>;

export type LauncherEnvironment = Readonly<{
  projectId: string;
  region: string;
  runtimeServiceAccount: string;
  runnerImage: string;
}>;

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(label + ' must be a positive integer');
  }
  return Number(value);
}

function requireRepository(value: unknown, label: string): string {
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) {
    throw new TypeError(label + ' must be owner/repository');
  }
  return text;
}

function requireRunnerLabel(value: unknown): string {
  const label = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(label)) {
    throw new TypeError('runner_label must be a canonical GitHub runner label');
  }
  return label;
}

export function parseRunnerLaunchRequest(value: unknown): RunnerLaunchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('runner launch request must be an object');
  }
  const body = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'repository',
    'repository_id',
    'owner_id',
    'job_id',
    'runner_label',
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) throw new TypeError('unexpected runner launch request key: ' + key);
  }
  return Object.freeze({
    repository: requireRepository(body.repository, 'repository'),
    repository_id: requirePositiveInteger(body.repository_id, 'repository_id'),
    owner_id: requirePositiveInteger(body.owner_id, 'owner_id'),
    job_id: requirePositiveInteger(body.job_id, 'job_id'),
    runner_label: requireRunnerLabel(body.runner_label),
  });
}

export function matchRepositoryBinding(
  repositories: readonly RepositoryBinding[],
  request: RunnerLaunchRequest,
  expectedRunnerLabel?: string,
): RepositoryBinding {
  if (expectedRunnerLabel !== undefined && request.runner_label !== expectedRunnerLabel) {
    throw new Error('runner launch label mismatch');
  }
  const binding = repositories.find(
    (candidate) => candidate.full_name.toLowerCase() === request.repository.toLowerCase(),
  );
  if (
    !binding ||
    binding.repository_id !== request.repository_id ||
    binding.owner_id !== request.owner_id
  ) {
    throw new Error('runner launch repository identity mismatch');
  }
  return binding;
}

const AUTHORIZE_JOB_SCRIPT = String.raw`
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
const header = b64({ alg: 'RS256', typ: 'JWT' });
const payload = b64({ iat: now - 60, exp: now + 540, iss: appId });
const unsigned = header + '.' + payload;
const signature = crypto
  .sign('RSA-SHA256', Buffer.from(unsigned), process.env.GITHUB_APP_PRIVATE_KEY)
  .toString('base64url');
const appJwt = unsigned + '.' + signature;

const baseHeaders = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2026-03-10',
  'User-Agent': 'overcenter-gcp-runner-launcher',
};

async function json(response, label) {
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
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
  const installationPermissions =
    installation && typeof installation.permissions === 'object'
      ? installation.permissions
      : {};
  if (String(installationPermissions.administration || '') !== 'write') {
    throw new Error(
      'GitHub App installation lacks administration:write required for ephemeral runner registration',
    );
  }
  if (!['read', 'write'].includes(String(installationPermissions.actions || ''))) {
    throw new Error(
      'GitHub App installation lacks actions:read required to validate queued jobs',
    );
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
    identity.id !== expectedRepositoryId ||
    !identity.owner ||
    identity.owner.id !== expectedOwnerId ||
    String(identity.full_name || '').toLowerCase() !== repo.toLowerCase()
  ) {
    throw new Error('repository identity mismatch');
  }

  const job = await json(
    await fetch('https://api.github.com/repos/' + repo + '/actions/jobs/' + jobId, {
      headers,
    }),
    'workflow job lookup',
  );
  const labels = new Set(Array.isArray(job.labels) ? job.labels.map(String) : []);
  if (
    job.id !== jobId ||
    job.status !== 'queued' ||
    !labels.has('self-hosted') ||
    !labels.has(runnerLabel)
  ) {
    fs.writeFileSync('/workspace/skip-runner', 'job is no longer eligible\n');
    return;
  }

  if (!runnerName || !/^overcenter-gcp-[0-9]+-[A-Za-z0-9_-]+$/.test(runnerName)) {
    throw new Error('runner name is not bound to the queued job and build');
  }

  const jit = await json(
    await fetch('https://api.github.com/repos/' + repo + '/actions/runners/generate-jitconfig', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: runnerName,
        runner_group_id: 1,
        labels: ['self-hosted', 'Linux', 'X64', runnerLabel],
        work_folder: '_work',
      }),
    }),
    'runner JIT configuration',
  );
  if (!jit || typeof jit.encoded_jit_config !== 'string' || !jit.encoded_jit_config) {
    throw new Error('runner JIT configuration response was incomplete');
  }
  fs.writeFileSync('/workspace/jit-config', jit.encoded_jit_config, { mode: 0o600 });
}

main().catch(error => {
  console.error(String((error && error.message) || error));
  process.exit(1);
});
`;


const VERIFY_JOB_SETTLEMENT_SCRIPT = String.raw\`
const crypto = require('crypto');
const fs = require('fs');

if (fs.existsSync('/workspace/skip-runner')) process.exit(0);

const repo = process.env.TARGET_REPOSITORY;
const expectedRepositoryId = Number(process.env.TARGET_REPOSITORY_ID);
const jobId = Number(process.env.TARGET_JOB_ID);
const runnerName = process.env.RUNNER_NAME;
const appId = process.env.GITHUB_APP_ID;

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const header = b64({ alg: 'RS256', typ: 'JWT' });
const payload = b64({ iat: now - 60, exp: now + 540, iss: appId });
const unsigned = header + '.' + payload;
const signature = crypto
  .sign('RSA-SHA256', Buffer.from(unsigned), process.env.GITHUB_APP_PRIVATE_KEY)
  .toString('base64url');
const appJwt = unsigned + '.' + signature;

const baseHeaders = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2026-03-10',
  'User-Agent': 'overcenter-gcp-runner-settlement',
};

async function json(response, label) {
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
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
          permissions: { actions: 'read' },
        }),
      },
    ),
    'installation token',
  );
  const job = await json(
    await fetch('https://api.github.com/repos/' + repo + '/actions/jobs/' + jobId, {
      headers: { ...baseHeaders, Authorization: 'Bearer ' + access.token },
    }),
    'workflow job settlement',
  );

  if (job.id !== jobId) {
    throw new Error('workflow job settlement identity mismatch');
  }
  if (job.runner_name !== runnerName) {
    throw new Error(
      'workflow job was not claimed by expected runner: expected ' +
        runnerName +
        ', observed ' +
        String(job.runner_name || '<none>'),
    );
  }
  if (job.status !== 'completed') {
    throw new Error(
      'workflow job did not settle before runner exit: observed status ' + String(job.status),
    );
  }
}

main().catch(error => {
  console.error(String((error && error.message) || error));
  process.exit(1);
});
\`;

function requireLauncherEnvironment(env: NodeJS.ProcessEnv): LauncherEnvironment {
  const projectId = String(env.GCP_PROJECT_ID ?? '').trim();
  const region = String(env.GCP_REGION ?? '').trim();
  const runtimeServiceAccount = String(env.GCP_RUNNER_SERVICE_ACCOUNT ?? '').trim();
  const runnerImage = String(env.OVERCENTER_RUNNER_IMAGE ?? '').trim();

  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) {
    throw new TypeError('GCP_PROJECT_ID is invalid');
  }
  if (!/^[a-z]+-[a-z]+[0-9]$/.test(region)) {
    throw new TypeError('GCP_REGION is invalid');
  }
  if (runtimeServiceAccount !== 'overcenter-runtime@' + projectId + '.iam.gserviceaccount.com') {
    throw new TypeError('GCP_RUNNER_SERVICE_ACCOUNT must be the Overcenter runtime identity');
  }
  const imagePrefix = region + '-docker.pkg.dev/' + projectId + '/';
  if (!runnerImage.startsWith(imagePrefix) || !/@sha256:[0-9a-f]{64}$/.test(runnerImage)) {
    throw new TypeError('OVERCENTER_RUNNER_IMAGE must be an immutable Artifact Registry digest');
  }
  return Object.freeze({ projectId, region, runtimeServiceAccount, runnerImage });
}

export function createRunnerBuild(
  environment: LauncherEnvironment,
  request: RunnerLaunchRequest,
): Record<string, unknown> {
  const targetEnv = [
    'GITHUB_APP_ID=' + GITHUB_APP_ID,
    'TARGET_REPOSITORY=' + request.repository,
    'TARGET_REPOSITORY_ID=' + String(request.repository_id),
    'TARGET_OWNER_ID=' + String(request.owner_id),
    'TARGET_JOB_ID=' + String(request.job_id),
    'RUNNER_LABEL=' + request.runner_label,
    'RUNNER_NAME=overcenter-gcp-' + String(request.job_id) + '-$BUILD_ID',
  ];

  const dockerScript = [
    'if [ -f /workspace/skip-runner ]; then',
    '  echo "GitHub job is no longer queued; skipping worker launch."',
    '  exit 0',
    'fi',
    'test -s /workspace/jit-config',
    'touch /workspace/runner-attempted',
    [
      'docker run --rm --network bridge',
      '--volume /workspace:/workspace',
      '--env TARGET_REPOSITORY=' + request.repository,
      '--env TARGET_JOB_ID=' + String(request.job_id),
      '--env RUNNER_LABEL=' + request.runner_label,
      environment.runnerImage,
      '> /workspace/runner-output.log 2>&1',
      '&& touch /workspace/runner-success',
      '|| touch /workspace/runner-failure',
    ].join(' '),
    'tail -c 48000 /workspace/runner-output.log > /builder/outputs/output',
    'cat /workspace/runner-output.log',
    'test -f /workspace/runner-success',
  ].join('\n');

  return {
    serviceAccount:
      'projects/' + environment.projectId + '/serviceAccounts/' + environment.runtimeServiceAccount,
    timeout: '1200s',
    queueTtl: '90s',
    steps: [
      {
        id: 'authorize-job',
        name: 'node:22-bookworm',
        entrypoint: 'node',
        secretEnv: ['GITHUB_APP_PRIVATE_KEY'],
        env: targetEnv,
        args: ['-e', AUTHORIZE_JOB_SCRIPT],
      },
      {
        id: 'github-runner',
        name: 'gcr.io/cloud-builders/docker',
        entrypoint: 'bash',
        args: ['-ceu', dockerScript],
      },
      {
        id: 'verify-job-settlement',
        name: 'node:22-bookworm',
        entrypoint: 'node',
        secretEnv: ['GITHUB_APP_PRIVATE_KEY'],
        env: targetEnv,
        args: ['-e', VERIFY_JOB_SETTLEMENT_SCRIPT],
      },
    ],
    availableSecrets: {
      secretManager: [
        {
          versionName:
            'projects/' + environment.projectId + '/secrets/' + GITHUB_APP_SECRET_VERSION,
          env: 'GITHUB_APP_PRIVATE_KEY',
        },
      ],
    },
    options: { logging: 'CLOUD_LOGGING_ONLY' },
  };
}

async function metadataAccessToken(): Promise<string> {
  const response = await fetch(METADATA_TOKEN_URL, {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      'Google metadata access token request failed with HTTP ' +
        response.status +
        ': ' +
        text.slice(0, 300),
    );
  }
  const body = JSON.parse(text) as Record<string, unknown>;
  const token = String(body.access_token ?? '').trim();
  if (!token) throw new Error('Google metadata access token response was incomplete');
  return token;
}

async function submitRunnerBuild(
  environment: LauncherEnvironment,
  request: RunnerLaunchRequest,
): Promise<string> {
  const token = await metadataAccessToken();
  const response = await fetch(
    CLOUD_BUILD_API +
      '/projects/' +
      encodeURIComponent(environment.projectId) +
      '/locations/' +
      encodeURIComponent(environment.region) +
      '/builds',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createRunnerBuild(environment, request)),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      'Cloud Build create failed with HTTP ' + response.status + ': ' + text.slice(0, 500),
    );
  }
  const body = JSON.parse(text) as Record<string, unknown>;
  const metadata =
    body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? (body.metadata as Record<string, unknown>)
      : {};
  const build =
    metadata.build && typeof metadata.build === 'object' && !Array.isArray(metadata.build)
      ? (metadata.build as Record<string, unknown>)
      : {};
  const id = String(build.id ?? '').trim();
  if (!id) throw new Error('Cloud Build create response did not include a build id');
  return id;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new Error('request body too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(text) as unknown;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

async function loadConfig(path: string): Promise<ReturnType<typeof parseRunnerAutoscalerConfig>> {
  const body = JSON.parse(await readFile(path, 'utf8')) as unknown;
  return parseRunnerAutoscalerConfig(body);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  environment: LauncherEnvironment,
  config: ReturnType<typeof parseRunnerAutoscalerConfig>,
): Promise<void> {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/launch') {
    sendJson(response, 404, { error: 'not found' });
    return;
  }

  try {
    const launch = parseRunnerLaunchRequest(await readJsonBody(request));
    matchRepositoryBinding(config.repositories, launch, config.runner_label);
    const buildId = await submitRunnerBuild(environment, launch);
    console.log(
      JSON.stringify({
        event: 'runner_build_submitted',
        repository: launch.repository,
        repository_id: launch.repository_id,
        job_id: launch.job_id,
        build_id: buildId,
      }),
    );
    sendJson(response, 202, { build_id: buildId });
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    console.error(JSON.stringify({ event: 'runner_launch_failed', error: message }));
    sendJson(response, 400, { error: message });
  }
}

async function main(): Promise<void> {
  const environment = requireLauncherEnvironment(process.env);
  const configPath =
    String(process.env.OVERCENTER_RUNNER_CONFIG_PATH ?? '').trim() ||
    'config/gcp-runner-autoscaler.json';
  const config = await loadConfig(configPath);
  const port = Number(process.env.PORT ?? '8080');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('PORT must be a valid TCP port');
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response, environment, config).catch((error) => {
      console.error(String(error instanceof Error ? (error.stack ?? error.message) : error));
      if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
      else response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) {
  main().catch((error) => {
    console.error(String(error instanceof Error ? (error.stack ?? error.message) : error));
    process.exit(1);
  });
}
