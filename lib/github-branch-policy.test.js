import {
  BRANCH_POLICY_VERSION,
  REPOSITORY_MERGE_POLICY,
  WORK_BRANCH_TYPES,
  desiredDefaultBranchRules,
  isConformingWorkBranch,
} from 'lib/branch-policy-v1.js';
import { normalizeGithubBranchPolicyRequest } from 'lib/github-required-checks.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function runGithubBranchPolicyTests() {
  const results = [];
  async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: String(error?.message || error) }); }
  }

  await test('branch vocabulary is exactly the approved semantic set', async () => {
    assert(JSON.stringify(WORK_BRANCH_TYPES) === JSON.stringify(['feat','fix','refactor','test','docs','chore','research']), 'branch types drifted');
    assert(BRANCH_POLICY_VERSION === 'branch-policy-v1', 'policy version drifted');
  });

  await test('new work branch grammar accepts semantic kebab names only', async () => {
    for (const branch of ['feat/add-stack-support', 'fix/check-race', 'docs/branch-policy-v1', 'research/source-audit-2']) {
      assert(isConformingWorkBranch(branch), `expected conforming branch: ${branch}`);
    }
    for (const branch of ['agent/foo', 'ff/bar', 'feature/foo', 'integration/foo', 'feat/LJH-123', 'feat/UpperCase', 'feat/two_words', 'main']) {
      assert(!isConformingWorkBranch(branch), `unexpected conforming branch: ${branch}`);
    }
  });

  await test('repository merge policy is squash-only and cleans merged heads', async () => {
    assert(REPOSITORY_MERGE_POLICY.allow_squash_merge === true, 'squash disabled');
    assert(REPOSITORY_MERGE_POLICY.allow_merge_commit === false, 'merge commits enabled');
    assert(REPOSITORY_MERGE_POLICY.allow_rebase_merge === false, 'rebase merges enabled');
    assert(REPOSITORY_MERGE_POLICY.delete_branch_on_merge === true, 'merged heads not deleted');
    assert(!Object.prototype.hasOwnProperty.call(REPOSITORY_MERGE_POLICY, 'allow_auto_merge'), 'aggregate branch policy still owns auto-merge enablement');
    assert(REPOSITORY_MERGE_POLICY.squash_merge_commit_title === 'PR_TITLE', 'squash title drifted');
    assert(REPOSITORY_MERGE_POLICY.squash_merge_commit_message === 'BLANK', 'squash message drifted');
  });

  await test('default branch rules are strict, PR-only, linear, and no-force/no-delete', async () => {
    const rules = desiredDefaultBranchRules([{ context: 'verify', integration_id: 15368 }]);
    const types = rules.map((rule) => rule.type).sort();
    assert(JSON.stringify(types) === JSON.stringify(['deletion','non_fast_forward','pull_request','required_linear_history','required_status_checks'].sort()), 'wrong rule types');
    const pr = rules.find((rule) => rule.type === 'pull_request');
    assert(JSON.stringify(pr.parameters.allowed_merge_methods) === JSON.stringify(['squash']), 'PR merge method drifted');
    assert(pr.parameters.required_approving_review_count === 0, 'human approval count drifted');
    assert(pr.parameters.required_review_thread_resolution === true, 'thread resolution disabled');
    const checks = rules.find((rule) => rule.type === 'required_status_checks');
    assert(checks.parameters.strict_required_status_checks_policy === true, 'required checks not strict');
  });

  await test('branch policy request is exact and head-bound', async () => {
    const normalized = normalizeGithubBranchPolicyRequest({
      repo: 'laurajoyhutchins/example',
      expected_head: 'a'.repeat(40),
      required_checks: ['verify'],
    });
    assert(normalized.expected_head === 'a'.repeat(40), 'head changed');
    assert(normalized.required_checks[0] === 'verify', 'check changed');
  });

  return { ok: results.every((result) => result.ok), passed: results.filter((result) => result.ok).length, total: results.length, results };
}