import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { reconcileGithubStackWithGitHubApp } from 'lib/github-stack.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.stack.reconcile',
    req.body || {},
    (input) => reconcileGithubStackWithGitHubApp(input),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}