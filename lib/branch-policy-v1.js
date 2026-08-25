export const BRANCH_POLICY_VERSION = 'branch-policy-v1';

export const WORK_BRANCH_TYPES = Object.freeze([
  'feat',
  'fix',
  'refactor',
  'test',
  'docs',
  'chore',
  'research',
]);

const TYPE_PATTERN = WORK_BRANCH_TYPES.join('|');
const WORK_BRANCH = new RegExp(`^(?:${TYPE_PATTERN})/[a-z0-9]+(?:-[a-z0-9]+)*$`);

export function isConformingWorkBranch(branch) {
  return typeof branch === 'string' && WORK_BRANCH.test(branch);
}

export function assertConformingNewWorkBranch(branch) {
  if (isConformingWorkBranch(branch)) return branch;
  const error = new Error(
    `New work branches must match <type>/<kebab-description> where type is one of: ${WORK_BRANCH_TYPES.join(', ')}.`,
  );
  error.code = 'INVALID_BRANCH_POLICY';
  error.details = {
    branch,
    policy_version: BRANCH_POLICY_VERSION,
    allowed_types: [...WORK_BRANCH_TYPES],
    expected_shape: '<type>/<kebab-description>',
    legacy_existing_branches_are_grandfathered: true,
  };
  error.httpStatus = 422;
  throw error;
}

// Auto-merge enablement is intentionally not part of this aggregate merge policy.
// github.auto_merge.ensure owns that repository setting independently so branch-policy
// reconciliation cannot silently undo an explicit auto-merge decision.
export const REPOSITORY_MERGE_POLICY = Object.freeze({
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  delete_branch_on_merge: true,
  squash_merge_commit_title: 'PR_TITLE',
  squash_merge_commit_message: 'BLANK',
});

export function desiredDefaultBranchRules(resolvedChecks) {
  return [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    { type: 'required_linear_history' },
    {
      type: 'pull_request',
      parameters: {
        allowed_merge_methods: ['squash'],
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_approving_review_count: 0,
        required_review_thread_resolution: true,
        required_reviewers: [],
      },
    },
    {
      type: 'required_status_checks',
      parameters: {
        do_not_enforce_on_create: false,
        strict_required_status_checks_policy: true,
        required_status_checks: resolvedChecks.map((check) => ({
          context: check.context,
          ...(check.integration_id ? { integration_id: check.integration_id } : {}),
        })),
      },
    },
  ];
}

export const MANAGED_BRANCH_POLICY_RULESET_NAMES = Object.freeze([
  'Portfolio branch policy v1',
  'Exact-head review clearance',
]);

export function managedBranchPolicyRulesetName() {
  return 'Portfolio branch policy v1';
}