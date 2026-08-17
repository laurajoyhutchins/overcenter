import { executeCommand } from 'lib/command-response.js';
import { deleteGithubBranchWithGitHubApp } from 'lib/github-delete-branch.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCommand(
    'github.delete_branch',
    () => deleteGithubBranchWithGitHubApp(req.body || {}),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}