import { runGithubDefaultBranchTests } from 'lib/github-default-branch.test.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (_req, res) {
  const result = await runGithubDefaultBranchTests();
  return res.status(result.ok ? 200 : 500).json(result);
}