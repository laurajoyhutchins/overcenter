import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { ensureGithubRepositoryTemplateWithGitHubApp } from 'lib/github-repository-template.js';

export const access = 'admin';

const stateSchema = {
  type: 'object',
  required: ['is_template'],
  additionalProperties: false,
  properties: {
    is_template: { type: 'boolean' },
  },
};

export default {
  name: 'github_repository_template_ensure',
  description: 'Ensure whether an existing GitHub repository is marked as a template. Observes GitHub-authoritative state, optionally enforces expected_state, mutates only is_template, and verifies after mutation.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'desired_state'],
    additionalProperties: false,
    properties: {
      repo: { type: 'string', minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
      desired_state: stateSchema,
      expected_state: stateSchema,
      run_id: { type: 'string', minLength: 1, maxLength: 512, description: 'Optional orchestration run id used only for correlation and journaling.' },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'github.repository_template.ensure',
      args || {},
      (input) => ensureGithubRepositoryTemplateWithGitHubApp(input),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};
