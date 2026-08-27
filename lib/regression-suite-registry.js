import { runCommandResponseTests } from 'lib/command-response.test.js';
import { runDeterministicWorkSettlementTests } from 'lib/deterministic-work-settlement.test.js';
import { runExactRevisionVerificationTests } from 'lib/exact-revision-verification.test.js';
import { runGithubActionsStorageTests } from 'lib/github-actions-storage.test.js';
import { runGithubAutoMergeTests } from 'lib/github-auto-merge.test.js';
import { runGithubRepositoryMetadataTests } from 'lib/github-repository-metadata.test.js';
import { runGithubRepositoryTemplateTests } from 'lib/github-repository-template.test.js';
import { runGithubMilestoneTests } from 'lib/github-milestone.test.js';
import { runGithubProductionPromotionTests } from 'lib/github-production-promotion.test.js';
import { runGithubReleaseTests } from 'lib/github-release.test.js';
import { runGitHubAppAuthRegressionTests } from 'lib/github-app-auth.js';
import { runGithubApplyChangesetTests } from 'lib/github-apply-changeset.test.js';
import { runGithubExecutionAuthorityTests } from 'lib/github-execution-authority.test.js';
import { runGithubExecutionAuthorityLeaseRefTests } from 'lib/github-execution-authority-lease-ref.test.js';
import { runGithubBranchPolicyTests } from 'lib/github-branch-policy.test.js';
import { runGithubBranchRoleRuntimeTests } from 'lib/github-branch-role-runtime.test.js';
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
import { runOrchestrationSemanticJournalResolutionTests } from 'lib/orchestration-semantic-journal-resolution.test.js';
import { runPortfolioReconcileWorkSurfaceTests } from 'lib/portfolio-reconcile-work-surface.test.js';
import { runPreviewSnapshotTests } from 'lib/preview-snapshot.test.js';
import { runProjectAuthorityResolutionTests } from 'lib/project-authority-resolution.test.js';
import { runProjectControllerRuntimeTests } from 'lib/project-controller-runtime.test.js';
import { runProjectControllerTests } from 'lib/project-controller.test.js';
import { runProjectDispatchTests } from 'lib/project-dispatch.test.js';
import { runProjectDynamicReplanTests } from 'lib/project-dynamic-replan.test.js';
import { runProjectGraphAmendmentTests } from 'lib/project-graph-amendment.test.js';
import { runProjectGraphDerivationDiscoveryTests } from 'lib/project-graph-derivation-discovery.test.js';
import { runProjectGraphTests } from 'lib/project-graph.test.js';
import { runProjectHorizonTests } from 'lib/project-horizon.test.js';
import { runProjectLifecycleResumeTests } from 'lib/project-lifecycle-resume.test.js';
import { runProjectRepositoryFactsTests } from 'lib/project-repository-facts.test.js';
import { runProjectTransitionLeaseTests } from 'lib/project-transition-leases.test.js';
import { runRepositoryBranchRoleTests } from 'lib/repository-branch-roles.test.js';
import { runRepositoryDisposalTests } from 'lib/repository-disposal.test.js';
import { runRepositoryDispositionTests } from 'lib/repository-disposition.test.js';
import { runScheduledCycleCompletenessTests } from 'lib/scheduled-cycle-completeness.test.js';
import { runScheduledExecutionContextTests } from 'lib/scheduled-execution-context.test.js';
import { runSkillExecutionTests } from 'lib/skill-execution.test.js';
import { runSourceSyncRegressionTests } from 'lib/source-sync.test.js';
import { runWorkClaimBoundaryTests } from 'lib/work-claim-boundary.test.js';
import { runWorkLeaseTests } from 'lib/work-leases.test.js';
import { runWorkLifecycleTests } from 'lib/work-lifecycle.test.js';
import { runWorkProgressBoundaryTests } from 'lib/work-progress-boundary.test.js';
import { runWorkSettleBoundaryTests } from 'lib/work-settle-boundary.test.js';
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
  suite('github_integration', 'repository_metadata', 'lib/github-repository-metadata.test.js', runGithubRepositoryMetadataTests),
  suite('github_integration', 'repository_template', 'lib/github-repository-template.test.js', runGithubRepositoryTemplateTests),
  suite('github_integration', 'milestone', 'lib/github-milestone.test.js', runGithubMilestoneTests),
  suite('github_integration', 'production_promotion', 'lib/github-production-promotion.test.js', runGithubProductionPromotionTests),
  suite('github_integration', 'release', 'lib/github-release.test.js', runGithubReleaseTests),
  suite('github_integration', 'apply_changeset', 'lib/github-apply-changeset.test.js', runGithubApplyChangesetTests),
  suite('github_integration', 'execution_authority', 'lib/github-execution-authority.test.js', runGithubExecutionAuthorityTests),
  suite('github_integration', 'execution_authority_lease_ref', 'lib/github-execution-authority-lease-ref.test.js', runGithubExecutionAuthorityLeaseRefTests),
  suite('github_integration', 'branch_policy', 'lib/github-branch-policy.test.js', runGithubBranchPolicyTests),
  suite('github_integration', 'branch_role_runtime', 'lib/github-branch-role-runtime.test.js', runGithubBranchRoleRuntimeTests),
  suite('github_integration', 'default_branch', 'lib/github-default-branch.test.js', runGithubDefaultBranchTests),
  suite('github_integration', 'delete_branch', 'lib/github-delete-branch.test.js', runGithubDeleteBranchTests),
  suite('github_integration', 'required_checks', 'lib/github-required-checks.test.js', runGithubRequiredChecksTests),
  suite('github_integration', 'review_packet', 'lib/github-review-packet.test.js', runGithubReviewPacketTests),
  suite('github_integration', 'stack', 'lib/github-stack.test.js', runGithubStackTests),

  suite('github_pull_request_create', 'github_pull_request_create', 'lib/github-pull-request-create.test.js', runGithubPullRequestCreateRegressionTests),
  suite('github_pull_request_ready', 'github_pull_request_ready', 'lib/github-pull-request-ready.test.js', runGithubPullRequestReadyTests),

  suite('orchestration', 'orchestration', 'lib/orchestration.test.js', runOrchestrationTests),
  suite('orchestration', 'semantic_journal_resolution', 'lib/orchestration-semantic-journal-resolution.test.js', runOrchestrationSemanticJournalResolutionTests),
  suite('orchestration', 'leases', 'lib/work-leases.test.js', runWorkLeaseTests),
  suite('orchestration', 'work_claim_boundary', 'lib/work-claim-boundary.test.js', runWorkClaimBoundaryTests),
  suite('orchestration', 'work_progress_boundary', 'lib/work-progress-boundary.test.js', runWorkProgressBoundaryTests),
  suite('orchestration', 'work_settle_boundary', 'lib/work-settle-boundary.test.js', runWorkSettleBoundaryTests),
  suite('orchestration', 'work_lifecycle', 'lib/work-lifecycle.test.js', runWorkLifecycleTests),
  suite('orchestration', 'exact_revision_verification', 'lib/exact-revision-verification.test.js', runExactRevisionVerificationTests),
  suite('orchestration', 'project_authority_resolution', 'lib/project-authority-resolution.test.js', runProjectAuthorityResolutionTests),
  suite('orchestration', 'project_graph', 'lib/project-graph.test.js', runProjectGraphTests),
  suite('orchestration', 'project_horizon', 'lib/project-horizon.test.js', runProjectHorizonTests),
  suite('orchestration', 'project_graph_derivation_discovery', 'lib/project-graph-derivation-discovery.test.js', runProjectGraphDerivationDiscoveryTests),
  suite('orchestration', 'project_repository_facts', 'lib/project-repository-facts.test.js', runProjectRepositoryFactsTests),
  suite('orchestration', 'project_transition_leases', 'lib/project-transition-leases.test.js', runProjectTransitionLeaseTests),
  suite('orchestration', 'project_graph_amendment', 'lib/project-graph-amendment.test.js', runProjectGraphAmendmentTests),
  suite('orchestration', 'project_controller', 'lib/project-controller.test.js', runProjectControllerTests),
  suite('orchestration', 'project_controller_runtime', 'lib/project-controller-runtime.test.js', runProjectControllerRuntimeTests),
  suite('orchestration', 'project_dispatch', 'lib/project-dispatch.test.js', runProjectDispatchTests),
  suite('orchestration', 'project_dynamic_replan', 'lib/project-dynamic-replan.test.js', runProjectDynamicReplanTests),
  suite('orchestration', 'project_lifecycle_resume', 'lib/project-lifecycle-resume.test.js', runProjectLifecycleResumeTests),
  suite('orchestration', 'worker_transport', 'lib/worker-transport.test.js', runWorkerTransportTests),
  suite('orchestration', 'portfolio_reconcile', 'lib/portfolio-reconcile-work-surface.test.js', runPortfolioReconcileWorkSurfaceTests),
  suite('orchestration', 'work_surface_policy', 'lib/work-surface-policy.test.js', runWorkSurfacePolicyTests),
  suite('orchestration', 'deterministic_work_settlement', 'lib/deterministic-work-settlement.test.js', runDeterministicWorkSettlementTests),
  suite('orchestration', 'linear_archive', 'lib/linear-archive.test.js', runLinearArchiveTests),
  suite('orchestration', 'linear_maintenance', 'lib/linear-maintenance.test.js', runLinearMaintenanceTests),
  suite('orchestration', 'scheduled_cycle_completeness', 'lib/scheduled-cycle-completeness.test.js', runScheduledCycleCompletenessTests),
  suite('orchestration', 'scheduled_execution_context', 'lib/scheduled-execution-context.test.js', runScheduledExecutionContextTests),
  suite('orchestration', 'repository_branch_roles', 'lib/repository-branch-roles.test.js', runRepositoryBranchRoleTests),
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
