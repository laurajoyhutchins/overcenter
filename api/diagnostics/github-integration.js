import { runGithubIntegrationTests } from 'lib/github-integration.test.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (req, res) {
  const result = await runGithubIntegrationTests();
  return res.status(result.ok ? 200 : 500).json(result);
}