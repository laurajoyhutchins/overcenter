import { runGithubArchiveRepositoryTests } from 'lib/github-archive-repository.test.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (req, res) {
  const result = await runGithubArchiveRepositoryTests();
  return res.status(result.ok ? 200 : 500).json(result);
}
