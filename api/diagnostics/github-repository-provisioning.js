import { runGithubRepositoryCreateRegressionTests } from 'lib/github-repository-create.js';
import { runGithubRepositoryApprovalRegressionTests } from 'lib/github-repository-approval.js';
import { runGitHubUserAuthRegressionTests } from 'lib/github-user-auth.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (_req, res) {
  const authorization = await runGitHubUserAuthRegressionTests();
  const approval = await runGithubRepositoryApprovalRegressionTests();
  const repository = await runGithubRepositoryCreateRegressionTests();
  const ok = authorization.ok && approval.ok && repository.ok;
  return res.status(ok ? 200 : 500).json({ ok, authorization, approval, repository });
}