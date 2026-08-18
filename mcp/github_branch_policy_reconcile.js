import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { reconcileGithubBranchPolicyWithGitHubApp } from 'lib/github-required-checks.js';

export const access = 'admin';

export default {
  name: 'github_branch_policy_reconcile',
  description: 'Reconcile one repository default branch to Portfolio branch-policy-v1. Uses an exact default-branch head as a concurrency fence, resolves the caller-selected required check identities from that exact head, standardizes squash-only repository merge settings and automatic merged-head deletion, and creates or updates only the recognized Portfolio-owned default-branch ruleset. Rejects classic or unowned overlapping protection and verifies authoritative GitHub readback after mutation.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'expected_head', 'required_checks'],
    additionalProperties: false,
    properties: {
      repo: { type: 'string', minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$', description: 'Repository in owner/repo form.' },
      expected_head: { type: 'string', pattern: '^[0-9a-fA-F]{40}$', description: 'Exact current default-branch head SHA used as the optimistic concurrency fence and check-resolution authority.' },
      required_checks: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 256 }, description: 'Exact GitHub check-run names that this repository requires for integration.' },
      run_id: { type: 'string', minLength: 1, maxLength: 512, description: 'Optional orchestration run token used only for correlation.' },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'github.branch_policy.reconcile',
      args || {},
      (input) => reconcileGithubBranchPolicyWithGitHubApp(input),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};