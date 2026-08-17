import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { reviewGithubPullRequestWithGitHubApp } from 'lib/github-review-packet.js';

export const access = 'admin';

export default {
  name: 'github_review_packet',
  description: 'Inspect one GitHub pull request as a compact exact-head-bound structural review/integration packet. Returns PR identity, mergeability, normalized review/check state, conservatively evaluated protection metadata, changed paths, and a deterministic snapshot digest without hydrating GitHub prose. This is the Hatchable-safe tool name for conceptual github.review_packet.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'pull_request'],
    additionalProperties: false,
    properties: {
      repo: { type: 'string', minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$', description: 'Repository in exact owner/repo form. URLs are not accepted.' },
      pull_request: { type: 'integer', minimum: 1, description: 'Positive GitHub pull request number.' },
      expected_head: { type: 'string', pattern: '^[0-9a-fA-F]{40}$', description: 'Optional read-time optimistic precondition for the PR current head SHA.' },
      run_id: { type: 'string', minLength: 1, maxLength: 512, description: 'Optional orchestration run token used only for correlation.' },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'github.review_packet',
      args || {},
      (input) => reviewGithubPullRequestWithGitHubApp(input),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};