import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { ensureGithubRepositoryMetadataWithGitHubApp } from 'lib/github-repository-metadata.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.repository_metadata.ensure',
    req.body || {},
    (input) => ensureGithubRepositoryMetadataWithGitHubApp(input),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}