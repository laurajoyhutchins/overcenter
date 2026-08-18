import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { reconcileGithubStackWithGitHubApp } from 'lib/github-stack.js';

export const access = 'admin';

export default {
  name: 'github_stack_reconcile',
  description: 'Create or verify one native GitHub pull request stack from an exact ordered list of PRs. The list is bottom-to-top. Every PR head is fenced by a full expected SHA, every layer must target the branch below it, fork-based layers and closed-unmerged PRs are rejected, and conflicting or partial existing stack membership fails closed. Existing exact stacks are idempotent; this command does not destructively restructure a live stack.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'pull_requests'],
    additionalProperties: false,
    properties: {
      repo: { type: 'string', minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$', description: 'Repository in owner/repo form.' },
      pull_requests: {
        type: 'array', minItems: 2, maxItems: 20,
        items: {
          type: 'object', additionalProperties: false, required: ['number', 'expected_head'],
          properties: {
            number: { type: 'integer', minimum: 1 },
            expected_head: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
          },
        },
        description: 'Ordered bottom-to-top PR layers with exact current head SHAs.',
      },
      run_id: { type: 'string', minLength: 1, maxLength: 512, description: 'Optional orchestration run token used only for correlation.' },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'github.stack.reconcile',
      args || {},
      (input) => reconcileGithubStackWithGitHubApp(input),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};