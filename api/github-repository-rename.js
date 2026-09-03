import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { renameGithubRepositoryWithGitHubApp } from 'lib/github-repository-rename.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.repository.rename',
    req.body || {},
    (input) => renameGithubRepositoryWithGitHubApp(input),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}
