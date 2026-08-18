import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { githubActionsStorageWithGitHubApp } from 'lib/github-actions-storage.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.actions_storage',
    req.body || {},
    (input) => githubActionsStorageWithGitHubApp(input),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}