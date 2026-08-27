import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import {
  createPostgresRepositoryBranchRoleService,
  statusForRepositoryBranchRoleError,
} from 'lib/repository-branch-roles.js';

export const access = 'admin';

export default {
  name: 'portfolio_repository_branch_roles_ensure',
  description: 'Bind one managed repository to development branch dev and to the GitHub branch already authoritative for production runtime materialization. Replays of the same binding are idempotent; changing an existing binding fails closed.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['repository', 'development_branch', 'production_branch', 'production_source_ref'],
    properties: {
      repository: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
      development_branch: { type: 'string', const: 'dev' },
      production_branch: { type: 'string', minLength: 1, maxLength: 255 },
      production_source_ref: { type: 'string', minLength: 1, maxLength: 1024 },
      run_id: { type: 'string', minLength: 1, maxLength: 512 },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'portfolio.repository.branch_roles.ensure',
      args || {},
      (input) => createPostgresRepositoryBranchRoleService({ db: ctx?.db }).ensure(input),
      { statusForFailure: statusForRepositoryBranchRoleError, flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};
