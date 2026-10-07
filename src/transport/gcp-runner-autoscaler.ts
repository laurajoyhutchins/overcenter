import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';
const USER_AGENT = 'Overcenter-GCP-Runner-Autoscaler/1.0';

export type RepositoryBinding = Readonly<{
  full_name: string;
  repository_id: number;
  owner_id: number;
}>;

export type RunnerAutoscalerConfig = Readonly<{
  schema: 'overcenter-gcp-runner-autoscaler/v1';
  poll_interval_ms: number;
  redispatch_after_ms: number;
  runner_label: string;
  repositories: readonly RepositoryBinding[];
}>;

type GitHubToken = Readonly<{
  token: string;
  expiresAtMs: number;
}>;

type WorkflowJob = Readonly<{
  id: number;
  status: string;
  labels: readonly string[];
}>;

type WorkflowRun = Readonly<{
  id: number;
  status: string;
}>;

type PollState = {
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  launched: Map<string, number>;
};

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return Number(value);
}

function requireRepository(value: unknown, label: string): string {
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) {
    throw new TypeError(`${label} must be owner/repository`);
  }
  return text;
}

export function parseRunnerAutoscalerConfig(value: unknown): RunnerAutoscalerConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('runner autoscaler config must be an object');
  }
  const body = value as Record<string, unknown>;
  if (body.schema !== 'overcenter-gcp-runner-autoscaler/v1') {
    throw new TypeError('runner autoscaler config schema is unsupported');
  }

  const pollIntervalMs = requirePositiveInteger(body.poll_interval_ms, 'poll_interval_ms');
  const redispatchAfterMs = requirePositiveInteger(body.redispatch_after_ms, 'redispatch_after_ms');
  if (pollIntervalMs < 2_000 || pollIntervalMs > 60_000) {
    throw new TypeError('poll_interval_ms must be between 2000 and 60000');
  }
  if (redispatchAfterMs < pollIntervalMs || redispatchAfterMs > 3_600_000) {
    throw new TypeError('redispatch_after_ms must be between poll_interval_ms and 3600000');
  }

  const runnerLabel = String(body.runner_label ?? '').trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(runnerLabel)) {
    throw new TypeError('runner_label must be a canonical GitHub runner label');
  }

  const allowedKeys = new Set([
    'schema',
    'poll_interval_ms',
    'redispatch_after_ms',
    'runner_label',
    'repositories',
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key))
      throw new TypeError(`unexpected runner autoscaler config key: ${key}`);
  }

  if (!Array.isArray(body.repositories) || body.repositories.length < 1) {
    throw new TypeError('repositories must contain at least one binding');
  }
  const seen = new Set<string>();
  const repositories = body.repositories.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`repositories[${index}] must be an object`);
    }
    const repository = entry as Record<string, unknown>;
    const fullName = requireRepository(repository.full_name, `repositories[${index}].full_name`);
    const key = fullName.toLowerCase();
    if (seen.has(key)) throw new TypeError(`duplicate repository binding: ${fullName}`);
    seen.add(key);
    return Object.freeze({
      full_name: fullName,
      repository_id: requirePositiveInteger(
        repository.repository_id,
        `repositories[${index}].repository_id`,
      ),
      owner_id: requirePositiveInteger(repository.owner_id, `repositories[${index}].owner_id`),
    });
  });

  return Object.freeze({
    schema: 'overcenter-gcp-runner-autoscaler/v1',
    poll_interval_ms: pollIntervalMs,
    redispatch_after_ms: redispatchAfterMs,
    runner_label: runnerLabel,
    repositories: Object.freeze(repositories),
  });
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function createGitHubAppJwt(appId: string, privateKey: string, nowMs = Date.now()): string {
  if (!/^\d+$/.test(appId)) throw new TypeError('GITHUB_APP_ID must be numeric');
  if (!privateKey.trim()) throw new TypeError('GITHUB_APP_PRIVATE_KEY is required');
  const now = Math.floor(nowMs / 1000);
  const signingInput = `${base64UrlJson({ alg: 'RS256', typ: 'JWT' })}.${base64UrlJson({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId,
  })}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey).toString('base64url')}`;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': USER_AGENT,
  };
}

