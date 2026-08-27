import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { promoteGithubProductionWithGitHubApp } from 'lib/github-production-promotion-runtime.js';

export const access = 'admin';

export default {
  name: 'github_production_promote',
  description: 'Advance the configured production branch to the exact current dev commit only after a successful exact-revision Hatchable V8 verification run from a dev push. The operation is fast-forward-only, exact-head fenced, idempotent, and creates no Git commit.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['repo', 'candidate_sha', 'observed_development_head', 'observed_production_head', 'verification_run_id', 'idempotency_key'],
    properties: {
      repo: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
      candidate_sha: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
      observed_development_head: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
      observed_production_head: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
      verification_run_id: { type: 'integer', minimum: 1 },
      idempotency_key: { type: 'string', minLength: 1, maxLength: 200 },
      run_id: { type: 'string', minLength: 1, maxLength: 512 },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'github.production.promote',
      args || {},
      (input) => promoteGithubProductionWithGitHubApp(input, { db: ctx?.db }),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};
