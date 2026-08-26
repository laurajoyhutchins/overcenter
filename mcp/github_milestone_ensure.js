import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { ensureGithubMilestoneWithGitHubApp } from 'lib/github-milestone.js';

export const access = 'admin';

const milestoneStateSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 256 },
    description: { type: ['string', 'null'], maxLength: 10000 },
    state: { type: 'string', enum: ['open', 'closed'] },
    due_on: { type: ['string', 'null'], format: 'date-time' },
  },
};

export default {
  name: 'github_milestone_ensure',
  description: 'Ensure one GitHub repository milestone exists in a declared state. The milestone title is stable identity; rename is intentionally unsupported. The command observes exact-title matches, fails closed on ambiguity or stale expected state, mutates only changed fields, and verifies after mutation.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'desired_state'],
    additionalProperties: false,
    properties: {
      repo: { type: 'string', minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
      desired_state: {
        ...milestoneStateSchema,
        required: ['title'],
      },
      expected_state: milestoneStateSchema,
      run_id: { type: 'string', minLength: 1, maxLength: 512, description: 'Optional orchestration run id used only for correlation and journaling.' },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'github.milestone.ensure',
      args || {},
      (input) => ensureGithubMilestoneWithGitHubApp(input),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};