async function githubJson(path: string, token: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      ...githubHeaders(token),
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub ${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}: ${text.slice(0, 300)}`,
    );
  }
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

class GitHubAppClient {
  readonly #appId: string;
  readonly #privateKey: string;
  readonly #tokenCache = new Map<string, GitHubToken>();

  constructor(appId: string, privateKey: string) {
    this.#appId = appId;
    this.#privateKey = privateKey;
  }

  async installationToken(
    repository: RepositoryBinding,
    permissions: Readonly<Record<string, 'read' | 'write'>>,
  ): Promise<string> {
    const permissionKey = Object.entries(permissions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, level]) => `${name}:${level}`)
      .join(',');
    const cacheKey = `${repository.repository_id}|${permissionKey}`;
    const cached = this.#tokenCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAtMs - now > 5 * 60_000) return cached.token;

    const appJwt = createGitHubAppJwt(this.#appId, this.#privateKey, now);
    const installationBody = (await githubJson(
      `/repos/${repository.full_name}/installation`,
      appJwt,
    )) as Record<string, unknown>;
    const installationId = requirePositiveInteger(installationBody.id, 'installation.id');

    const accessBody = (await githubJson(
      `/app/installations/${installationId}/access_tokens`,
      appJwt,
      {
        method: 'POST',
        body: JSON.stringify({
          repository_ids: [repository.repository_id],
          permissions,
        }),
      },
    )) as Record<string, unknown>;
    const token = String(accessBody.token ?? '').trim();
    const expiresAtMs = Date.parse(String(accessBody.expires_at ?? ''));
    if (!token || !Number.isFinite(expiresAtMs)) {
      throw new Error('GitHub installation token response was incomplete');
    }
    this.#tokenCache.set(cacheKey, { token, expiresAtMs });
    return token;
  }
}

function parseRuns(value: unknown): WorkflowRun[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const runs = (value as Record<string, unknown>).workflow_runs;
  if (!Array.isArray(runs)) return [];
  return runs.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const body = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(body.id)) return [];
    return [{ id: Number(body.id), status: String(body.status ?? '') }];
  });
}

function parseJobs(value: unknown): WorkflowJob[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const jobs = (value as Record<string, unknown>).jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const body = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(body.id)) return [];
    const labels = Array.isArray(body.labels) ? body.labels.map((label) => String(label)) : [];
    return [{ id: Number(body.id), status: String(body.status ?? ''), labels }];
  });
}

export function runnerSchedulingLabel(
  job: WorkflowJob,
  runnerLabel: string,
): string | null {
  if (job.status !== 'queued') return null;
  const base = runnerLabel.toLowerCase();
  const labels = new Set(job.labels.map((label) => label.toLowerCase()));
  if (!labels.has('self-hosted')) return null;

  const schedulingLabels = job.labels.filter((label) => {
    const normalized = label.toLowerCase();
    return normalized === base || normalized.startsWith(base + '-');
  });
  if (schedulingLabels.length !== 1) return null;
  return schedulingLabels[0] ?? null;
}

export function isEligibleRunnerJob(job: WorkflowJob, runnerLabel: string): boolean {
  return runnerSchedulingLabel(job, runnerLabel) !== null;
}

async function verifyRepositoryIdentity(
  repository: RepositoryBinding,
  token: string,
): Promise<void> {
  const body = (await githubJson(`/repos/${repository.full_name}`, token)) as Record<
    string,
    unknown
  >;
  const owner = body.owner;
  const ownerId =
    owner && typeof owner === 'object' && !Array.isArray(owner)
      ? Number((owner as Record<string, unknown>).id)
      : 0;
  if (
    Number(body.id) !== repository.repository_id ||
    ownerId !== repository.owner_id ||
    String(body.full_name ?? '').toLowerCase() !== repository.full_name.toLowerCase()
  ) {
    throw new Error(`repository identity mismatch for ${repository.full_name}`);
  }
}

async function queuedRunnerJobs(
  repository: RepositoryBinding,
  token: string,
  runnerLabel: string,
): Promise<WorkflowJob[]> {
  const runIds = new Set<number>();
  const runsByStatus = await Promise.all(
    (['queued', 'in_progress'] as const).map(async (status) => {
      const ids: number[] = [];
      for (let page = 1; ; page += 1) {
        const body = await githubJson(
          `/repos/${repository.full_name}/actions/runs?status=${status}&per_page=100&page=${page}`,
          token,
        );
        const runs = parseRuns(body);
        ids.push(...runs.map((run) => run.id));
        if (runs.length < 100) break;
      }
      return ids;
    }),
  );
  for (const ids of runsByStatus) for (const runId of ids) runIds.add(runId);

  const jobs: WorkflowJob[] = [];
  for (const runId of runIds) {
    for (let page = 1; ; page += 1) {
      const body = await githubJson(
        `/repos/${repository.full_name}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
        token,
      );
      const pageJobs = parseJobs(body);
      jobs.push(...pageJobs.filter((job) => isEligibleRunnerJob(job, runnerLabel)));
      if (pageJobs.length < 100) break;
    }
  }
  return jobs;
}

async function cloudRunIdentityToken(audience: string): Promise<string> {
  const response = await fetch(
    `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=full`,
    { headers: { 'Metadata-Flavor': 'Google' } },
  );
  const token = (await response.text()).trim();
  if (!response.ok || !token) {
    throw new Error(
      `Cloud Run identity token request failed with HTTP ${response.status}: ${token.slice(0, 300)}`,
    );
  }
  return token;
}

