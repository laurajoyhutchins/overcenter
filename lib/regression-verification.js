import { runCommandResponseTests } from 'lib/command-response.test.js';
import { runGithubIntegrationTests } from 'lib/github-integration.test.js';
import { runGitHubAppAuthRegressionTests } from 'lib/github-app-auth.js';
import { runGithubPullRequestCreateRegressionTests } from 'lib/github-pull-request-create.test.js';
import { runGithubPullRequestReadyTests } from 'lib/github-pull-request-ready.test.js';
import { runOrchestrationTests } from 'lib/orchestration.test.js';
import { runWorkLeaseTests } from 'lib/work-leases.test.js';
import { runWorkerTransportTests } from 'lib/worker-transport.test.js';
import { runPortfolioReconcileWorkSurfaceTests } from 'lib/portfolio-reconcile-work-surface.test.js';
import { runLinearArchiveTests } from 'lib/linear-archive.test.js';
import { runLinearMaintenanceTests } from 'lib/linear-maintenance.test.js';
import { runScheduledCycleCompletenessTests } from 'lib/scheduled-cycle-completeness.test.js';
import { runRepositoryDispositionTests } from 'lib/repository-disposition.test.js';
import { runRepositoryDisposalTests } from 'lib/repository-disposal.test.js';
import { runSourceSyncRegressionTests } from 'lib/source-sync.test.js';

function count(result, field) {
  return Number(result?.[field] || 0);
}

async function runGithubIntegrationVerification() {
  const [integration, appAuth] = await Promise.all([
    runGithubIntegrationTests(),
    runGitHubAppAuthRegressionTests(),
  ]);
  return {
    ok: Boolean(integration.ok && appAuth.ok),
    passed: count(integration, 'passed') + count(appAuth, 'passed'),
    failed: count(integration, 'failed') + count(appAuth, 'failed'),
    total: (integration.results || []).length + (appAuth.results || []).length,
    suites: { integration, app_auth: appAuth },
  };
}

async function runOrchestrationVerification() {
  const [orchestration, leases, workerTransport, portfolioReconcile, linearArchive, linearMaintenance, scheduledCycleCompleteness, repositoryDisposition, repositoryDisposal] = await Promise.all([
    runOrchestrationTests(),
    runWorkLeaseTests(),
    runWorkerTransportTests(),
    runPortfolioReconcileWorkSurfaceTests(),
    runLinearArchiveTests(),
    runLinearMaintenanceTests(),
    runScheduledCycleCompletenessTests(),
    runRepositoryDispositionTests(),
    runRepositoryDisposalTests(),
  ]);
  const suites = {
    orchestration,
    leases,
    worker_transport: workerTransport,
    portfolio_reconcile: portfolioReconcile,
    linear_archive: linearArchive,
    linear_maintenance: linearMaintenance,
    scheduled_cycle_completeness: scheduledCycleCompleteness,
    repository_disposition: repositoryDisposition,
    repository_disposal: repositoryDisposal,
  };
  const values = Object.values(suites);
  return {
    ok: values.every((suite) => suite?.ok === true),
    suites,
    passed: values.reduce((sum, suite) => sum + count(suite, 'passed'), 0),
    failed: values.reduce((sum, suite) => sum + count(suite, 'failed'), 0),
  };
}

export async function runRegressionVerification() {
  const [commandResponse, githubIntegration, githubPullRequestCreate, githubPullRequestReady, orchestration, sourceSync] = await Promise.all([
    runCommandResponseTests(),
    runGithubIntegrationVerification(),
    runGithubPullRequestCreateRegressionTests(),
    runGithubPullRequestReadyTests(),
    runOrchestrationVerification(),
    runSourceSyncRegressionTests(),
  ]);

  const suites = {
    command_response: commandResponse,
    github_integration: githubIntegration,
    github_pull_request_create: githubPullRequestCreate,
    github_pull_request_ready: githubPullRequestReady,
    orchestration,
    source_sync: sourceSync,
  };
  const values = Object.values(suites);
  return {
    ok: values.every((suite) => suite?.ok === true),
    schema: 'regression-verification-v1',
    suites,
    passed: values.reduce((sum, suite) => sum + count(suite, 'passed'), 0),
    failed: values.reduce((sum, suite) => sum + count(suite, 'failed'), 0),
    suite_count: values.length,
  };
}