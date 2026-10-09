import { spawnSync } from 'node:child_process';
import { githubRepositoryPath } from '../providers/github/evidence-primitives.ts';
import { GITHUB_API_VERSION } from '../providers/github/contract.ts';
import type { SourceCandidatePublicationResult } from './source-integration.ts';

// GITHUB_TOKEN branch pushes do not start workflows. Explicit workflow dispatch is
// a validation transport; it does not integrate source or settle the transaction.
export function dispatchSourceValidation(
  token: string,
  repositoryFullName: string,
  workflowPath: string,
  publication: SourceCandidatePublicationResult,
  runtimeSha: string,
  post: (
    token: string,
    path: string,
    body: { ref: string; inputs: { candidate_sha: string; runtime_sha: string } },
  ) => number = postDispatch,
): void {
  if (publication.state === 'CONFLICT') throw new Error('SOURCE_VALIDATION_PUBLICATION_CONFLICT');
  const workflow = /^\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)$/.exec(workflowPath)?.[1];
  if (!workflow) throw new Error('SOURCE_VALIDATION_WORKFLOW_INVALID');
  if (!/^[0-9a-f]{40}$/.test(publication.candidate_sha))
    throw new Error('SOURCE_VALIDATION_CANDIDATE_INVALID');
  if (!/^[0-9a-f]{40}$/.test(runtimeSha)) throw new Error('SOURCE_VALIDATION_RUNTIME_INVALID');
  if (!/^refs\/heads\/overcenter\/candidate\/[A-Za-z0-9._-]+$/.test(publication.ref))
    throw new Error('SOURCE_VALIDATION_REF_INVALID');
  const path = githubRepositoryPath(
    repositoryFullName,
    `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
  );
  if (
    post(token, path, {
      ref: publication.ref.slice('refs/heads/'.length),
      inputs: { candidate_sha: publication.candidate_sha, runtime_sha: runtimeSha },
    }) !== 204
  )
    throw new Error('SOURCE_VALIDATION_DISPATCH_FAILED');
}

function postDispatch(
  token: string,
  path: string,
  body: { ref: string; inputs: { candidate_sha: string; runtime_sha: string } },
): number {
  if (!token || /[\r\n"]/.test(token)) throw new Error('SOURCE_VALIDATION_TOKEN_INVALID');
  const config = `header = "Authorization: Bearer ${token}"\nheader = "Accept: application/vnd.github+json"\nheader = "X-GitHub-Api-Version: ${GITHUB_API_VERSION}"\n`;
  const result = spawnSync(
    'curl',
    [
      '--silent',
      '--show-error',
      '--fail',
      '--config',
      '-',
      '--request',
      'POST',
      '--header',
      'Content-Type: application/json',
      '--data-binary',
      JSON.stringify(body),
      '--output',
      '/dev/null',
      '--write-out',
      '%{http_code}',
      `https://api.github.com${path}`,
    ],
    { input: config, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  if (result.status !== 0) throw new Error('SOURCE_VALIDATION_DISPATCH_UNCERTAIN');
  return Number(result.stdout);
}