async function launchRunner(
  launcherUrl: string,
  identityToken: string,
  config: RunnerAutoscalerConfig,
  sourceRepository: RepositoryBinding,
  job: WorkflowJob,
): Promise<void> {
  const schedulingLabel = runnerSchedulingLabel(job, config.runner_label);
  if (schedulingLabel === null) {
    throw new Error('queued runner job lost its admitted scheduling label');
  }
  const response = await fetch(`${launcherUrl}/launch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${identityToken}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      repository: sourceRepository.full_name,
      repository_id: sourceRepository.repository_id,
      owner_id: sourceRepository.owner_id,
      job_id: job.id,
      runner_label: schedulingLabel,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GCP runner launcher failed with HTTP ${response.status}: ${text.slice(0, 300)}`,
    );
  }
}

function pruneLaunches(state: PollState, redispatchAfterMs: number, now: number): void {
  for (const [key, timestamp] of state.launched) {
    if (now - timestamp >= redispatchAfterMs) state.launched.delete(key);
  }
}

async function pollOnce(
  client: GitHubAppClient,
  config: RunnerAutoscalerConfig,
  state: PollState,
  launcherUrl: string,
): Promise<void> {
  if (state.running) return;
  state.running = true;
  const now = Date.now();
  state.lastAttemptAt = new Date(now).toISOString();
  pruneLaunches(state, config.redispatch_after_ms, now);

  try {
    const scans = await Promise.all(
      config.repositories.map(async (repository) => {
        try {
          const token = await client.installationToken(repository, { actions: 'read' });
          await verifyRepositoryIdentity(repository, token);
          const jobs = await queuedRunnerJobs(repository, token, config.runner_label);
          return { repository, jobs, error: null as string | null };
        } catch (error) {
          return {
            repository,
            jobs: [] as WorkflowJob[],
            error: String(error instanceof Error ? error.message : error),
          };
        }
      }),
    );
    const errors = scans.flatMap(({ repository, error }) =>
      error === null ? [] : [`${repository.full_name}: ${error}`],
    );
    const launchable = scans.flatMap(({ repository, jobs }) =>
      jobs
        .filter((job) => {
          const prior = state.launched.get(`${repository.repository_id}:${job.id}`);
          return prior === undefined || now - prior >= config.redispatch_after_ms;
        })
        .map((job) => ({ repository, job })),
    );

    if (launchable.length > 0) {
      const identityToken = await cloudRunIdentityToken(launcherUrl);
      for (const { repository, job } of launchable) {
        try {
          await launchRunner(launcherUrl, identityToken, config, repository, job);
          state.launched.set(`${repository.repository_id}:${job.id}`, now);
          console.log(
            JSON.stringify({
              event: 'runner_launched',
              repository: repository.full_name,
              repository_id: repository.repository_id,
              job_id: job.id,
            }),
          );
        } catch (error) {
          errors.push(
            `${repository.full_name} job ${job.id}: ${String(
              error instanceof Error ? error.message : error,
            )}`,
          );
        }
      }
    }
    if (errors.length === 0) {
      state.lastSuccessAt = new Date().toISOString();
      state.lastError = null;
    } else {
      state.lastError = errors.join(' | ');
      console.error(JSON.stringify({ event: 'poll_partial_failure', errors }));
    }
  } catch (error) {
    state.lastError = String(error instanceof Error ? error.message : error);
    console.error(JSON.stringify({ event: 'poll_failed', error: state.lastError }));
  } finally {
    state.running = false;
  }
}

function healthResponse(state: PollState): string {
  return JSON.stringify({
    ok: state.lastError === null,
    poll_running: state.running,
    last_attempt_at: state.lastAttemptAt,
    last_success_at: state.lastSuccessAt,
    last_error: state.lastError,
    launch_cache_size: state.launched.size,
  });
}

async function loadConfig(path: string): Promise<RunnerAutoscalerConfig> {
  return parseRunnerAutoscalerConfig(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

async function main(): Promise<void> {
  const appId = String(process.env.GITHUB_APP_ID ?? '').trim();
  const privateKey = String(process.env.GITHUB_APP_PRIVATE_KEY ?? '').trim();
  const configPath =
    String(process.env.OVERCENTER_RUNNER_CONFIG_PATH ?? '').trim() ||
    'config/gcp-runner-autoscaler.json';
  const launcherUrl = String(process.env.OVERCENTER_RUNNER_LAUNCHER_URL ?? '')
    .trim()
    .replace(/\/$/, '');
  if (!/^https:\/\/[^/]+$/.test(launcherUrl)) {
    throw new TypeError('OVERCENTER_RUNNER_LAUNCHER_URL must be an HTTPS origin');
  }
  const port = Number(process.env.PORT ?? '8080');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('PORT must be a valid TCP port');
  }

  const config = await loadConfig(configPath);
  const client = new GitHubAppClient(appId, privateKey);
  const state: PollState = {
    running: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    launched: new Map(),
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(healthResponse(state));
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));

  await pollOnce(client, config, state, launcherUrl);
  const timer = setInterval(
    () => void pollOnce(client, config, state, launcherUrl),
    config.poll_interval_ms,
  );
  timer.unref();

  const shutdown = (): void => {
    clearInterval(timer);
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
