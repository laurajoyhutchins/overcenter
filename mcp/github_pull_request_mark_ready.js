import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { GITHUB_PULL_REQUEST_READY_INPUT_SCHEMA } from 'lib/github-pull-request-ready-contract.js';
import { markGithubPullRequestReadyWithGitHubApp } from 'lib/github-pull-request-ready.js';

export const access = 'admin';

export default {
  name: 'github_pull_request_mark_ready',
  description: 'Mark an exact-head draft pull request ready for review through the Overcenter GitHub App. The command fails closed if GitHub does not authorize the installation actor for this PR, never retries a mutation blindly, and authoritatively rereads state after uncertain mutation transport.',
  inputSchema: GITHUB_PULL_REQUEST_READY_INPUT_SCHEMA,
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