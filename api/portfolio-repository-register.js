import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresRepositoryLifecycleService, statusForRepositoryDispositionError } from 'lib/repository-disposition.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'portfolio.repository_register',
    req.body || {},
    (input) => createPostgresRepositoryLifecycleService().register(input),
    { statusForFailure: statusForRepositoryDispositionError, flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}