import { createSign, randomUUID } from 'node:crypto';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseRunnerExecutionLease, type RunnerExecutionLease } from './gcp-runner-launcher.ts';
import {
  warmRunnerOperationalEvent,
  warmRunnerOperationalIdentity,
  type WarmRunnerOperationalStage,
} from './warm-runner-operational-observation.ts';

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';
const GITHUB_APP_ID = '4616688';
const GITHUB_APP_SECRET = 'overcenter-github-app-private-key';
const DOCKER_SOCKET = '/var/run/docker.sock';

export type WarmRunnerAgentEnvironment = Readonly<{
  projectId: string;
  subscription: string;
  runnerImage: string;
  workRoot: string;
}>;

type PulledMessage = Readonly<{
  ackId: string;
  messageId: string;
  lease: RunnerExecutionLease;
}>;

type AuthorizedJob =
  | Readonly<{ eligible: false }>
  | Readonly<{
      eligible: true;
      encodedJitConfig: string;
    }>;

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new TypeError(name + ' is required');
  return value;
}

export function warmRunnerAgentEnvironment(env: NodeJS.ProcessEnv): WarmRunnerAgentEnvironment {
  const projectId = requiredEnv(env, 'GCP_PROJECT_ID');
  const subscription = requiredEnv(env, 'OVERCENTER_RUNNER_SUBSCRIPTION');
  const runnerImage = requiredEnv(env, 'OVERCENTER_RUNNER_IMAGE');
  const workRoot = requiredEnv(env, 'OVERCENTER_RUNNER_WORK_ROOT');

  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) {
    throw new TypeError('GCP_PROJECT_ID is invalid');
  }
  if (!/^[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/.test(subscription)) {
    throw new TypeError('OVERCENTER_RUNNER_SUBSCRIPTION is invalid');
  }
  if (!/@sha256:[0-9a-f]{64}$/.test(runnerImage)) {
    throw new TypeError('OVERCENTER_RUNNER_IMAGE must be immutable');
  }
  if (!workRoot.startsWith('/var/lib/overcenter-runner/')) {
    throw new TypeError('OVERCENTER_RUNNER_WORK_ROOT must be beneath /var/lib/overcenter-runner');
  }
  return Object.freeze({ projectId, subscription, runnerImage, workRoot });
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

async function googleJson(
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + token,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error('Google API HTTP ' + response.status + ': ' + text.slice(0, 500));
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function pullMessage(environment: WarmRunnerAgentEnvironment): Promise<PulledMessage | null> {
  const token = await metadataAccessToken();
  const body = await googleJson(
    'https://pubsub.googleapis.com/v1/projects/' +
      encodeURIComponent(environment.projectId) +
      '/subscriptions/' +
      encodeURIComponent(environment.subscription) +
      ':pull',
    token,
    {
      method: 'POST',
      body: JSON.stringify({ maxMessages: 1 }),
    },
  );
  const received = Array.isArray(body.receivedMessages) ? body.receivedMessages : [];
  const item = received[0];
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  const ackId = String(record.ackId ?? '').trim();
  const message =
    record.message && typeof record.message === 'object' && !Array.isArray(record.message)
      ? (record.message as Record<string, unknown>)
      : {};
  const messageId = String(message.messageId ?? '').trim();
  const data = String(message.data ?? '').trim();
  if (!ackId || !messageId || !data) throw new Error('Pub/Sub runner message is incomplete');

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as unknown;
  } catch {
    throw new Error('Pub/Sub runner message body is not valid encoded JSON');
  }
  return Object.freeze({
    ackId,
    messageId,
    lease: parseRunnerExecutionLease(decoded),
  });
}

async function modifyAckDeadline(
  environment: WarmRunnerAgentEnvironment,
  ackId: string,
  seconds: number,
): Promise<void> {
  const token = await metadataAccessToken();
  await googleJson(
    'https://pubsub.googleapis.com/v1/projects/' +
      encodeURIComponent(environment.projectId) +
      '/subscriptions/' +
      encodeURIComponent(environment.subscription) +
      ':modifyAckDeadline',
    token,
    {
      method: 'POST',
      body: JSON.stringify({ ackIds: [ackId], ackDeadlineSeconds: seconds }),
    },
  );
}

async function acknowledge(environment: WarmRunnerAgentEnvironment, ackId: string): Promise<void> {
  const token = await metadataAccessToken();
  await googleJson(
    'https://pubsub.googleapis.com/v1/projects/' +
      encodeURIComponent(environment.projectId) +
      '/subscriptions/' +
      encodeURIComponent(environment.subscription) +
      ':acknowledge',
    token,
    {
      method: 'POST',
      body: JSON.stringify({ ackIds: [ackId] }),
    },
  );
}

let cachedPrivateKey: string | null = null;

async function githubPrivateKey(environment: WarmRunnerAgentEnvironment): Promise<string> {
  if (cachedPrivateKey !== null) return cachedPrivateKey;
  const token = await metadataAccessToken();
  const body = await googleJson(
    'https://secretmanager.googleapis.com/v1/projects/' +
      encodeURIComponent(environment.projectId) +
      '/secrets/' +
      GITHUB_APP_SECRET +
      '/versions/latest:access',
    token,
  );
  const payload =
    body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
      ? (body.payload as Record<string, unknown>)
      : {};
  const data = String(payload.data ?? '');
  const key = Buffer.from(data, 'base64').toString('utf8').trim();
  if (!key.includes('PRIVATE KEY')) throw new Error('GitHub App private key response was invalid');
  cachedPrivateKey = key;
  return key;
}

function githubAppJwt(privateKey: string): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const payload = encode({ iat: now - 60, exp: now + 540, iss: GITHUB_APP_ID });
  const unsigned = header + '.' + payload;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .end()
    .sign(privateKey)
    .toString('base64url');
  return unsigned + '.' + signature;
}

