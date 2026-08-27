import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { ensureGithubRepositoryTemplateWithGitHubApp } from 'lib/github-repository-template.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.repository_template.ensure',
    req.body || {},
    (input) => ensureGithubRepositoryTemplateWithGitHubApp(input),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}
