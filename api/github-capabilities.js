import { inspectGitHubAppCapabilities } from 'lib/github-app-auth.js';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.capabilities',
    req.body || {},
    (input) => inspectGitHubAppCapabilities(input.repo),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}