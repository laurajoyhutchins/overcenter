import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { reconcileGithubIntegrationRoleAware } from 'lib/github-branch-role-runtime.js';
import { composeHatchableRuntimeProviders } from 'lib/hatchable-runtime-providers.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const providers = composeHatchableRuntimeProviders();
  const { db } = providers;
  const response = await executeCorrelatedCommand(
    'github.integration.reconcile',
    req.body || {},
    (input) => reconcileGithubIntegrationRoleAware(input, { db, withGitHubAppApiClient:providers.githubAppAuth.withApiClient }),
    { flattenDetails: true, db },
  );
  return res.status(response.status).json(response.body);
}
