import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'work.settle',
    req.body || {},
    (input) => createPostgresWorkLeaseService().settle(input),
    {
      statusForFailure: statusForWorkLeaseError,
      defaultError: 'WORK_SETTLE_ERROR',
      defaultMessage: 'work.settle failed',
      flattenDetails: true,
    },
  );
  return res.status(response.status).json(response.body);
}