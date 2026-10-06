import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';
const USER_AGENT = 'Overcenter-GCP-Runner-Autoscaler/1.0';
const REPOSITORY_IDENTITY_REVERIFY_MS = 10 * 60_000;
const GITHUB_READ_CONCURRENCY = 8;
const LAUNCH_CONCURRENCY = 8;

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
  launched: Map<string, number>;
  repositoryIdentityVerifiedAt: Map<number, number>;
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

export function isEligibleRunnerJob(job: WorkflowJob, runnerLabel: string): boolean {
  if (job.status !== 'queued') return false;
  const labels = new Set(job.labels.map((label) => label.toLowerCase()));
  return labels.has('self-hosted') && labels.has(runnerLabel.toLowerCase());
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
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

async function verifyRepositoryIdentityIfStale(
  repository: RepositoryBinding,
  token: string,
  state: PollState,
  now: number,
): Promise<void> {
  const verifiedAt = state.repositoryIdentityVerifiedAt.get(repository.repository_id);
  if (verifiedAt !== undefined && now - verifiedAt < REPOSITORY_IDENTITY_REVERIFY_MS) return;
  await verifyRepositoryIdentity(repository, token);
  state.repositoryIdentityVerifiedAt.set(repository.repository_id, now);
}

async function workflowRunsForStatus(
  repository: RepositoryBinding,
  token: string,
  status: 'queued' | 'in_progress',
): Promise<WorkflowRun[]> {
  const runs: WorkflowRun[] = [];
  for (let page = 1; ; page += 1) {
    const body = await githubJson(
      `/repos/${repository.full_name}/actions/runs?status=${status}&per_page=100&page=${page}`,
      token,
    );
    const pageRuns = parseRuns(body);
    runs.push(...pageRuns);
    if (pageRuns.length < 100) break;
  }
  return runs;
}

async function workflowJobsForRun(
  repository: RepositoryBinding,
  token: string,
  runId: number,
  runnerLabel: string,
): Promise<WorkflowJob[]> {
  const jobs: WorkflowJob[] = [];
  for (let page = 1; ; page += 1) {
    const body = await githubJson(
      `/repos/${repository.full_name}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
      token,
    );
    const pageJobs = parseJobs(body);
    jobs.push(...pageJobs.filter((job) => isEligibleRunnerJob(job, runnerLabel)));
    if (pageJobs.length < 100) break;
  }
  return jobs;
}

async function queuedRunnerJobs(
  repository: RepositoryBinding,
  token: string,
  runnerLabel: string,
): Promise<WorkflowJob[]> {
  const runsByStatus = await Promise.all(
    (['queued', 'in_progress'] as const).map((status) =>
      workflowRunsForStatus(repository, token, status),
    ),
  );
  const runIds = [...new Set(runsByStatus.flat().map((run) => run.id))].sort(
    (left, right) => left - right,
  );
  const jobsByRun = await mapConcurrent(runIds, GITHUB_READ_CONCURRENCY, (runId) =>
    workflowJobsForRun(repository, token, runId, runnerLabel),
  );
  const jobs = new Map<number, WorkflowJob>();
  for (const job of jobsByRun.flat()) jobs.set(job.id, job);
  return [...jobs.values()].sort((left, right) => left.id - right.id);
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
  launcherToken: string,
  config: RunnerAutoscalerConfig,
  sourceRepository: RepositoryBinding,
  job: WorkflowJob,
): Promise<void> {
  const response = await fetch(`${launcherUrl}/launch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${launcherToken}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      repository: sourceRepository.full_name,
      repository_id: sourceRepository.repository_id,
      owner_id: sourceRepository.owner_id,
      job_id: job.id,
      runner_label: config.runner_label,
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

type RepositoryScan = Readonly<{
  repository: RepositoryBinding;
  jobs: readonly WorkflowJob[];
}>;

async function scanRepository(
  client: GitHubAppClient,
  repository: RepositoryBinding,
  config: RunnerAutoscalerConfig,
  state: PollState,
  now: number,
): Promise<RepositoryScan> {
  const token = await client.installationToken(repository, { actions: 'read' });
  await verifyRepositoryIdentityIfStale(repository, token, state, now);
  return {
    repository,
    jobs: await queuedRunnerJobs(repository, token, config.runner_label),
  };
}

async function pollOnce(
  client: GitHubAppClient,
  config: RunnerAutoscalerConfig,
  state: PollState,
  launcherUrl: string,
): Promise<void> {
  const now = Date.now();
  pruneLaunches(state, config.redispatch_after_ms, now);

  const scans = await Promise.allSettled(
    config.repositories.map((repository) => scanRepository(client, repository, config, state, now)),
  );
  const scanErrors: string[] = [];
  const launchCandidates: Array<{ repository: RepositoryBinding; job: WorkflowJob }> = [];
  for (const scan of scans) {
    if (scan.status === 'rejected') {
      scanErrors.push(String(scan.reason instanceof Error ? scan.reason.message : scan.reason));
      continue;
    }
    for (const job of scan.value.jobs) {
      const key = `${scan.value.repository.repository_id}:${job.id}`;
      const prior = state.launched.get(key);
      if (prior !== undefined && now - prior < config.redispatch_after_ms) continue;
      launchCandidates.push({ repository: scan.value.repository, job });
    }
  }

  const launchErrors: string[] = [];
  if (launchCandidates.length > 0) {
    const launcherToken = await cloudRunIdentityToken(launcherUrl);
    const launches = await mapConcurrent(
      launchCandidates,
      LAUNCH_CONCURRENCY,
      async ({ repository, job }) => {
        try {
          await launchRunner(launcherUrl, launcherToken, config, repository, job);
          state.launched.set(`${repository.repository_id}:${job.id}`, now);
          console.log(
            JSON.stringify({
              event: 'runner_launched',
              repository: repository.full_name,
              repository_id: repository.repository_id,
              job_id: job.id,
            }),
          );
          return null;
        } catch (error) {
          return String(error instanceof Error ? error.message : error);
        }
      },
    );
    launchErrors.push(...launches.filter((error): error is string => error !== null));
  }

  const errors = [...scanErrors, ...launchErrors];
  if (errors.length > 0) {
    console.error(
      JSON.stringify({ event: 'poll_partial_failure', error: errors.join(' | ').slice(0, 2_048) }),
    );
  }
}

async function loadConfig(path: string): Promise<RunnerAutoscalerConfig> {
  return parseRunnerAutoscalerConfig(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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
  const config = await loadConfig(configPath);
  const client = new GitHubAppClient(appId, privateKey);
  const state: PollState = {
    launched: new Map(),
    repositoryIdentityVerifiedAt: new Map(),
  };
  let stopping = false;
  const shutdown = (): void => {
    stopping = true;
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  while (!stopping) {
    const startedAt = Date.now();
    try {
      await pollOnce(client, config, state, launcherUrl);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 2_048);
      console.error(JSON.stringify({ event: 'poll_failed', error: message }));
    }
    const elapsed = Date.now() - startedAt;
    await sleep(Math.max(0, config.poll_interval_ms - elapsed));
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) {
  main().catch((error) => {
    console.error(String(error instanceof Error ? (error.stack ?? error.message) : error));
    process.exit(1);
  });
}
