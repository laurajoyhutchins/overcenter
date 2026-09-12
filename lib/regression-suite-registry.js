import { runCommandResponseTests } from 'lib/command-response.test.js';
// deterministic-work-settlement.test.js runs through native node:test discovery.
// exact-revision-verification.test.js runs through native node:test discovery.
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
// github-execution-authority.test.js runs through native node:test discovery.
// github-execution-authority-lease-ref.test.js runs through native node:test discovery.
// github-lease-scoped-changeset.test.js runs through native node:test discovery.
// project-transition-github-workspace.test.js runs through native node:test discovery.
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
// orchestration-advance-boundary.test.js runs through native node:test discovery.
// orchestration-advance-single-authority.test.js runs through native node:test discovery.
import { runProjectAgentSessionBoundaryTests } from 'lib/project-agent-session-boundary-regression.js';
import { runOrchestrationTests } from 'lib/orchestration.test.js';
// overcenter-metrics-contract.test.js runs through native node:test discovery.
// orchestration-run-target-runtime.test.js runs through native node:test discovery.
// orchestration-semantic-journal-resolution.test.js runs through native node:test discovery.
import { runPortfolioReconcileWorkSurfaceTests } from 'lib/portfolio-reconcile-work-surface.test.js';
// preview-snapshot.test.js runs through native node:test discovery.
// production-promotion-overcenter-host.test.js runs through native node:test discovery.
// project-authority-resolution.test.js runs through native node:test discovery.
import { runProjectAuthoringGithubRuntimeTests } from 'lib/project-authoring-github-runtime.test.js';
// project-authoring-recovery.test.js runs through native node:test discovery.
// project-dispatch.test.js runs through native node:test discovery.
// project-dynamic-replan.test.js runs through native node:test discovery.
// project-graph-amendment.test.js runs through native node:test discovery.
// project-graph-derivation-discovery.test.js runs through native node:test discovery.
import { runProjectGraphTests } from 'lib/project-graph.test.js';
// project-horizon.test.js runs through native node:test discovery.
// project-inspect-overcenter-host.test.js runs through native node:test discovery.
// project-lifecycle-resume.test.js runs through native node:test discovery.
// project-repository-facts.test.js executes through native node:test discovery.
// project-transition-leases.test.js runs through native node:test discovery.
// repository-branch-roles.test.js runs through native node:test discovery.
// repository-disposal.test.js runs through native node:test discovery.
// repository-disposition.test.js runs through native node:test discovery.
import { runScheduledCycleCompletenessTests } from 'lib/scheduled-cycle-completeness.test.js';
// scheduled-execution-context.test.js runs through native node:test discovery.
// skill-execution.test.js runs through native node:test discovery.
// source-sync.test.js runs through native node:test discovery.
// work-claim-boundary.test.js runs through native node:test discovery.
// work-leases.test.js runs through native node:test discovery.
// work-lifecycle.test.js runs through native node:test discovery.
// work-progress-boundary.test.js runs through native node:test discovery.
// work-settle-boundary.test.js runs through native node:test discovery.
// work-surface-policy.test.js runs through native node:test discovery.
// worker-transport.test.js runs through native node:test discovery.

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
  // execution_authority migrated to native node:test discovery.
  // execution_authority_lease_ref migrated to native node:test discovery.
  // lease_scoped_changeset migrated to native node:test discovery.
  // project_transition_workspace migrated to native node:test discovery.
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
  // orchestration_advance_production_path migrated to native node:test discovery.
  // orchestration_advance_single_authority migrated to native node:test discovery.
  suite('orchestration', 'project_agent_session_boundary', 'lib/project-agent-session-boundary-regression.js', runProjectAgentSessionBoundaryTests),
  // target_runtime migrated to native node:test discovery.
  // semantic_journal_resolution migrated to native node:test discovery.
  // leases migrated to native node:test discovery.
  // work_claim_boundary migrated to native node:test discovery.
  // work_progress_boundary migrated to native node:test discovery.
  // work_settle_boundary migrated to native node:test discovery.
  // work_lifecycle migrated to native node:test discovery.
  // exact_revision_verification migrated to native node:test discovery.
  // production_promotion_runtime_host migrated to native node:test discovery.
  // project_authority_resolution migrated to native node:test discovery.
  suite('orchestration', 'project_authoring_github_runtime', 'lib/project-authoring-github-runtime.test.js', runProjectAuthoringGithubRuntimeTests),
  // project_authoring_recovery migrated to native node:test discovery.
  suite('orchestration', 'project_graph', 'lib/project-graph.test.js', runProjectGraphTests),
  // project_horizon migrated to native node:test discovery.
  // project_inspect_runtime_host migrated to native node:test discovery.
  // project_graph_derivation_discovery migrated to native node:test discovery.
  // project_repository_facts executes through native node:test discovery.
  // project_transition_leases migrated to native node:test discovery.
  // project_graph_amendment migrated to native node:test discovery.
  // project_dispatch_isolated_contract migrated to native node:test discovery.
  // project_dynamic_replan_isolated_contract migrated to native node:test discovery.
  // project_lifecycle_resume_isolated_contract migrated to native node:test discovery.
  // worker_transport migrated to native node:test discovery.
  suite('orchestration', 'portfolio_reconcile', 'lib/portfolio-reconcile-work-surface.test.js', runPortfolioReconcileWorkSurfaceTests),
  // work_surface_policy migrated to native node:test discovery.
  // deterministic_work_settlement migrated to native node:test discovery.
  // linear_archive migrated to native node:test discovery.
  // linear_maintenance migrated to native node:test discovery.
  suite('orchestration', 'scheduled_cycle_completeness', 'lib/scheduled-cycle-completeness.test.js', runScheduledCycleCompletenessTests),
  // scheduled_execution_context migrated to native node:test discovery.
  // repository_branch_roles migrated to native node:test discovery.
  // repository_disposition migrated to native node:test discovery.
  // repository_disposal migrated to native node:test discovery.
  // skill_execution migrated to native node:test discovery.
  // preview_snapshot migrated to native node:test discovery.

  // source_sync migrated to native node:test discovery.
]);

export const REGRESSION_GROUP_ORDER = Object.freeze([
  'command_response',
  'github_integration',
  'github_pull_request_create',
  'github_pull_request_ready',
  'orchestration',
  'source_sync',
]);