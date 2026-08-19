import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createGithubRepository } from 'lib/github-repository-create.js';

export const access = 'admin';

export default {
  name: 'github_repository_create',
  description: 'Create or idempotently resolve one private, uninitialized GitHub repository owned by laurajoyhutchins. The owner, private visibility, and auto_init=false policy are fixed by the command and cannot be caller-supplied. Uses a separately authorized GitHub App user access token; ordinary repository mutations continue to use installation tokens.',
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