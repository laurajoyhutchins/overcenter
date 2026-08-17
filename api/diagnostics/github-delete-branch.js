import { runGithubDeleteBranchTests } from 'lib/github-delete-branch.test.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (req, res) {
  const result = await runGithubDeleteBranchTests();
  return res.status(result.ok ? 200 : 500).json(result);
}