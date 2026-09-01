import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { markGithubPullRequestReadyWithGitHubApp } from 'lib/github-pull-request-ready.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

export const access = 'admin';

const descriptor = semanticCommandDescriptor('github.pull_request.mark_ready');

export default {
  name: descriptor.mcp_name,
  description: descriptor.description,
  inputSchema: descriptor.input_schema,
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'github.pull_request.mark_ready',
      args || {},
      (input) => markGithubPullRequestReadyWithGitHubApp(input),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};