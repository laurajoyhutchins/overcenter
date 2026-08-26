import { db } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { reconcileGithubIntegrationWithGitHubApp } from 'lib/github-integration.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.integration.reconcile',
    req.body || {},
    (input) => reconcileGithubIntegrationWithGitHubApp(input, { db }),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}