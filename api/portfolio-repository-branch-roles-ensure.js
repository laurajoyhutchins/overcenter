import { db } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import {
  createPostgresRepositoryBranchRoleService,
  statusForRepositoryBranchRoleError,
} from 'lib/repository-branch-roles.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'portfolio.repository.branch_roles.ensure',
    req.body || {},
    (input) => createPostgresRepositoryBranchRoleService({ db }).ensure(input),
    { statusForFailure: statusForRepositoryBranchRoleError, flattenDetails: true, db },
  );
  return res.status(response.status).json(response.body);
}
