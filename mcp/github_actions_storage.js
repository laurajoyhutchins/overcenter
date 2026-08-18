import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { githubActionsStorageWithGitHubApp } from 'lib/github-actions-storage.js';

export const access = 'admin';

export default {
  name: 'github_actions_storage',
  description: 'Narrow GitHub Actions storage administration. Inspect one repository artifact inventory, delete only caller-selected exact artifact IDs, or set repository artifact/log retention. Inspection uses Actions read; deletion uses Actions write; retention uses Administration write. This command never bulk-selects artifacts for deletion itself.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'operation'],
    additionalProperties: false,
    properties: {
      repo: { type: 'string', minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$', description: 'Repository in owner/repo form.' },
      operation: { type: 'string', enum: ['inspect', 'delete_artifacts', 'set_retention'], description: 'Exact storage administration operation.' },
      artifact_ids: { type: 'array', minItems: 1, maxItems: 1000, uniqueItems: true, items: { type: 'integer', minimum: 1 }, description: 'Exact GitHub artifact IDs to delete. Required only for delete_artifacts.' },
      days: { type: 'integer', minimum: 1, maximum: 400, description: 'Artifact/log retention days. Required only for set_retention.' },
      run_id: { type: 'string', minLength: 1, maxLength: 512, description: 'Optional orchestration run token used only for correlation.' },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'github.actions_storage',
      args || {},
      (input) => githubActionsStorageWithGitHubApp(input),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};