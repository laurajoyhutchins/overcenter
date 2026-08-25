import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { markGithubPullRequestReadyWithGitHubApp } from 'lib/github-pull-request-ready.js';

export const access = 'admin';

export default {
  name: 'github_pull_request_mark_ready',
  description: 'Mark an exact-head draft pull request ready for review through the Overcenter GitHub App. The command fails closed if GitHub does not authorize the installation actor for this PR, never retries a mutation blindly, and authoritatively rereads state after uncertain mutation transport.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'pull_request', 'expected_head'],
    additionalProperties: false,
    properties: {
      repo: { type: 'string', minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$', description: 'Repository in owner/repo form.' },
      pull_request: { type: 'integer', minimum: 1, description: 'Open pull request number.' },
      expected_head: { type: 'string', pattern: '^[0-9a-fA-F]{40}$', description: 'Exact current pull request head SHA. Any movement invalidates the request.' },
      run_id: { type: 'string', minLength: 1, maxLength: 512, description: 'Optional orchestration run id used only for correlation.' },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'github.pull_request.mark_ready',
      args || {},
      (input) => markGithubPullRequestReadyWithGitHubApp(input),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};