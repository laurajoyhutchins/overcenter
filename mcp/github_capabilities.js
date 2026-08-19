import { inspectGitHubAppCapabilities } from 'lib/github-app-auth.js';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';

export const access = 'admin';

export default {
  name: 'github_capabilities',
  description: 'Read the installed GitHub App permission capability matrix for one repository. Reports fixed command-owned permission profiles and whether each can currently mint an installation token, plus the centrally governed fallback class. This tool is read-only and never performs a repository mutation.',
  inputSchema: {
    type: 'object',
    required: ['repo'],
    additionalProperties: false,
    properties: {
      repo: { type: 'string', minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$', description: 'Repository in owner/repo form.' },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'github.capabilities',
      args || {},
      (input) => inspectGitHubAppCapabilities(input.repo),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};