async function githubJson(
  url: string,
  authorization: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: authorization,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': 'overcenter-gce-runner-agent',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error('GitHub API HTTP ' + response.status + ': ' + text.slice(0, 500));
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function authorizeQueuedJob(
  environment: WarmRunnerAgentEnvironment,
  lease: RunnerExecutionLease,
  runnerName: string,
): Promise<AuthorizedJob> {
  const privateKey = await githubPrivateKey(environment);
  const appJwt = githubAppJwt(privateKey);
  const installation = await githubJson(
    GITHUB_API + '/repos/' + lease.repository + '/installation',
    'Bearer ' + appJwt,
  );
  const installationId = Number(installation.id);
  const permissions =
    installation.permissions &&
    typeof installation.permissions === 'object' &&
    !Array.isArray(installation.permissions)
      ? (installation.permissions as Record<string, unknown>)
      : {};
  if (
    !Number.isSafeInteger(installationId) ||
    String(permissions.administration ?? '') !== 'write' ||
    !['read', 'write'].includes(String(permissions.actions ?? ''))
  ) {
    throw new Error('GitHub App installation lacks runner authorization permissions');
  }

  const access = await githubJson(
    GITHUB_API + '/app/installations/' + installationId + '/access_tokens',
    'Bearer ' + appJwt,
    {
      method: 'POST',
      body: JSON.stringify({
        repository_ids: [lease.repository_id],
        permissions: { administration: 'write', actions: 'read' },
      }),
    },
  );
  const installationToken = String(access.token ?? '').trim();
  if (!installationToken) throw new Error('GitHub installation token response was incomplete');
  const authorization = 'Bearer ' + installationToken;

  const [identity, job] = await Promise.all([
    githubJson(GITHUB_API + '/repos/' + lease.repository, authorization),
    githubJson(
      GITHUB_API + '/repos/' + lease.repository + '/actions/jobs/' + lease.job_id,
      authorization,
    ),
  ]);
  const owner =
    identity.owner && typeof identity.owner === 'object' && !Array.isArray(identity.owner)
      ? (identity.owner as Record<string, unknown>)
      : {};
  if (
    Number(identity.id) !== lease.repository_id ||
    Number(owner.id) !== lease.owner_id ||
    String(identity.full_name ?? '').toLowerCase() !== lease.repository.toLowerCase()
  ) {
    throw new Error('repository identity mismatch');
  }

  const labels = new Set(Array.isArray(job.labels) ? job.labels.map((value) => String(value)) : []);
  if (
    Number(job.id) !== lease.job_id ||
    String(job.status ?? '') !== 'queued' ||
    !labels.has('self-hosted') ||
    !labels.has(lease.runner_label)
  ) {
    return Object.freeze({ eligible: false });
  }

  const jit = await githubJson(
    GITHUB_API + '/repos/' + lease.repository + '/actions/runners/generate-jitconfig',
    authorization,
    {
      method: 'POST',
      body: JSON.stringify({
        name: runnerName,
        runner_group_id: 1,
        labels: Array.from(new Set(['self-hosted', 'Linux', 'X64', ...labels])).sort(),
        work_folder: '_work',
      }),
    },
  );
  const encodedJitConfig = String(jit.encoded_jit_config ?? '').trim();
  if (!encodedJitConfig) throw new Error('runner JIT configuration response was incomplete');
  return Object.freeze({ eligible: true, encodedJitConfig });
}

type DockerResponse = Readonly<{ statusCode: number; body: Buffer }>;

async function dockerRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<DockerResponse> {
  const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  return await new Promise<DockerResponse>((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: DOCKER_SOCKET,
        method,
        path,
        headers:
          encoded === null
            ? {}
            : {
                'Content-Type': 'application/json',
                'Content-Length': String(encoded.length),
              },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.once('error', reject);
        response.once('end', () => {
          resolve(
            Object.freeze({
              statusCode: response.statusCode ?? 0,
              body: Buffer.concat(chunks),
            }),
          );
        });
      },
    );
    request.once('error', reject);
    if (encoded !== null) request.write(encoded);
    request.end();
  });
}

