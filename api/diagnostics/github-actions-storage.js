import { runGithubActionsStorageTests } from 'lib/github-actions-storage.test.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (_req, res) {
  const result = await runGithubActionsStorageTests();
  return res.status(result.ok ? 200 : 500).json(result);
}