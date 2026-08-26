import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { githubActionsStorageInputSchema, githubActionsStorageWithGitHubApp } from 'lib/github-actions-storage.js';

export const access = 'admin';

export default {
  name: 'github_actions_storage',
  description: 'Narrow GitHub Actions storage administration. Inspect repository artifacts and dependency caches, delete only caller-selected exact artifact or cache IDs, or set repository artifact/log retention. Inspection uses Actions read; deletion uses Actions write; retention uses Administration write. This command never bulk-selects deletion candidates itself.',
  inputSchema: githubActionsStorageInputSchema,
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