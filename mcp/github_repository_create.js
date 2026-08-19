import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createGithubRepository } from 'lib/github-repository-create.js';

export const access = 'admin';

export default {
  name: 'github_repository_create',
  description: 'Request creation of one private, uninitialized GitHub repository owned by laurajoyhutchins. Every exact repository request requires separate manual owner approval on the human-only Hatchable approval page before this command can mutate GitHub. The owner, private visibility, and auto_init=false policy are fixed and cannot be caller-supplied. Approval expires and is consumed after successful creation.',
  inputSchema: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9._-]+$' },
      description: { type: 'string', maxLength: 350 },
      run_id: { type: 'string', minLength: 1, maxLength: 512 },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand('github.repository.create', args || {}, (input) => createGithubRepository(input), { flattenDetails: true, db: ctx?.db });
    return response.body;
  },
};