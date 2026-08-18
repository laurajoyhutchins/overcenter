import { runGithubStackTests } from 'lib/github-stack.test.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (_req, res) {
  const result = await runGithubStackTests();
  return res.status(result.ok ? 200 : 500).json(result);
}