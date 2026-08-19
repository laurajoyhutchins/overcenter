import { runGithubRepositoryCreateRegressionTests } from 'lib/github-repository-create.js';
import { runGitHubUserAuthRegressionTests } from 'lib/github-user-auth.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (_req, res) {
  const authorization = await runGitHubUserAuthRegressionTests();
  const repository = await runGithubRepositoryCreateRegressionTests();
  return res.status(authorization.ok && repository.ok ? 200 : 500).json({ ok: authorization.ok && repository.ok, authorization, repository });
}