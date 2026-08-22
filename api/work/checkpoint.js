import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';
import { workerBoundaryFailureOptions } from 'lib/worker-boundary-errors.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'work.checkpoint',
    req.body || {},
    (input) => createPostgresWorkLeaseService().checkpoint(input),
    workerBoundaryFailureOptions('work.checkpoint', {
      statusForFailure: statusForWorkLeaseError,
      defaultError: 'WORK_CHECKPOINT_ERROR',
      defaultMessage: 'work.checkpoint failed',
      flattenDetails: true,
    }),
  );
  return res.status(response.status).json(response.body);
}