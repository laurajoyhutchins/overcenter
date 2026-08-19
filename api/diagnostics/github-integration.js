import { runGithubIntegrationTests } from 'lib/github-integration.test.js';
import { runGitHubAppAuthRegressionTests } from 'lib/github-app-auth.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (_req, res) {
  const integration = await runGithubIntegrationTests();
  const appAuth = await runGitHubAppAuthRegressionTests();
  const result = {
    ok: integration.ok && appAuth.ok,
    passed: Number(integration.passed || 0) + Number(appAuth.passed || 0),
    failed: Number(integration.failed || 0) + Number(appAuth.failed || 0),
    total: (integration.results || []).length + (appAuth.results || []).length,
    suites: { integration, app_auth: appAuth },
  };
  return res.status(result.ok ? 200 : 500).json(result);
}