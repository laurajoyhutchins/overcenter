import type { KernelCore } from '../../authority/engine.ts';
import type { ExecutionPermit } from '../../model.ts';
import { GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT } from '../../effect-adapter.ts';
import { GITHUB_API_VERSION } from './contract.ts';
import { observeCertifiedGitHubRead } from './certified-read.ts';
import { observeCertifiedGitHubRepository } from './certified-repository.ts';
import { evaluateCertifiedGitHubPullRequestIdentity } from './certified-predicates.ts';
import { githubGetAsync, runGitHubReadObserverAsync, type GitHubJsonGetAsync } from './rest.ts';

export { GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT } from '../../effect-adapter.ts';

export type GitHubUpdateBranchPut = (
  token: string,
  path: string,
  body: { expected_head_sha: string },
) => Promise<{ status: number; body: string }>;

async function githubPut(
  token: string,
  path: string,
  body: { expected_head_sha: string },
): Promise<{ status: number; body: string }> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: 'PUT',
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

export async function performGitHubPullRequestUpdateBranchEffect(
  kernel: KernelCore,
  permit: ExecutionPermit,
  {
    token,
    get = githubGetAsync,
    put = githubPut,
    clock = () => new Date().toISOString(),
  }: {
    token: string;
    get?: GitHubJsonGetAsync;
    put?: GitHubUpdateBranchPut;
    clock?: () => string;
  },
): Promise<{
  repository_id: number;
  repository_full_name: string;
  pull_number: number;
  previous_head_sha: string;
}> {
  if (!token) throw new Error('GITHUB_TOKEN_UNAVAILABLE');
  const authority = kernel.authorizeEffect(permit, GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT);
  const p = authority.postcondition;
  const identity = await runGitHubReadObserverAsync(
    token,
    (syncGet) => {
      const repository = observeCertifiedGitHubRepository(token, {
        repositoryId: p.repository_id,
        repositoryFullName: p.repository_full_name,
        get: syncGet,
        clock,
        observerId: 'github-pr-identity/v1',
      });
      const read = observeCertifiedGitHubRead(token, {
        repositoryFullName: repository.fact.object.full_name,
        operation: 'pull_request',
        parameters: { pull_number: p.pull_number },
        get: syncGet,
        clock,
        observerId: 'github-pr-identity/v1',
      });
      if (read.state !== 'observed') throw new Error('GITHUB_PR_UPDATE_BRANCH_IDENTITY_INCOMPLETE');
      return {
        repository_full_name: repository.fact.object.full_name,
        ...evaluateCertifiedGitHubPullRequestIdentity(read.value, p.pull_number, {
          node_id: p.pull_node_id,
          state: 'open',
          head_sha: p.expected_previous_head_sha,
          base_ref: p.base_ref,
          base_sha: p.expected_base_sha,
        }),
      };
    },
    get,
  );
  if (identity.differences.length !== 0) {
    throw new Error(
      `GITHUB_PR_UPDATE_BRANCH_IDENTITY_NOT_CURRENT:${identity.differences.join(',')}`,
    );
  }
  const [owner, repo] = identity.repository_full_name.split('/');
  if (!owner || !repo) throw new Error('GITHUB_PR_UPDATE_BRANCH_REPOSITORY_INVALID');
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${p.pull_number}/update-branch`;

  return kernel.performEffect(authority, async () => {
    const response = await put(token, path, { expected_head_sha: p.expected_previous_head_sha });
    if (response.status !== 202) {
      throw new Error(`GITHUB_PR_UPDATE_BRANCH_FAILED:${response.status}:${response.body}`);
    }
    return {
      repository_id: p.repository_id,
      repository_full_name: identity.repository_full_name!,
      pull_number: p.pull_number,
      previous_head_sha: p.expected_previous_head_sha,
    };
  });
}
