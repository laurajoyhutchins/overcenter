import { runGithubBranchPolicyTests } from 'lib/github-branch-policy.test.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (_req, res) {
  const result = await runGithubBranchPolicyTests();
  return res.status(result.ok ? 200 : 500).json(result);
}