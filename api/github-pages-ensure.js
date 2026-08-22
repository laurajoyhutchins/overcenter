import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { ensureGitHubPagesWithGitHubApp } from 'lib/github-pages.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.pages.ensure',
    req.body || {},
    (input) => ensureGitHubPagesWithGitHubApp(input),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}