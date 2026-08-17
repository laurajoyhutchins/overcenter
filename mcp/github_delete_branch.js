import { executeCommand } from 'lib/command-response.js';
import { deleteGithubBranchWithGitHubApp } from 'lib/github-delete-branch.js';

export const access = 'admin';

export default {
  name: 'github_delete_branch',
  description: 'Delete one GitHub branch only if it still points to the caller-approved full commit SHA. Uses GitHub updateRefs with beforeOid and a zero afterOid for an atomic compare-and-swap deletion. Returns already_absent idempotently and never accepts tags or arbitrary refs. This is the Hatchable-safe tool name for the conceptual github.delete_branch command.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'branch', 'expected_head'],
    additionalProperties: false,
    properties: {
      repo: {
        type: 'string',
        minLength: 3,
        maxLength: 256,
        pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$',
        description: 'Repository in owner/repo form.',
      },
      branch: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        description: 'Unqualified branch name under refs/heads/. Tags and refs/... values are rejected.',
      },
      expected_head: {
        type: 'string',
        pattern: '^[0-9a-fA-F]{40}$',
        description: 'Required optimistic concurrency fence. Deletion is authorized only if the branch still points to this exact full commit SHA.',
      },
    },
  },
  async handler(args) {
    const response = await executeCommand(
      'github.delete_branch',
      () => deleteGithubBranchWithGitHubApp(args),
      { flattenDetails: true },
    );
    return response.body;
  },
};