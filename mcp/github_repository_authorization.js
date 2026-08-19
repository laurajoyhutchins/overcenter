import { completeGitHubRepositoryAuthorization, githubRepositoryAuthorizationStatus, startGitHubRepositoryAuthorization } from 'lib/github-user-auth.js';

export const access = 'admin';

export default {
  name: 'github_repository_authorization',
  description: 'Manage the one-time GitHub user authorization used only for private repository creation. start returns a GitHub device code and verification URI; after the owner authorizes it, complete stores the resulting expiring user token and refresh token encrypted at rest. status never exposes token material.',
  inputSchema: {
    type: 'object',
    required: ['action'],
    additionalProperties: false,
    properties: { action: { type: 'string', enum: ['start', 'complete', 'status'] } },
  },
  async handler(args) {
    if (args?.action === 'start') return startGitHubRepositoryAuthorization();
    if (args?.action === 'complete') return completeGitHubRepositoryAuthorization();
    return githubRepositoryAuthorizationStatus();
  },
};