import { runCommandResponseTests } from 'lib/command-response.test.js';
import { runDeterministicWorkSettlementTests } from 'lib/deterministic-work-settlement.test.js';
import { runGithubActionsStorageTests } from 'lib/github-actions-storage.test.js';
import { runGithubAutoMergeTests } from 'lib/github-auto-merge.test.js';
import { runGitHubAppAuthRegressionTests } from 'lib/github-app-auth.js';
import { runGithubApplyChangesetTests } from 'lib/github-apply-changeset.test.js';
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
import { runPreviewSnapshotTests } from 'lib/preview-snapshot.test.js';
import { runRepositoryDisposalTests } from 'lib/repository-disposal.test.js';
import { runRepositoryDispositionTests } from 'lib/repository-disposition.test.js';
import { runScheduledCycleCompletenessTests } from 'lib/scheduled-cycle-completeness.test.js';
import { runScheduledExecutionContextTests } from 'lib/scheduled-execution-context.test.js';
import { runSkillExecutionTests } from 'lib/skill-execution.test.js';
import { runSourceSyncRegressionTests } from 'lib/source-sync.test.js';
import { runWorkLeaseTests } from 'lib/work-leases.test.js';
import { runWorkLifecycleTests } from 'lib/work-lifecycle.test.js';
import { runWorkSurfacePolicyTests } from 'lib/work-surface-policy.test.js';
import { runWorkerTransportTests } from 'lib/worker-transport.test.js';

function suite(group, name, source, run) {
  return Object.freeze({ group, name, source, run });
}

export const REGRESSION_SUITES = Object.freeze([
  suite('command_response', 'command_response', 'lib/command-response.test.js', runCommandResponseTests),

  suite('github_integration', 'integration', 'lib/github-integration.test.js', runGithubIntegrationTests),
  suite('github_integration', 'app_auth', 'lib/github-app-auth.js', runGitHubAppAuthRegressionTests),
  suite('github_integration', 'actions_storage', 'lib/github-actions-storage.test.js', runGithubActionsStorageTests),
  suite('github_integration', 'auto_merge', 'lib/github-auto-merge.test.js', runGithubAutoMergeTests),
  suite('github_integration', 'apply_changeset', 'lib/github-apply-changeset.test.js', runGithubApplyChangesetTests),
  suite('github_integration', 'branch_policy', 'lib/github-branch-policy.test.js', runGithubBranchPolicyTests),
  suite('github_integration', 'default_branch', 'lib/github-default-branch.test.js', runGithubDefaultBranchTests),
  suite('github_integration', 'delete_branch', 'lib/github-delete-branch.test.js', runGithubDeleteBranchTests),
  suite('github_integration', 'required_checks', 'lib/github-required-checks.test.js', runGithubRequiredChecksTests),
  suite('github_integration', 'review_packet', 'lib/github-review-packet.test.js', runGithubReviewPacketTests),
  suite('github_integration', 'stack', 'lib/github-stack.test.js', runGithubStackTests),

  suite('github_pull_request_create', 'github_pull_request_create', 'lib/github-pull-request-create.test.js', runGithubPullRequestCreateRegressionTests),
  suite('github_pull_request_ready', 'github_pull_request_ready', 'lib/github-pull-request-ready.test.js', runGithubPullRequestReadyTests),

  suite('orchestration', 'orchestration', 'lib/orchestration.test.js', runOrchestrationTests),
  suite('orchestration', 'leases', 'lib/work-leases.test.js', runWorkLeaseTests),
  suite('orchestration', 'work_lifecycle', 'lib/work-lifecycle.test.js', runWorkLifecycleTests),
  suite('orchestration', 'worker_transport', 'lib/worker-transport.test.js', runWorkerTransportTests),
  suite('orchestration', 'portfolio_reconcile', 'lib/portfolio-reconcile-work-surface.test.js', runPortfolioReconcileWorkSurfaceTests),
  suite('orchestration', 'work_surface_policy', 'lib/work-surface-policy.test.js', runWorkSurfacePolicyTests),
  suite('orchestration', 'deterministic_work_settlement', 'lib/deterministic-work-settlement.test.js', runDeterministicWorkSettlementTests),
  suite('orchestration', 'linear_archive', 'lib/linear-archive.test.js', runLinearArchiveTests),
  suite('orchestration', 'linear_maintenance', 'lib/linear-maintenance.test.js', runLinearMaintenanceTests),
  suite('orchestration', 'scheduled_cycle_completeness', 'lib/scheduled-cycle-completeness.test.js', runScheduledCycleCompletenessTests),
  suite('orchestration', 'scheduled_execution_context', 'lib/scheduled-execution-context.test.js', runScheduledExecutionContextTests),
  suite('orchestration', 'repository_disposition', 'lib/repository-disposition.test.js', runRepositoryDispositionTests),
  suite('orchestration', 'repository_disposal', 'lib/repository-disposal.test.js', runRepositoryDisposalTests),
  suite('orchestration', 'skill_execution', 'lib/skill-execution.test.js', runSkillExecutionTests),
  suite('orchestration', 'preview_snapshot', 'lib/preview-snapshot.test.js', runPreviewSnapshotTests),

  suite('source_sync', 'source_sync', 'lib/source-sync.test.js', runSourceSyncRegressionTests),
]);

export const REGRESSION_GROUP_ORDER = Object.freeze([
  'command_response',
  'github_integration',
  'github_pull_request_create',
  'github_pull_request_ready',
  'orchestration',
  'source_sync',
]);
