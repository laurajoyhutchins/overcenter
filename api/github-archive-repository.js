import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { archiveGithubRepositoryWithGitHubApp } from 'lib/github-archive-repository.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.archive_repository',
    req.body || {},
    (input) => archiveGithubRepositoryWithGitHubApp(input),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}
