import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createGithubRepositoryFromTemplateWithGitHubApp } from 'lib/github-repository-template.js';

export const access = 'admin';

export default {
  name: 'github_repository_from_template_create',
  description: 'Create exactly one GitHub repository from an existing GitHub template repository. Requires explicit destination identity and visibility, generates only the default branch, reconciles ambiguous outcomes against GitHub authority, and fails closed on pre-existing mismatches.',
  inputSchema: {
    type: 'object',
    required: ['template_repo', 'destination_repo', 'private'],
    additionalProperties: false,
    properties: {
      template_repo: { type: 'string', minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
      destination_repo: { type: 'string', minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
      description: { type: ['string', 'null'], maxLength: 350 },
      private: { type: 'boolean', description: 'Explicit visibility choice for the created repository.' },
      idempotency_key: { type: 'string', minLength: 1, maxLength: 200, description: 'Optional exact retry key. Reuse only for the identical semantic request.' },
      run_id: { type: 'string', minLength: 1, maxLength: 512, description: 'Optional orchestration run id used only for correlation and journaling.' },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'github.repository_from_template.create',
      args || {},
      (input) => createGithubRepositoryFromTemplateWithGitHubApp(input),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};
