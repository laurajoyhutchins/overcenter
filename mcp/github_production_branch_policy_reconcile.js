import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { reconcileGithubProductionBranchPolicyWithGitHubApp } from 'lib/github-production-branch-policy-runtime.js';

export const access = 'admin';

export default {
  name: 'github_production_branch_policy_reconcile',
  description: 'Ensure the configured production branch has explicit no-delete, no-force-push, and linear-history rules independent of GitHub default-branch policy. Exact production head is required.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['repo','expected_head'],
    properties: {
      repo: { type:'string', pattern:'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
      expected_head: { type:'string', pattern:'^[0-9a-fA-F]{40}$' },
      run_id: { type:'string', minLength:1, maxLength:512 },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'github.production_branch_policy.reconcile',
      args || {},
      (input) => reconcileGithubProductionBranchPolicyWithGitHubApp(input, { db:ctx?.db }),
      { flattenDetails:true, db:ctx?.db },
    );
    return response.body;
  },
};
