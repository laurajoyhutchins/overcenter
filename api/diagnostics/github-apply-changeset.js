import { runGithubApplyChangesetTests } from 'lib/github-apply-changeset.test.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (req, res) {
  const result = await runGithubApplyChangesetTests();
  return res.status(result.ok ? 200 : 500).json(result);
}