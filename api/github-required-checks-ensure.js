import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { ensureGithubRequiredChecksWithGitHubApp } from 'lib/github-required-checks.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.required_checks.ensure',
    req.body || {},
    (input) => ensureGithubRequiredChecksWithGitHubApp(input),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}