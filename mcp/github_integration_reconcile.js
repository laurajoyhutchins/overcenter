import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { reconcileGithubIntegrationWithGitHubApp } from 'lib/github-integration.js';

export const access = 'admin';

export default {
  name: 'github_integration_reconcile',
  description: 'Inspect, advance, or reconcile deterministic GitHub PR integration. Exact-head fencing is mandatory. Standalone PRs that are behind may be merge-updated with GitHub expected_head_sha and must be rechecked before merge. Stacked PRs are never merge-updated; stale stacks return a cascading-rebase requirement. Ready standalone PRs and ready stacks use GitHub asynchronous squash merge with direct_merge, preserving branch rules and atomic stack semantics. Poll an existing asynchronous merge with merge_request_uuid.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'pull_request', 'expected_head'],
    additionalProperties: false,
    properties: {
      repo: { type: 'string', minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$', description: 'Repository in owner/repo form.' },
      pull_request: { type: 'integer', minimum: 1, description: 'Pull request number to inspect or integrate.' },
      expected_head: { type: 'string', pattern: '^[0-9a-fA-F]{40}$', description: 'Exact current pull request head SHA. Any movement invalidates the request.' },
      apply: { type: 'boolean', default: false, description: 'False performs a read-only readiness inspection. True may update a stale standalone PR or submit an exact-head asynchronous merge.' },
      merge_request_uuid: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9-]+$', description: 'Optional GitHub asynchronous merge request UUID to poll. Polling is read-only.' },
      run_id: { type: 'string', minLength: 1, maxLength: 512, description: 'Optional orchestration run token used only for correlation.' },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'github.integration.reconcile',
      args || {},
      (input) => reconcileGithubIntegrationWithGitHubApp(input, { db: ctx?.db }),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};