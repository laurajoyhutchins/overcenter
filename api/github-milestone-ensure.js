import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { ensureGithubMilestoneWithGitHubApp } from 'lib/github-milestone.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.milestone.ensure',
    req.body || {},
    (input) => ensureGithubMilestoneWithGitHubApp(input),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}
