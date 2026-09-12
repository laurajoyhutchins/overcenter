import { runCommandResponseTests } from 'lib/command-response.test.js';
import { runDeterministicWorkSettlementTests } from 'lib/deterministic-work-settlement.test.js';
import { runExactRevisionVerificationTests } from 'lib/exact-revision-verification.test.js';
// github-actions-storage.test.js runs through native node:test discovery.
// github-auto-merge.test.js executes through native node:test discovery.
// github-repository-metadata.test.js is discovered directly by node:test.
// github-repository-rename.test.js runs through native node:test discovery.
// github-repository-template.test.js runs through native node:test discovery.
// github-milestone.test.js runs through native node:test discovery.
// github-production-promotion.test.js runs through native node:test discovery.
// github-release.test.js runs through native node:test discovery.
import { runGitHubAppAuthRegressionTests } from 'lib/github-app-auth.js';
import { runGithubApplyChangesetTests } from 'lib/github-apply-changeset.test.js';
import { runGithubExecutionAuthorityTests } from 'lib/github-execution-authority.test.js';
// github-execution-authority-lease-ref.test.js runs through native node:test discovery.
import { runGithubLeaseScopedChangesetTests } from 'lib/github-lease-scoped-changeset.test.js';
import { runProjectTransitionGithubWorkspaceTests } from 'lib/project-transition-github-workspace.test.js';
// github-branch-policy.test.js runs through native node:test discovery.
// github-branch-role-runtime.test.js runs through native node:test discovery.
// github-default-branch.test.js executes through native node:test discovery.
// github-delete-branch.test.js is discovered directly by node:test.
import { runGithubIntegrationTests } from 'lib/github-integration.test.js';
// github-pull-request-create.test.js runs through native node:test discovery.
// github-pull-request-ready.test.js runs through native node:test discovery.
// github-required-checks.test.js is discovered directly by node:test.
import { runGithubReviewPacketTests } from 'lib/github-review-packet.test.js';
// github-stack.test.js runs through native node:test discovery.
// linear-archive.test.js is discovered directly by node:test.
// linear-maintenance.test.js is discovered directly by node:test.
import { runOrchestrationAdvanceBoundaryTests } from 'lib/orchestration-advance-boundary.test.js';
import { runOrchestrationAdvanceSingleAuthorityTests } from 'lib/orchestration-advance-single-authority.test.js';
import { runProjectAgentSessionBoundaryTests } from 'lib/project-agent-session-boundary-regression.js';
import { runOrchestrationTests } from 'lib/orchestration.test.js';
// overcenter-metrics-contract.test.js runs through native node:test discovery.
import { runOrchestrationRunTargetRuntimeTests } from 'lib/orchestration-run-target-runtime.test.js';
import { runOrchestrationSemanticJournalResolutionTests } from 'lib/orchestration-semantic-journal-resolution.test.js';
import { runPortfolioReconcileWorkSurfaceTests } from 'lib/portfolio-reconcile-work-surface.test.js';
// preview-snapshot.test.js runs through native node:test discovery.
import { runProductionPromotionOvercenterHostTests } from 'lib/production-promotion-overcenter-host.test.js';
import { runProjectAuthorityResolutionTests } from 'lib/project-authority-resolution.test.js';
import { runProjectAuthoringGithubRuntimeTests } from 'lib/project-authoring-github-runtime.test.js';
import { runProjectAuthoringRecoveryTests } from 'lib/project-authoring-recovery.test.js';
import { runProjectDispatchTests } from 'lib/project-dispatch.test.js';
import { runProjectDynamicReplanTests } from 'lib/project-dynamic-replan.test.js';
import { runProjectGraphAmendmentTests } from 'lib/project-graph-amendment.test.js';
import { runProjectGraphDerivationDiscoveryTests } from 'lib/project-graph-derivation-discovery.test.js';
import { runProjectGraphTests } from 'lib/project-graph.test.js';
import { runProjectHorizonTests } from 'lib/project-horizon.test.js';
import { runProjectInspectOvercenterHostTests } from 'lib/project-inspect-overcenter-host.test.js';
// project-lifecycle-resume.test.js runs through native node:test discovery.
// project-repository-facts.test.js executes through native node:test discovery.
import { runProjectTransitionLeaseTests } from 'lib/project-transition-leases.test.js';
// repository-branch-roles.test.js runs through native node:test discovery.
// repository-disposal.test.js runs through native node:test discovery.
// repository-disposition.test.js runs through native node:test discovery.
import { runScheduledCycleCompletenessTests } from 'lib/scheduled-cycle-completeness.test.js';
// scheduled-execution-context.test.js runs through native node:test discovery.
// skill-execution.test.js runs through native node:test discovery.
import { runSourceSyncRegressionTests } from 'lib/source-sync.test.js';
// work-claim-boundary.test.js runs through native node:test discovery.
import { runWorkLeaseTests } from 'lib/work-leases.test.js';
import { runWorkLifecycleTests } from 'lib/work-lifecycle.test.js';
// work-progress-boundary.test.js runs through native node:test discovery.
// work-settle-boundary.test.js runs through native node:test discovery.
// work-surface-policy.test.js runs through native node:test discovery.
import { runWorkerTransportTests } from 'lib/worker-transport.test.js';

