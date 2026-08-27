import { db } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { reconcileGithubProductionBranchPolicyWithGitHubApp } from 'lib/github-production-branch-policy-runtime.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.production_branch_policy.reconcile',
    req.body || {},
    (input) => reconcileGithubProductionBranchPolicyWithGitHubApp(input, { db }),
    { flattenDetails:true, db },
  );
  return res.status(response.status).json(response.body);
}