export function runnerContainerSpec(
  environment: WarmRunnerAgentEnvironment,
  lease: RunnerExecutionLease,
  workspace: string,
): Record<string, unknown> {
  return {
    Image: environment.runnerImage,
    Env: [
      'TARGET_REPOSITORY=' + lease.repository,
      'TARGET_JOB_ID=' + String(lease.job_id),
      'RUNNER_LABEL=' + lease.runner_label,
    ],
    HostConfig: {
      AutoRemove: false,
      NetworkMode: 'bridge',
      Dns: ['8.8.8.8', '8.8.4.4'],
      Binds: [workspace + ':/workspace'],
    },
  };
}

function dockerName(messageId: string, jobId: number): string {
  const suffix = messageId.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40);
  if (!suffix) throw new Error('Pub/Sub message id cannot form a runner identity');
  return 'overcenter-gcp-' + String(jobId) + '-gce-' + suffix;
}

async function runContainer(
  environment: WarmRunnerAgentEnvironment,
  lease: RunnerExecutionLease,
  messageId: string,
  workspace: string,
  observe: (stage: WarmRunnerOperationalStage, diagnostic?: string) => void,
): Promise<void> {
  const name = dockerName(messageId, lease.job_id);
  const created = await dockerRequest(
    'POST',
    '/v1.45/containers/create?name=' + encodeURIComponent(name),
    runnerContainerSpec(environment, lease, workspace),
  );
  if (created.statusCode !== 201) {
    throw new Error(
      'Docker create failed with HTTP ' +
        created.statusCode +
        ': ' +
        created.body.toString('utf8').slice(0, 500),
    );
  }
  const body = JSON.parse(created.body.toString('utf8')) as Record<string, unknown>;
  const id = String(body.Id ?? '').trim();
  if (!id) throw new Error('Docker create response did not include a container id');

  let executionError: unknown = null;
  try {
    const started = await dockerRequest('POST', '/v1.45/containers/' + id + '/start');
    if (started.statusCode !== 204) {
      throw new Error('Docker start failed with HTTP ' + started.statusCode);
    }
    observe('container_started');
    const waited = await dockerRequest('POST', '/v1.45/containers/' + id + '/wait');
    if (waited.statusCode !== 200) {
      throw new Error('Docker wait failed with HTTP ' + waited.statusCode);
    }
    const outcome = JSON.parse(waited.body.toString('utf8')) as Record<string, unknown>;
    if (Number(outcome.StatusCode) !== 0) {
      throw new Error('GitHub runner container exited with code ' + String(outcome.StatusCode));
    }
    observe('container_exit_zero');
  } catch (error: unknown) {
    executionError = error;
  }
  // Always attempt cleanup, and fail closed if Docker does not prove absence.
  const deleted = await dockerRequest('DELETE', '/v1.45/containers/' + id + '?force=1');
  if (deleted.statusCode !== 204) {
    throw new Error('Docker remove failed with HTTP ' + deleted.statusCode);
  }
  const readback = await dockerRequest('GET', '/v1.45/containers/' + id + '/json');
  if (readback.statusCode !== 404) {
    throw new Error('Docker container absence readback failed with HTTP ' + readback.statusCode);
  }
  observe('container_absent_readback');
  if (executionError !== null) throw executionError;
}

