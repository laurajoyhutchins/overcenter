import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { migrateGithubDefaultBranchWithGitHubApp } from 'lib/github-default-branch.js';

export const access = 'admin';

export default {
  name: 'github_default_branch_migrate',
  description: 'Migrate one repository default branch from one exact branch name to another without changing source bytes. The source default branch must match expected_head. The target is created at that exact SHA if absent, the repository default is changed only after a second source/default precondition read, and authoritative readback must confirm the new default at the same SHA. The old branch is deliberately retained for separate dependency inspection and deletion.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'from', 'to', 'expected_head'],
    additionalProperties: false,
    properties: {
      repo: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
      from: { type: 'string', minLength: 1, maxLength: 255 },
      to: { type: 'string', minLength: 1, maxLength: 255 },
      expected_head: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
      run_id: { type: 'string', minLength: 1, maxLength: 512 },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'github.default_branch.migrate',
      args || {},
      (input) => migrateGithubDefaultBranchWithGitHubApp(input),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};