import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { ensureGithubAutoMergeWithGitHubApp } from 'lib/github-auto-merge.js';

export const access = 'admin';

export default {
  name: 'github_auto_merge_ensure',
  description: 'Ensure one repository has GitHub auto-merge enabled or disabled. This is desired-state assignment, never a toggle: it rereads authoritative repository state, no-ops when already compliant, optionally enforces expected_state as a compare-and-set fence, writes only allow_auto_merge, and verifies GitHub after mutation. This MCP tool exposes github.auto_merge.ensure using an underscore-safe transport name.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'enabled'],
    additionalProperties: false,
    properties: {
      repo: { type: 'string', minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$', description: 'Repository in owner/repo form.' },
      enabled: { type: 'boolean', description: 'Desired repository auto-merge state.' },
      expected_state: { type: 'boolean', description: 'Optional optimistic concurrency fence. Mutation is rejected if GitHub currently reports a different state.' },
      run_id: { type: 'string', minLength: 1, maxLength: 512, description: 'Optional orchestration run token used only for correlation.' },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'github.auto_merge.ensure',
      args || {},
      (input) => ensureGithubAutoMergeWithGitHubApp(input),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};
