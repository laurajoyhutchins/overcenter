import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createGithubRepositoryFromTemplateWithGitHubApp } from 'lib/github-repository-template.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.repository_from_template.create',
    req.body || {},
    (input) => createGithubRepositoryFromTemplateWithGitHubApp(input),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}
