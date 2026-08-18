import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { migrateGithubDefaultBranchWithGitHubApp } from 'lib/github-default-branch.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.default_branch.migrate',
    req.body || {},
    (input) => migrateGithubDefaultBranchWithGitHubApp(input),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}