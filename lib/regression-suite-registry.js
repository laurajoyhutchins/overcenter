import { runCommandResponseTests } from 'lib/command-response.test.js';
import { runDeterministicWorkSettlementTests } from 'lib/deterministic-work-settlement.test.js';
import { runGithubActionsStorageTests } from 'lib/github-actions-storage.test.js';
import { runGithubApplyChangesetTests } from 'lib/github-apply-changeset.test.js';
import { runGitHubAppAuthRegressionTests } from 'lib/github-app-auth.js';
import { runGithubBranchPolicyTests } from 'lib/github-branch-policy.test.js';
import { runGithubDefaultBranchTests } from 'lib/github-default-branch.test.js';
import { runGithubDeleteBranchTests } from 'lib/github-delete-branch.test.js';
import { runGithubIntegrationTests } from 'lib/github-integration.test.js';
import { runGithubPullRequestCreateRegressionTests } from 'lib/github-pull-request-create.test.js';
import { runGithubPullRequestReadyTests } from 'lib/github-pull-request-ready.test.js';
import { runGithubRequiredChecksTests } from 'lib/github-required-checks.test.js';
import { runGithubReviewPacketTests } from 'lib/github-review-packet.test.js';
import { runGithubStackTests } from 'lib/github-stack.test.js';
import { runLinearArchiveTests } from 'lib/linear-archive.test.js';
import { runLinearMaintenanceTests } from 'lib/linear-maintenance.test.js';
import { runOrchestrationTests } from 'lib/orchestration.test.js';
import { runPortfolioReconcileWorkSurfaceTests } from 'lib/portfolio-reconcile-work-surface.test.js';
import { runRepositoryDisposalTests } from 'lib/repository-disposal.test.js';
import { runRepositoryDispositionTests } from 'lib/repository-disposition.test.js';
import { runScheduledCycleCompletenessTests } from 'lib/scheduled-cycle-completeness.test.js';
import { runScheduledExecutionContextTests } from 'lib/scheduled-execution-context.test.js';
import { runSourceSyncRegressionTests } from 'lib/source-sync.test.js';
import { runWorkerTransportTests } from 'lib/worker-transport.test.js';
import { runWorkLeaseTests } from 'lib/work-leases.test.js';
import { runWorkSurfacePolicyTests } from 'lib/work-surface-policy.test.js';

export const REGRESSION_SUITE_REGISTRY = Object.freeze([
  { id: 'command_response', group: 'command_response', key: 'command_response', source: 'lib/command-response.test.js', direct: true, run: runCommandResponseTests },
  { id: 'github_integration', group: 'github_integration', key: 'integration', source: 'lib/github-integration.test.js', run: runGithubIntegrationTests },
  { id: 'github_app_auth', group: 'github_integration', key: 'app_auth', source: 'lib/github-app-auth.js', run: runGitHubAppAuthRegressionTests },
  { id: 'github_pull_request_create', group: 'github_pull_request_create', key: 'github_pull_request_create', source: 'lib/github-pull-request-create.test.js', direct: true, run: runGithubPullRequestCreateRegressionTests },
  { id: 'github_pull_request_ready', group: 'github_pull_request_ready', key: 'github_pull_request_ready', source: 'lib/github-pull-request-ready.test.js', direct: true, run: runGithubPullRequestReadyTests },
  { id: 'orchestration', group: 'orchestration', key: 'orchestration', source: 'lib/orchestration.test.js', run: runOrchestrationTests },
  { id: 'work_leases', group: 'orchestration', key: 'leases', source: 'lib/work-leases.test.js', run: runWorkLeaseTests },
  { id: 'worker_transport', group: 'orchestration', key: 'worker_transport', source: 'lib/worker-transport.test.js', run: runWorkerTransportTests },
  { id: 'portfolio_reconcile', group: 'orchestration', key: 'portfolio_reconcile', source: 'lib/portfolio-reconcile-work-surface.test.js', run: runPortfolioReconcileWorkSurfaceTests },
  { id: 'work_surface_policy', group: 'orchestration', key: 'work_surface_policy', source: 'lib/work-surface-policy.test.js', run: runWorkSurfacePolicyTests },
  { id: 'deterministic_work_settlement', group: 'orchestration', key: 'deterministic_work_settlement', source: 'lib/deterministic-work-settlement.test.js', run: runDeterministicWorkSettlementTests },
  { id: 'linear_archive', group: 'orchestration', key: 'linear_archive', source: 'lib/linear-archive.test.js', run: runLinearArchiveTests },
  { id: 'linear_maintenance', group: 'orchestration', key: 'linear_maintenance', source: 'lib/linear-maintenance.test.js', run: runLinearMaintenanceTests },
  { id: 'scheduled_cycle_completeness', group: 'orchestration', key: 'scheduled_cycle_completeness', source: 'lib/scheduled-cycle-completeness.test.js', run: runScheduledCycleCompletenessTests },
  { id: 'scheduled_execution_context', group: 'orchestration', key: 'scheduled_execution_context', source: 'lib/scheduled-execution-context.test.js', run: runScheduledExecutionContextTests },
  { id: 'repository_disposition', group: 'orchestration', key: 'repository_disposition', source: 'lib/repository-disposition.test.js', run: runRepositoryDispositionTests },
  { id: 'repository_disposal', group: 'orchestration', key: 'repository_disposal', source: 'lib/repository-disposal.test.js', run: runRepositoryDisposalTests },
  { id: 'source_sync', group: 'source_sync', key: 'source_sync', source: 'lib/source-sync.test.js', direct: true, run: runSourceSyncRegressionTests },
  { id: 'github_actions_storage', group: 'github_operations', key: 'actions_storage', source: 'lib/github-actions-storage.test.js', run: runGithubActionsStorageTests },
  { id: 'github_apply_changeset', group: 'github_operations', key: 'apply_changeset', source: 'lib/github-apply-changeset.test.js', run: runGithubApplyChangesetTests },
  { id: 'github_branch_policy', group: 'github_operations', key: 'branch_policy', source: 'lib/github-branch-policy.test.js', run: runGithubBranchPolicyTests },
  { id: 'github_default_branch', group: 'github_operations', key: 'default_branch', source: 'lib/github-default-branch.test.js', run: runGithubDefaultBranchTests },
  { id: 'github_delete_branch', group: 'github_operations', key: 'delete_branch', source: 'lib/github-delete-branch.test.js', run: runGithubDeleteBranchTests },
  { id: 'github_required_checks', group: 'github_operations', key: 'required_checks', source: 'lib/github-required-checks.test.js', run: runGithubRequiredChecksTests },
  { id: 'github_review_packet', group: 'github_operations', key: 'review_packet', source: 'lib/github-review-packet.test.js', run: runGithubReviewPacketTests },
  { id: 'github_stack', group: 'github_operations', key: 'stack', source: 'lib/github-stack.test.js', run: runGithubStackTests },
]);
