import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createGithubPullRequestRoleAware } from 'lib/github-branch-role-runtime.js';

export const access = 'admin';

export default {
  name: 'github_pull_request_create',
  description: 'Create one same-repository pull request through the Overcenter GitHub App at exact base/head SHAs. Explicit draft intent is required. For repositories with branch roles, the base must be the development branch dev; production cannot be targeted by an ordinary pull request. Existing exact PRs are idempotent and uncertain creation is reconciled before retry.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'base', 'head', 'expected_base', 'expected_head', 'title', 'draft'],
    additionalProperties: false,
    properties: {
      repo: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
      base: { type: 'string', minLength: 1, maxLength: 255 },
      head: { type: 'string', minLength: 1, maxLength: 255 },
      expected_base: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
      expected_head: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
      title: { type: 'string', minLength: 1, maxLength: 256 },
      body: { type: 'string', maxLength: 65536 },
      draft: { type: 'boolean' },
      run_id: { type: 'string', minLength: 1, maxLength: 512 },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'github.pull_request.create',
      args || {},
      (input) => createGithubPullRequestRoleAware(input, { db: ctx?.db }),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};
