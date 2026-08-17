import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { deleteGithubBranchWithGitHubApp } from 'lib/github-delete-branch.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.delete_branch',
    req.body || {},
    (input) => deleteGithubBranchWithGitHubApp(input),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}