import { db } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { reconcileGithubIntegrationRoleAware } from 'lib/github-branch-role-runtime.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.integration.reconcile',
    req.body || {},
    (input) => reconcileGithubIntegrationRoleAware(input, { db }),
    { flattenDetails: true, db },
  );
  return res.status(response.status).json(response.body);
}
