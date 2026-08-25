import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { archiveGithubRepositoryWithGitHubApp } from 'lib/github-archive-repository.js';

export const access = 'admin';

export default {
  name: 'github_archive_repository',
  description: 'Archive one GitHub repository only after verifying its immutable GitHub repository id and expected unarchived state. The mutation sets only archived=true, rereads GitHub to confirm the terminal state, returns already_archived idempotently, and exposes the conceptual github.archive_repository command using an underscore-safe transport name.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'expected_repository_id', 'expected_archived'],
    additionalProperties: false,
    properties: {
      repo: { type: 'string', minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$', description: 'Repository in owner/repo form.' },
      expected_repository_id: { type: 'integer', minimum: 1, description: 'Immutable GitHub repository id observed before authorizing archival.' },
      expected_archived: { const: false, description: 'Required optimistic state fence. This command only authorizes the false to true archive transition.' },
      run_id: { type: 'string', minLength: 1, maxLength: 512, description: 'Optional orchestration run token used only for correlation.' },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'github.archive_repository',
      args || {},
      (input) => archiveGithubRepositoryWithGitHubApp(input),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};
