import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { ensureGithubRepositoryMetadataWithGitHubApp } from 'lib/github-repository-metadata.js';

export const access = 'admin';

const metadataStateSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    description: { type: ['string', 'null'], maxLength: 350 },
    homepage: { type: ['string', 'null'], maxLength: 2048 },
    topics: {
      type: 'array',
      maxItems: 20,
      items: { type: 'string', minLength: 1, maxLength: 50, pattern: '^[A-Za-z0-9][A-Za-z0-9-]{0,49}$' },
    },
    has_issues: { type: 'boolean' },
    has_projects: { type: 'boolean' },
    has_wiki: { type: 'boolean' },
    has_discussions: { type: 'boolean' },
  },
};

export default {
  name: 'github_repository_metadata_ensure',
  description: 'Ensure ordinary GitHub repository metadata converges to a declared desired state. Supports description, homepage, topics, and selected non-destructive feature toggles only; identity, visibility, default-branch, transfer, and archive semantics are intentionally excluded. The command observes authoritative state, optionally enforces expected_state, writes only changed fields, and verifies after mutation.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'desired_state'],
    additionalProperties: false,
    properties: {
      repo: { type: 'string', minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
      desired_state: metadataStateSchema,
      expected_state: metadataStateSchema,
      run_id: { type: 'string', minLength: 1, maxLength: 512, description: 'Optional orchestration run id used only for correlation and journaling.' },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'github.repository_metadata.ensure',
      args || {},
      (input) => ensureGithubRepositoryMetadataWithGitHubApp(input),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};