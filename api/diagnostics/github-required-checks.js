import { runGithubRequiredChecksTests } from 'lib/github-required-checks.test.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (req, res) {
  const result = await runGithubRequiredChecksTests();
  return res.status(result.ok ? 200 : 500).json(result);
}