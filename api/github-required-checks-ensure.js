import { executeCommand } from 'lib/command-response.js';
import { ensureGithubRequiredChecksWithGitHubApp } from 'lib/github-required-checks.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCommand(
    'github.required_checks.ensure',
    () => ensureGithubRequiredChecksWithGitHubApp(req.body || {}),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}