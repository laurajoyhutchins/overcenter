import { runGithubPullRequestReadyTests } from 'lib/github-pull-request-ready.test.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (_req, res) {
  const result = await runGithubPullRequestReadyTests();
  return res.status(result.ok ? 200 : 500).json(result);
}