async function processObservedMessage(
  environment: WarmRunnerAgentEnvironment,
  pulled: PulledMessage,
  observe: (stage: WarmRunnerOperationalStage, diagnostic?: string) => void,
): Promise<void> {
  const workspace = join(
    environment.workRoot,
    String(pulled.lease.job_id) + '-' + pulled.messageId,
  );
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  let executionError: unknown = null;
  try {
    const runnerName = dockerName(pulled.messageId, pulled.lease.job_id);
    const authorization = await authorizeQueuedJob(environment, pulled.lease, runnerName);
    if (!authorization.eligible) {
      observe('job_stale');
    } else {
      observe('jit_authorized');
      await writeFile(join(workspace, 'jit-config'), authorization.encodedJitConfig, {
        mode: 0o600,
      });
      await runContainer(environment, pulled.lease, pulled.messageId, workspace, observe);
    }
  } catch (error: unknown) {
    executionError = error;
  }
  await rm(workspace, { recursive: true, force: true });
  try {
    await lstat(workspace);
    throw new Error('Runner workspace still exists after removal');
  } catch (error: unknown) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
  observe('workspace_absent_readback');
  if (executionError !== null) throw executionError;
}

async function runForever(environment: WarmRunnerAgentEnvironment): Promise<void> {
  for (;;) {
    const pulled = await pullMessage(environment);
    if (pulled === null) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }

    const identity = warmRunnerOperationalIdentity(
      environment.projectId,
      environment.subscription,
      pulled.lease,
      pulled.messageId,
      randomUUID(),
    );
    let sequence = 0;
    const observe = (stage: WarmRunnerOperationalStage, diagnostic?: string): void => {
      console.log(
        JSON.stringify(
          warmRunnerOperationalEvent(
            identity,
            ++sequence,
            stage,
            new Date().toISOString(),
            diagnostic,
          ),
        ),
      );
    };
    observe('lease_received');
    try {
      await modifyAckDeadline(environment, pulled.ackId, 120);
    } catch (error: unknown) {
      observe('execution_failed', String(error instanceof Error ? error.message : error));
      continue; // Unknown lease state: leave unacknowledged for provider redelivery.
    }
    const keepAlive = setInterval(() => {
      void modifyAckDeadline(environment, pulled.ackId, 120).catch((error) => {
        observe('ack_extension_failed', String(error instanceof Error ? error.message : error));
      });
    }, 60_000);
    keepAlive.unref();

    const processMessage = (
      runnerEnvironment: WarmRunnerAgentEnvironment,
      message: PulledMessage,
    ): Promise<void> => processObservedMessage(runnerEnvironment, message, observe);
    let completed = false;
    try {
      await processMessage(environment, pulled);
      completed = true;
    } catch (error: unknown) {
      observe('execution_failed', String(error instanceof Error ? error.message : error));
    } finally {
      clearInterval(keepAlive);
    }
    const ackAccepted = (): void => observe('ack_request_accepted');
    const ackUncertain = (error: unknown): void => {
      observe('ack_request_uncertain', String(error instanceof Error ? error.message : error));
    };
    if (completed) await acknowledge(environment, pulled.ackId).then(ackAccepted, ackUncertain);
  }
}

async function main(): Promise<void> {
  await runForever(warmRunnerAgentEnvironment(process.env));
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) {
  main().catch((error) => {
    console.error(String(error instanceof Error ? (error.stack ?? error.message) : error));
    process.exit(1);
  });
}
