import { spawnSync } from 'node:child_process';

import type { KernelCore } from '../../authority/engine.ts';
import { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../../effect-adapter.ts';
import type { ExecutionPermit, SourceIntegrationPostcondition } from '../../model.ts';
import { canonicalGitHubRef, observeCertifiedGitHubRefFence } from './certified-ref.ts';
import { GITHUB_API_VERSION } from './contract.ts';
import {
  githubGet,
  githubGetAsync,
  runGitHubReadObserverAsync,
  type GitHubJsonGet,
  type GitHubJsonGetAsync,
} from './rest.ts';

export { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../../effect-adapter.ts';

type PullRequestBody = { title: string; head: string; base: string };
type PullRequestResponse = { status: number; body: string };
type RefFence = ReturnType<typeof observeCertifiedGitHubRefFence>;

export type GitHubPullRequestPost = (
  token: string,
  path: string,
  body: PullRequestBody,
) => Promise<PullRequestResponse>;

export type GitHubPullRequestPostSync = (
  token: string,
  path: string,
  body: PullRequestBody,
) => PullRequestResponse;

async function githubPost(
  token: string,
  path: string,
  body: PullRequestBody,
): Promise<PullRequestResponse> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.text() };
}

function githubPostSync(token: string, path: string, body: PullRequestBody): PullRequestResponse {
  if (!token || /[\r\n"]/.test(token)) throw new Error('GITHUB_TOKEN_UNAVAILABLE');
  const config = [
    `header = "Authorization: Bearer ${token}"`,
    'header = "Accept: application/vnd.github+json"',
    `header = "X-GitHub-Api-Version: ${GITHUB_API_VERSION}"`,
    '',
  ].join('\n');
  const result = spawnSync(
    'curl',
    [
      '--silent',
      '--show-error',
      '--config',
      '-',
      '--request',
      'POST',
      '--header',
      'Content-Type: application/json',
      '--data-binary',
      JSON.stringify(body),
      '--write-out',
      '\n%{http_code}',
      `https://api.github.com${path}`,
    ],
    { input: config, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `SOURCE_PR_PUBLICATION_TRANSPORT_FAILED:${String(result.stderr).trim()}`,
    );
  }
  const boundary = result.stdout.lastIndexOf('\n');
  if (boundary < 0) throw new Error('SOURCE_PR_PUBLICATION_RESPONSE_INVALID');
  const status = Number(result.stdout.slice(boundary + 1));
  if (!Number.isSafeInteger(status)) throw new Error('SOURCE_PR_PUBLICATION_RESPONSE_INVALID');
  return { status, body: result.stdout.slice(0, boundary) };
}

function publicationTarget(p: SourceIntegrationPostcondition): {
  headRef: string;
  baseRef: string;
  path: string;
  branchName: string;
  body: PullRequestBody;
} {
  if (
    p.provider !== 'github' ||
    !Number.isSafeInteger(p.repository_id) ||
    Number(p.repository_id) <= 0 ||
    typeof p.repository_full_name !== 'string' ||
    !/^[^/]+\/[^/]+$/.test(p.repository_full_name) ||
    typeof p.ref !== 'string' ||
    typeof p.commit_sha !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(p.commit_sha) ||
    typeof p.base_ref !== 'string' ||
    p.base_ref.length === 0 ||
    p.base_ref.startsWith('refs/') ||
    typeof p.expected_base_sha !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(p.expected_base_sha)
  ) {
    throw new Error('SOURCE_PR_PUBLICATION_POSTCONDITION_INVALID');
  }

  const headRef = canonicalGitHubRef(p.ref);
  if (!headRef.startsWith('refs/heads/')) {
    throw new Error('SOURCE_PR_PUBLICATION_HEAD_REF_INVALID');
  }
  const [owner, repo] = p.repository_full_name.split('/');
  if (!owner || !repo) throw new Error('SOURCE_PR_PUBLICATION_REPOSITORY_INVALID');
  const branchName = headRef.slice('refs/heads/'.length);
  return {
    headRef,
    baseRef: `refs/heads/${p.base_ref}`,
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
    branchName,
    body: {
      title: `Overcenter verified candidate ${p.commit_sha.slice(0, 12)}`,
      head: branchName,
      base: p.base_ref,
    },
  };
}

function assertPublicationFences(fences: { head: RefFence; base: RefFence }): void {
  if (fences.head.state !== 'CURRENT' || !fences.head.repository_full_name) {
    throw new Error(`SOURCE_PR_PUBLICATION_HEAD_NOT_CURRENT:${fences.head.reason}`);
  }
  if (fences.base.state !== 'CURRENT' || !fences.base.repository_full_name) {
    throw new Error(`SOURCE_PR_PUBLICATION_BASE_NOT_CURRENT:${fences.base.reason}`);
  }
  if (
    fences.head.repository_full_name.toLowerCase() !==
    fences.base.repository_full_name.toLowerCase()
  ) {
    throw new Error('SOURCE_PR_PUBLICATION_REPOSITORY_MISMATCH');
  }
}

function observePublicationFences(
  token: string,
  p: SourceIntegrationPostcondition,
  target: ReturnType<typeof publicationTarget>,
  get: GitHubJsonGet,
  clock: () => string,
): { head: RefFence; base: RefFence } {
  return {
    head: observeCertifiedGitHubRefFence(token, {
      repositoryId: p.repository_id!,
      repositoryFullName: p.repository_full_name!,
      ref: target.headRef,
      expectedSha: p.commit_sha!,
      get,
      clock,
    }),
    base: observeCertifiedGitHubRefFence(token, {
      repositoryId: p.repository_id!,
      repositoryFullName: p.repository_full_name!,
      ref: target.baseRef,
      expectedSha: p.expected_base_sha!,
      get,
      clock,
    }),
  };
}

export async function performGitHubPullRequestPublicationEffect(
  kernel: KernelCore,
  permit: ExecutionPermit,
  {
    token,
    get = githubGetAsync,
    post = githubPost,
    clock = () => new Date().toISOString(),
    postcondition,
  }: {
    token: string;
    get?: GitHubJsonGetAsync;
    post?: GitHubPullRequestPost;
    clock?: () => string;
    postcondition?: SourceIntegrationPostcondition;
  },
): Promise<void> {
  if (!token) throw new Error('GITHUB_TOKEN_UNAVAILABLE');
  const authority = kernel.authorizeEffect(
    permit,
    GITHUB_SOURCE_INTEGRATION_EFFECT,
    postcondition,
  );
  const p = authority.postcondition;
  const target = publicationTarget(p);
  const fences = await runGitHubReadObserverAsync(
    token,
    (syncGet) => observePublicationFences(token, p, target, syncGet, clock),
    get,
  );
  assertPublicationFences(fences);

  await kernel.performEffect(authority, async () => {
    const response = await post(token, target.path, target.body);
    if (response.status !== 201) {
      throw new Error(`SOURCE_PR_PUBLICATION_FAILED:${response.status}:${response.body}`);
    }
  });
}

export function performGitHubPullRequestPublicationEffectSync(
  kernel: KernelCore,
  permit: ExecutionPermit,
  {
    token,
    get = githubGet,
    post = githubPostSync,
    clock = () => new Date().toISOString(),
    postcondition,
  }: {
    token: string;
    get?: GitHubJsonGet;
    post?: GitHubPullRequestPostSync;
    clock?: () => string;
    postcondition?: SourceIntegrationPostcondition;
  },
): void {
  if (!token) throw new Error('GITHUB_TOKEN_UNAVAILABLE');
  const authority = kernel.authorizeEffect(
    permit,
    GITHUB_SOURCE_INTEGRATION_EFFECT,
    postcondition,
  );
  const p = authority.postcondition;
  const target = publicationTarget(p);
  assertPublicationFences(observePublicationFences(token, p, target, get, clock));

  kernel.performEffectSync(authority, () => {
    const response = post(token, target.path, target.body);
    if (response.status !== 201) {
      throw new Error(`SOURCE_PR_PUBLICATION_FAILED:${response.status}:${response.body}`);
    }
  });
}
