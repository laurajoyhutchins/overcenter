import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createGithubPullRequestWithGitHubApp } from 'lib/github-pull-request-create.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.pull_request.create',
    req.body || {},
    (input) => createGithubPullRequestWithGitHubApp(input),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}