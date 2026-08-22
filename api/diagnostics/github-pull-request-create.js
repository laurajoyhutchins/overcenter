import { runGithubPullRequestCreateRegressionTests } from 'lib/github-pull-request-create.test.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (_req, res) {
  const result = await runGithubPullRequestCreateRegressionTests();
  res.status(result.ok ? 200 : 500).json(result);
}