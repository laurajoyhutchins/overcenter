import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { reconcileGithubBranchPolicyWithGitHubApp } from 'lib/github-required-checks.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.branch_policy.reconcile',
    req.body || {},
    (input) => reconcileGithubBranchPolicyWithGitHubApp(input),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}