import type { KernelCore } from '../../authority/engine.ts';
import { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../../effect-adapter.ts';
import type { ExecutionPermit } from '../../model.ts';
import { GITHUB_API_VERSION } from './contract.ts';
import { canonicalGitHubRef, observeCertifiedGitHubRefFence } from './certified-ref.ts';
import { githubGetAsync, runGitHubReadObserverAsync, type GitHubJsonGetAsync } from './rest.ts';

export { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../../effect-adapter.ts';

export type GitHubPullRequestPost = (
  token: string,
  path: string,
  body: { title: string; head: string; base: string },
) => Promise<{ status: number; body: string }>;

async function githubPost(
  token: string,
  path: string,
  body: { title: string; head: string; base: string },
): Promise<{ status: number; body: string }> {
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

export async function performGitHubPullRequestPublicationEffect(
  kernel: KernelCore,
  permit: ExecutionPermit,
  {
    token,
    get = githubGetAsync,
    post = githubPost,
    clock = () => new Date().toISOString(),
  }: {
    token: string;
    get?: GitHubJsonGetAsync;
    post?: GitHubPullRequestPost;
    clock?: () => string;
  },
): Promise<{
  repository_id: number;
  repository_full_name: string;
  ref: string;
  commit_sha: string;
  base_ref: string;
  base_sha: string;
}> {
  if (!token) throw new Error('GITHUB_TOKEN_UNAVAILABLE');
  const authority = kernel.authorizeEffect(permit, GITHUB_SOURCE_INTEGRATION_EFFECT);
  const p = authority.postcondition;
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
  const baseRef = `refs/heads/${p.base_ref}`;

  const fences = await runGitHubReadObserverAsync(
    token,
    (syncGet) => ({
      head: observeCertifiedGitHubRefFence(token, {
        repositoryId: p.repository_id!,
        repositoryFullName: p.repository_full_name!,
        ref: headRef,
        expectedSha: p.commit_sha!,
        get: syncGet,
        clock,
      }),
      base: observeCertifiedGitHubRefFence(token, {
        repositoryId: p.repository_id!,
        repositoryFullName: p.repository_full_name!,
        ref: baseRef,
        expectedSha: p.expected_base_sha!,
        get: syncGet,
        clock,
      }),
    }),
    get,
  );

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

  const [owner, repo] = fences.head.repository_full_name.split('/');
  if (!owner || !repo) throw new Error('SOURCE_PR_PUBLICATION_REPOSITORY_INVALID');
  const branchName = headRef.slice('refs/heads/'.length);
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;

  return kernel.performEffect(authority, async () => {
    const response = await post(token, path, {
      title: `Overcenter verified candidate ${p.commit_sha!.slice(0, 12)}`,
      head: branchName,
      base: p.base_ref!,
    });
    if (response.status !== 201) {
      throw new Error(`SOURCE_PR_PUBLICATION_FAILED:${response.status}:${response.body}`);
    }
    return {
      repository_id: p.repository_id!,
      repository_full_name: fences.head.repository_full_name!,
      ref: headRef,
      commit_sha: p.commit_sha!,
      base_ref: p.base_ref!,
      base_sha: p.expected_base_sha!,
    };
  });
}