function suite(group, name, source, run) {
  return Object.freeze({ group, name, source, run });
}

export const REGRESSION_SUITES = Object.freeze([
  suite('command_response', 'command_response', 'lib/command-response.test.js', runCommandResponseTests),

  suite('github_integration', 'integration', 'lib/github-integration.test.js', runGithubIntegrationTests),
  suite('github_integration', 'app_auth', 'lib/github-app-auth.js', runGitHubAppAuthRegressionTests),
  // actions_storage migrated to native node:test discovery.
  // auto_merge executes through native node:test discovery.
  // repository_metadata migrated to native node:test discovery.
  // repository_rename migrated to native node:test discovery.
  // repository_template migrated to native node:test discovery.
  // milestone migrated to native node:test discovery.
  // production_promotion migrated to native node:test discovery.
  // release migrated to native node:test discovery.
  suite('github_integration', 'apply_changeset', 'lib/github-apply-changeset.test.js', runGithubApplyChangesetTests),
  suite('github_integration', 'execution_authority', 'lib/github-execution-authority.test.js', runGithubExecutionAuthorityTests),
  // execution_authority_lease_ref migrated to native node:test discovery.
  suite('github_integration', 'lease_scoped_changeset', 'lib/github-lease-scoped-changeset.test.js', runGithubLeaseScopedChangesetTests),
  suite('github_integration', 'project_transition_workspace', 'lib/project-transition-github-workspace.test.js', runProjectTransitionGithubWorkspaceTests),
  // branch_policy migrated to native node:test discovery.
  // branch_role_runtime migrated to native node:test discovery.
  // default_branch executes through native node:test discovery.
  // delete_branch migrated to native node:test discovery.
  // required_checks migrated to native node:test discovery.
  suite('github_integration', 'review_packet', 'lib/github-review-packet.test.js', runGithubReviewPacketTests),
  // stack migrated to native node:test discovery.

  // github_pull_request_create migrated to native node:test discovery.
  // github_pull_request_ready migrated to native node:test discovery.

  suite('orchestration', 'orchestration', 'lib/orchestration.test.js', runOrchestrationTests),
  // overcenter_metrics_contract migrated to native node:test discovery.
  suite('orchestration', 'orchestration_advance_production_path', 'lib/orchestration-advance-boundary.test.js', runOrchestrationAdvanceBoundaryTests),
  suite('orchestration', 'orchestration_advance_single_authority', 'lib/orchestration-advance-single-authority.test.js', runOrchestrationAdvanceSingleAuthorityTests),
  suite('orchestration', 'project_agent_session_boundary', 'lib/project-agent-session-boundary-regression.js', runProjectAgentSessionBoundaryTests),
  suite('orchestration', 'target_runtime', 'lib/orchestration-run-target-runtime.test.js', runOrchestrationRunTargetRuntimeTests),
  suite('orchestration', 'semantic_journal_resolution', 'lib/orchestration-semantic-journal-resolution.test.js', runOrchestrationSemanticJournalResolutionTests),
  suite('orchestration', 'leases', 'lib/work-leases.test.js', runWorkLeaseTests),
  // work_claim_boundary migrated to native node:test discovery.
  // work_progress_boundary migrated to native node:test discovery.
  // work_settle_boundary migrated to native node:test discovery.
  suite('orchestration', 'work_lifecycle', 'lib/work-lifecycle.test.js', runWorkLifecycleTests),
  suite('orchestration', 'exact_revision_verification', 'lib/exact-revision-verification.test.js', runExactRevisionVerificationTests),
  suite('orchestration', 'production_promotion_runtime_host', 'lib/production-promotion-overcenter-host.test.js', runProductionPromotionOvercenterHostTests),
  suite('orchestration', 'project_authority_resolution', 'lib/project-authority-resolution.test.js', runProjectAuthorityResolutionTests),
  suite('orchestration', 'project_authoring_github_runtime', 'lib/project-authoring-github-runtime.test.js', runProjectAuthoringGithubRuntimeTests),
  suite('orchestration', 'project_authoring_recovery', 'lib/project-authoring-recovery.test.js', runProjectAuthoringRecoveryTests),
  suite('orchestration', 'project_graph', 'lib/project-graph.test.js', runProjectGraphTests),
  suite('orchestration', 'project_horizon', 'lib/project-horizon.test.js', runProjectHorizonTests),
  suite('orchestration', 'project_inspect_runtime_host', 'lib/project-inspect-overcenter-host.test.js', runProjectInspectOvercenterHostTests),
  suite('orchestration', 'project_graph_derivation_discovery', 'lib/project-graph-derivation-discovery.test.js', runProjectGraphDerivationDiscoveryTests),
  // project_repository_facts executes through native node:test discovery.
  suite('orchestration', 'project_transition_leases', 'lib/project-transition-leases.test.js', runProjectTransitionLeaseTests),
  suite('orchestration', 'project_graph_amendment', 'lib/project-graph-amendment.test.js', runProjectGraphAmendmentTests),
  suite('orchestration', 'project_dispatch_isolated_contract', 'lib/project-dispatch.test.js', runProjectDispatchTests),
  suite('orchestration', 'project_dynamic_replan_isolated_contract', 'lib/project-dynamic-replan.test.js', runProjectDynamicReplanTests),
  // project_lifecycle_resume_isolated_contract migrated to native node:test discovery.
  suite('orchestration', 'worker_transport', 'lib/worker-transport.test.js', runWorkerTransportTests),
  suite('orchestration', 'portfolio_reconcile', 'lib/portfolio-reconcile-work-surface.test.js', runPortfolioReconcileWorkSurfaceTests),
  // work_surface_policy migrated to native node:test discovery.
  suite('orchestration', 'deterministic_work_settlement', 'lib/deterministic-work-settlement.test.js', runDeterministicWorkSettlementTests),
  // linear_archive migrated to native node:test discovery.
  // linear_maintenance migrated to native node:test discovery.
  suite('orchestration', 'scheduled_cycle_completeness', 'lib/scheduled-cycle-completeness.test.js', runScheduledCycleCompletenessTests),
  // scheduled_execution_context migrated to native node:test discovery.
  // repository_branch_roles migrated to native node:test discovery.
  // repository_disposition migrated to native node:test discovery.
  // repository_disposal migrated to native node:test discovery.
  // skill_execution migrated to native node:test discovery.
  // preview_snapshot migrated to native node:test discovery.

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