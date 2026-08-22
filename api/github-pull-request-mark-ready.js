import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { markGithubPullRequestReadyWithGitHubApp } from 'lib/github-pull-request-ready.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.pull_request.mark_ready',
    req.body || {},
    (input) => markGithubPullRequestReadyWithGitHubApp(input),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}