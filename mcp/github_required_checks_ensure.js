import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { ensureGithubRequiredChecksWithGitHubApp } from 'lib/github-required-checks.js';

export const access = 'admin';

export default {
  name: 'github_required_checks_ensure',
  description: 'Ensure exact selected GitHub verification checks are required for one repository branch. Resolves check identities from an exact caller-approved branch head, preserves unrelated requirements, uses the repository effective rules/protection state as authority, rereads before and after mutation, and succeeds only after GitHub shows enforcement active. This is the Hatchable-safe tool name for github.required_checks.ensure.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'branch', 'expected_head', 'required_checks'],
    additionalProperties: false,
    properties: {
      repo: { type: 'string', minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$', description: 'Repository in owner/repo form.' },
      branch: { type: 'string', minLength: 1, maxLength: 255, description: 'Unqualified branch name under refs/heads/.' },
      expected_head: { type: 'string', pattern: '^[0-9a-fA-F]{40}$', description: 'Exact branch-head SHA used as the optimistic concurrency fence and check-resolution authority.' },
      required_checks: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 256 }, description: 'Exact GitHub check-run names to ensure as branch integration requirements. Additive semantics only.' },
      run_id: { type: 'string', minLength: 1, maxLength: 512, description: 'Optional orchestration run token used only for correlation.' },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'github.required_checks.ensure',
      args || {},
      (input) => ensureGithubRequiredChecksWithGitHubApp(input),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};