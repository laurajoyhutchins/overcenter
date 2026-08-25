import { executeCommand } from 'lib/command-response.js';
import { ensureGithubAutoMergeWithGitHubApp } from 'lib/github-auto-merge.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCommand(
    'github.auto_merge.ensure',
    () => ensureGithubAutoMergeWithGitHubApp(req.body || {}),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}
