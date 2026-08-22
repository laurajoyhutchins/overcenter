import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { disposeRepository, statusForRepositoryDisposalError } from 'lib/repository-disposal.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'portfolio.dispose_repository',
    req.body || {},
    (input) => disposeRepository(input),
    { statusForFailure: statusForRepositoryDisposalError, flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}